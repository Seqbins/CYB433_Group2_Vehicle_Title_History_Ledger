// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title VehicleHistory
/// @notice CYB433 Group 2 - Vehicle Title & History Ledger.
///         Records vehicle registration, mileage, maintenance, accidents, ownership and status.
/// @dev Final version after the security audit and gas optimisation. Same functions and events
///      as the group's original contract, plus four hardening rules:
///        1. Odometer plausibility: a reading may grow by at most maxKmPerDay per elapsed day.
///        2. Conflict of interest: an inspector / service center cannot write history for a car it owns.
///        3. Two-step admin handover so a compromised or lost admin key can be rotated safely.
///        4. Custom errors carry the offending values (e.g. OdometerRollback(old, new)).
///      Privacy: the VIN is stored only as keccak256(VIN); reports live off-chain (IPFS) and only
///      their hash is stored; owners are pseudonymous addresses, never names or national IDs.
contract VehicleHistory {
    // ==================== Roles ====================

    address public admin;
    address public pendingAdmin;

    mapping(address => bool) public inspectors;
    mapping(address => bool) public serviceCenters;

    /// @notice Maximum plausible distance driven per day (set once at deployment).
    uint256 public immutable maxKmPerDay;

    // ==================== States ====================

    enum VehicleStatus {
        Active,
        Suspended,
        Scrapped
    }

    enum Severity {
        Minor,
        Moderate,
        Major
    }

    // ==================== Entities (packed) ====================

    /// @dev 3 slots (original: 5). Everything a mileage update reads or writes is in slot 0.
    struct Vehicle {
        address owner; //            slot 0: 20 bytes
        uint32 mileage; //                   4 bytes (max 4.29 billion km)
        uint32 lastMileageAt; //             4 bytes (unix time, valid until 2106)
        VehicleStatus status; //             1 byte
        bool exists; //                      1 byte
        bytes32 vinHash; //          slot 1
        uint256 id; //               slot 2
    }

    /// @dev 2 slots (original: 4).
    struct Accident {
        uint64 date;
        Severity severity;
        address inspector;
        bytes32 reportHash;
    }

    /// @dev 2 slots (original: 4).
    struct Maintenance {
        uint64 date;
        uint32 mileage;
        address serviceCenter;
        bytes32 reportHash;
    }

    /// @dev 2 slots (original: 3).
    struct OwnershipTransfer {
        address previousOwner;
        uint64 date;
        address newOwner;
    }

    // ==================== Storage ====================

    uint256 public vehicleCount;

    mapping(uint256 => Vehicle) public vehicles;

    mapping(bytes32 => bool) public registeredVINs;

    mapping(uint256 => Accident[]) private accidents;

    mapping(uint256 => Maintenance[]) private maintenanceRecords;

    mapping(uint256 => OwnershipTransfer[]) private transfers;

    // ==================== Events ====================

    event InspectorUpdated(address indexed account, bool authorized);
    event ServiceCenterUpdated(address indexed account, bool authorized);
    event VehicleRegistered(uint256 indexed id, address indexed owner);
    event MileageUpdated(uint256 indexed id, uint256 oldMileage, uint256 newMileage);
    event AccidentRecorded(uint256 indexed id, Severity severity, bytes32 reportHash);
    event MaintenanceRecorded(uint256 indexed id, uint256 mileage, bytes32 reportHash);
    event OwnershipTransferred(uint256 indexed id, address previousOwner, address newOwner);
    event StatusUpdated(uint256 indexed id, VehicleStatus status);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ==================== Errors ====================

    error InvalidLimit();
    error NotAdmin();
    error NotPendingAdmin();
    error NotInspector();
    error NotServiceCenter();
    error NotAuthorized();
    error VehicleNotFound(uint256 id);
    error NotVehicleOwner();
    error VehicleNotActive(uint256 id, VehicleStatus status);
    error InvalidAddress();
    error InvalidOwner();
    error InvalidNewOwner();
    error InvalidVinHash();
    error VinAlreadyRegistered();
    error OdometerRollback(uint256 oldMileage, uint256 newMileage);
    error ImplausibleMileage(uint256 oldMileage, uint256 newMileage, uint256 maxAllowed);
    error InvalidReportHash();
    error VehicleScrapped();
    error AlreadyVehicleOwner();
    error ScrappedVehicleCannotBeRestored();
    error StatusUnchanged();
    error ConflictOfInterest();

    // ==================== Constructor ====================

    constructor(uint256 maxKmPerDay_) {
        if (maxKmPerDay_ == 0) revert InvalidLimit();
        maxKmPerDay = maxKmPerDay_;
        admin = msg.sender;
    }

    // ==================== Modifiers ====================
    // Each modifier calls an internal function: the check is compiled once, not inlined
    // at every use, which keeps the bytecode (and deployment cost) smaller.

    modifier onlyAdmin() {
        _checkAdmin();
        _;
    }

    modifier onlyInspector() {
        _checkInspector();
        _;
    }

    modifier onlyServiceCenter() {
        _checkServiceCenter();
        _;
    }

    modifier vehicleExists(uint256 id) {
        _checkExists(id);
        _;
    }

    modifier onlyVehicleOwner(uint256 id) {
        if (vehicles[id].owner != msg.sender) revert NotVehicleOwner();
        _;
    }

    modifier onlyActiveVehicle(uint256 id) {
        _checkActive(id);
        _;
    }

    /// @dev Writers may not write history for a vehicle they own.
    modifier notOwnVehicle(uint256 id) {
        if (vehicles[id].owner == msg.sender) revert ConflictOfInterest();
        _;
    }

    // ==================== Admin & Role Management ====================

    /// @notice Step 1 of 2: the current admin nominates a successor.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(msg.sender, newAdmin);
    }

    /// @notice Step 2 of 2: the nominee accepts, proving it controls the new key.
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address previous = admin;
        admin = msg.sender;
        delete pendingAdmin;
        emit AdminTransferred(previous, msg.sender);
    }

    function setInspector(address account, bool authorized) external onlyAdmin {
        if (account == address(0)) revert InvalidAddress();
        inspectors[account] = authorized;
        emit InspectorUpdated(account, authorized);
    }

    function setServiceCenter(address account, bool authorized) external onlyAdmin {
        if (account == address(0)) revert InvalidAddress();
        serviceCenters[account] = authorized;
        emit ServiceCenterUpdated(account, authorized);
    }

    // ==================== Vehicle Registration ====================

    function registerVehicle(bytes32 vinHash, address owner, uint32 mileage) external onlyInspector {
        if (owner == address(0)) revert InvalidOwner();
        if (vinHash == bytes32(0)) revert InvalidVinHash();
        if (registeredVINs[vinHash]) revert VinAlreadyRegistered();

        uint256 id;
        unchecked {
            id = ++vehicleCount; // cannot overflow a uint256
        }

        vehicles[id] = Vehicle({
            owner: owner,
            mileage: mileage,
            lastMileageAt: uint32(block.timestamp),
            status: VehicleStatus.Active,
            exists: true,
            vinHash: vinHash,
            id: id
        });

        registeredVINs[vinHash] = true;

        emit VehicleRegistered(id, owner);
    }

    // ==================== Mileage ====================

    function updateMileage(uint256 id, uint32 newMileage)
        external
        vehicleExists(id)
        onlyActiveVehicle(id)
    {
        if (!inspectors[msg.sender] && !serviceCenters[msg.sender]) revert NotAuthorized();
        if (vehicles[id].owner == msg.sender) revert ConflictOfInterest();
        _updateMileage(vehicles[id], id, newMileage);
    }

    /// @dev Core anti-rollback rule. Reads and writes one storage slot.
    function _updateMileage(Vehicle storage v, uint256 id, uint32 newMileage) internal {
        uint32 oldMileage = v.mileage;
        if (newMileage < oldMileage) revert OdometerRollback(oldMileage, newMileage);

        uint256 allowed = ((block.timestamp - v.lastMileageAt) / 1 days + 1) * maxKmPerDay;
        if (newMileage - oldMileage > allowed) {
            revert ImplausibleMileage(oldMileage, newMileage, uint256(oldMileage) + allowed);
        }

        v.mileage = newMileage;
        v.lastMileageAt = uint32(block.timestamp);

        emit MileageUpdated(id, oldMileage, newMileage);
    }

    // ==================== Accident History ====================

    function recordAccident(uint256 id, Severity severity, bytes32 reportHash)
        external
        onlyInspector
        vehicleExists(id)
        notOwnVehicle(id)
    {
        if (reportHash == bytes32(0)) revert InvalidReportHash();

        accidents[id].push(
            Accident({date: uint64(block.timestamp), severity: severity, inspector: msg.sender, reportHash: reportHash})
        );

        emit AccidentRecorded(id, severity, reportHash);

        // A major accident automatically suspends an active vehicle.
        if (severity == Severity.Major) {
            Vehicle storage v = vehicles[id];
            if (v.status == VehicleStatus.Active) {
                v.status = VehicleStatus.Suspended;
                emit StatusUpdated(id, VehicleStatus.Suspended);
            }
        }
    }

    // ==================== Maintenance ====================

    function recordMaintenance(uint256 id, uint32 mileage, bytes32 reportHash)
        external
        onlyServiceCenter
        vehicleExists(id)
    {
        Vehicle storage v = vehicles[id];
        if (v.status == VehicleStatus.Scrapped) revert VehicleScrapped();
        if (reportHash == bytes32(0)) revert InvalidReportHash();
        if (v.owner == msg.sender) revert ConflictOfInterest();

        _updateMileage(v, id, mileage);

        maintenanceRecords[id].push(
            Maintenance({
                date: uint64(block.timestamp),
                mileage: mileage,
                serviceCenter: msg.sender,
                reportHash: reportHash
            })
        );

        emit MaintenanceRecorded(id, mileage, reportHash);
    }

    // ==================== Ownership Transfer ====================

    function transferOwnership(uint256 id, address newOwner)
        external
        vehicleExists(id)
        onlyVehicleOwner(id)
        onlyActiveVehicle(id)
    {
        if (newOwner == address(0)) revert InvalidNewOwner();
        if (newOwner == msg.sender) revert AlreadyVehicleOwner();

        // msg.sender is the owner (checked by onlyVehicleOwner): no extra storage read needed
        vehicles[id].owner = newOwner;

        transfers[id].push(
            OwnershipTransfer({previousOwner: msg.sender, date: uint64(block.timestamp), newOwner: newOwner})
        );

        emit OwnershipTransferred(id, msg.sender, newOwner);
    }

    // ==================== Vehicle Status ====================

    function updateVehicleStatus(uint256 id, VehicleStatus newStatus)
        external
        onlyInspector
        vehicleExists(id)
        notOwnVehicle(id)
    {
        Vehicle storage v = vehicles[id];
        VehicleStatus currentStatus = v.status;

        if (currentStatus == VehicleStatus.Scrapped) revert ScrappedVehicleCannotBeRestored();
        if (currentStatus == newStatus) revert StatusUnchanged();

        v.status = newStatus;

        emit StatusUpdated(id, newStatus);
    }

    // ==================== Public Verification ====================

    function getVehicle(uint256 id) external view vehicleExists(id) returns (Vehicle memory) {
        return vehicles[id];
    }

    function getAccidentHistory(uint256 id) external view vehicleExists(id) returns (Accident[] memory) {
        return accidents[id];
    }

    function getMaintenanceHistory(uint256 id) external view vehicleExists(id) returns (Maintenance[] memory) {
        return maintenanceRecords[id];
    }

    function getOwnershipHistory(uint256 id) external view vehicleExists(id) returns (OwnershipTransfer[] memory) {
        return transfers[id];
    }

    function verifyVIN(bytes32 vinHash) external view returns (bool) {
        return registeredVINs[vinHash];
    }

    // ==================== Internal checks ====================

    function _checkAdmin() internal view {
        if (msg.sender != admin) revert NotAdmin();
    }

    function _checkInspector() internal view {
        if (!inspectors[msg.sender]) revert NotInspector();
    }

    function _checkServiceCenter() internal view {
        if (!serviceCenters[msg.sender]) revert NotServiceCenter();
    }

    function _checkExists(uint256 id) internal view {
        if (!vehicles[id].exists) revert VehicleNotFound(id);
    }

    function _checkActive(uint256 id) internal view {
        VehicleStatus status = vehicles[id].status;
        if (status != VehicleStatus.Active) revert VehicleNotActive(id, status);
    }
}
