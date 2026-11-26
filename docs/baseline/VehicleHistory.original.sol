 // SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract VehicleHistory {

    // ==================== Roles ====================

    address public admin;

    mapping(address => bool) public inspectors;
    mapping(address => bool) public serviceCenters;

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

    // ==================== Entities ====================

    struct Vehicle {
        uint256 id;
        bytes32 vinHash;
        address owner;
        uint256 mileage;
        VehicleStatus status;
        bool exists;
    }

    struct Accident {
        uint256 date;
        Severity severity;
        bytes32 reportHash;
        address inspector;
    }

    struct Maintenance {
        uint256 date;
        uint256 mileage;
        bytes32 reportHash;
        address serviceCenter;
    }

    struct OwnershipTransfer {
        address previousOwner;
        address newOwner;
        uint256 date;
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

    // ==================== Constructor ====================

    constructor() {
        admin = msg.sender;
    }

    // ==================== Modifiers ====================

    modifier onlyAdmin() {
        require(msg.sender == admin, "Access denied: Admin only");
        _;
    }

    modifier onlyInspector() {
        require(inspectors[msg.sender], "Access denied: Inspector only");
        _;
    }

    modifier onlyServiceCenter() {
        require(serviceCenters[msg.sender], "Access denied: Service center only");
        _;
    }

    modifier vehicleExists(uint256 id) {
        require(vehicles[id].exists, "Vehicle does not exist");
        _;
    }

    modifier onlyVehicleOwner(uint256 id) {
        require(vehicles[id].owner == msg.sender, "Not vehicle owner");
        _;
    }

    modifier onlyActiveVehicle(uint256 id) {
        require(
            vehicles[id].status == VehicleStatus.Active,
            "Vehicle is not active"
        );
        _;
    }

    // ==================== Role Management ====================

    function setInspector(
        address account,
        bool authorized
    ) external onlyAdmin {

        require(account != address(0), "Invalid address");

        inspectors[account] = authorized;

        emit InspectorUpdated(account, authorized);
    }

    function setServiceCenter(
        address account,
        bool authorized
    ) external onlyAdmin {

        require(account != address(0), "Invalid address");

        serviceCenters[account] = authorized;

        emit ServiceCenterUpdated(account, authorized);
    }

    // ==================== Vehicle Registration ====================

    function registerVehicle(
        bytes32 vinHash,
        address owner,
        uint256 mileage
    ) external onlyInspector {

        require(owner != address(0), "Invalid owner");

        require(vinHash != bytes32(0), "Invalid VIN hash");

        require(!registeredVINs[vinHash], "VIN already registered");

        vehicleCount++;

        vehicles[vehicleCount] = Vehicle({
            id: vehicleCount,
            vinHash: vinHash,
            owner: owner,
            mileage: mileage,
            status: VehicleStatus.Active,
            exists: true
        });

        registeredVINs[vinHash] = true;

        emit VehicleRegistered(vehicleCount, owner);
    }

    // ==================== Mileage ====================

    function updateMileage(
        uint256 id,
        uint256 newMileage
    ) external vehicleExists(id) onlyActiveVehicle(id) {

        require(
            inspectors[msg.sender] || serviceCenters[msg.sender],
            "Unauthorized mileage update"
        );

        _updateMileage(id, newMileage);
    }

    function _updateMileage(
        uint256 id,
        uint256 newMileage
    ) internal {

        uint256 oldMileage = vehicles[id].mileage;

        require(
            newMileage >= oldMileage,
            "Odometer rollback detected"
        );

        vehicles[id].mileage = newMileage;

        emit MileageUpdated(id, oldMileage, newMileage);
    }

    // ==================== Accident History ====================

    function recordAccident(
        uint256 id,
        Severity severity,
        bytes32 reportHash
    ) external onlyInspector vehicleExists(id) {

        require(reportHash != bytes32(0), "Invalid report hash");

        accidents[id].push(
            Accident({
                date: block.timestamp,
                severity: severity,
                reportHash: reportHash,
                inspector: msg.sender
            })
        );

        emit AccidentRecorded(id, severity, reportHash);

        // A major accident automatically suspends an active vehicle.

        if (
            severity == Severity.Major &&
            vehicles[id].status == VehicleStatus.Active
        ) {
            vehicles[id].status = VehicleStatus.Suspended;

            emit StatusUpdated(id, VehicleStatus.Suspended);
        }
    }

    // ==================== Maintenance ====================

    function recordMaintenance(
        uint256 id,
        uint256 mileage,
        bytes32 reportHash
    ) external onlyServiceCenter vehicleExists(id) {

        require(
            vehicles[id].status != VehicleStatus.Scrapped,
            "Vehicle is scrapped"
        );

        require(reportHash != bytes32(0), "Invalid report hash");

        _updateMileage(id, mileage);

        maintenanceRecords[id].push(
            Maintenance({
                date: block.timestamp,
                mileage: mileage,
                reportHash: reportHash,
                serviceCenter: msg.sender
            })
        );

        emit MaintenanceRecorded(id, mileage, reportHash);
    }

    // ==================== Ownership Transfer ====================

    function transferOwnership(
        uint256 id,
        address newOwner
    ) external
        vehicleExists(id)
        onlyVehicleOwner(id)
        onlyActiveVehicle(id)
    {

        require(newOwner != address(0), "Invalid new owner");

        require(newOwner != msg.sender, "Already vehicle owner");

        address previousOwner = vehicles[id].owner;

        vehicles[id].owner = newOwner;

        transfers[id].push(
            OwnershipTransfer({
                previousOwner: previousOwner,
                newOwner: newOwner,
                date: block.timestamp
            })
        );

        emit OwnershipTransferred(id, previousOwner, newOwner);
    }

    // ==================== Vehicle Status ====================

    function updateVehicleStatus(
        uint256 id,
        VehicleStatus newStatus
    ) external onlyInspector vehicleExists(id) {

        VehicleStatus currentStatus = vehicles[id].status;

        require(
            currentStatus != VehicleStatus.Scrapped,
            "Scrapped vehicle cannot be restored"
        );

        require(currentStatus != newStatus, "Status unchanged");

        vehicles[id].status = newStatus;

        emit StatusUpdated(id, newStatus);
    }

    // ==================== Public Verification ====================

    function getVehicle(
        uint256 id
    ) external view vehicleExists(id) returns (Vehicle memory) {

        return vehicles[id];
    }

    function getAccidentHistory(
        uint256 id
    ) external view vehicleExists(id) returns (Accident[] memory) {

        return accidents[id];
    }

    function getMaintenanceHistory(
        uint256 id
    ) external view vehicleExists(id) returns (Maintenance[] memory) {

        return maintenanceRecords[id];
    }

    function getOwnershipHistory(
        uint256 id
    ) external view vehicleExists(id)
        returns (OwnershipTransfer[] memory)
    {

        return transfers[id];
    }

    function verifyVIN(
        bytes32 vinHash
    ) external view returns (bool) {

        return registeredVINs[vinHash];
    }
}
