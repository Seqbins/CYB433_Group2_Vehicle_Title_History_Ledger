const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// BASELINE (original contract) version of the test suite: require-string reverts.
// Enum mirrors (must match the contract order)
const Status = { Active: 0, Suspended: 1, Scrapped: 2 };
const Sev = { Minor: 0, Moderate: 1, Major: 2 };

const MAX_KM_PER_DAY = 2000;
const DAY = 24 * 60 * 60;

// The VIN never goes on-chain in plain text: only keccak256(VIN) is stored.
const VIN = ethers.id("JTDKB20U793456789");
const VIN2 = ethers.id("1HGCM82633A004352");
// Inspection / service / accident reports live off-chain (e.g. IPFS); only their hash is stored.
const REPORT = ethers.id("ipfs://bafy-report-1");
const REPORT2 = ethers.id("ipfs://bafy-report-2");

async function deployFixture() {
  const [admin, inspector, service, owner, buyer, stranger, newAdmin] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("VehicleHistory");
  // The final version takes maxKmPerDay as a constructor argument; the original takes none.
  const args = Factory.interface.deploy.inputs.length ? [MAX_KM_PER_DAY] : [];
  const vh = await Factory.deploy(...args);
  await vh.setInspector(inspector.address, true);
  await vh.setServiceCenter(service.address, true);
  return { vh, admin, inspector, service, owner, buyer, stranger, newAdmin };
}

// Vehicle #1 registered to `owner` with 10,000 km
async function registeredFixture() {
  const ctx = await deployFixture();
  await ctx.vh.connect(ctx.inspector).registerVehicle(VIN, ctx.owner.address, 10000);
  return ctx;
}

describe("VehicleHistory", function () {
  // ------------------------------------------------------------ roles
  describe("Roles and access control", function () {
    it("sets the deployer as admin", async function () {
      const { vh, admin } = await loadFixture(deployFixture);
      expect(await vh.admin()).to.equal(admin.address);
    });

    it("admin authorises and revokes inspectors and service centers (with events)", async function () {
      const { vh, stranger } = await loadFixture(deployFixture);
      await expect(vh.setInspector(stranger.address, true))
        .to.emit(vh, "InspectorUpdated")
        .withArgs(stranger.address, true);
      expect(await vh.inspectors(stranger.address)).to.equal(true);
      await expect(vh.setServiceCenter(stranger.address, true))
        .to.emit(vh, "ServiceCenterUpdated")
        .withArgs(stranger.address, true);
      await vh.setInspector(stranger.address, false);
      expect(await vh.inspectors(stranger.address)).to.equal(false);
    });

    it("rejects role changes from non-admins", async function () {
      const { vh, stranger } = await loadFixture(deployFixture);
      await expect(vh.connect(stranger).setInspector(stranger.address, true)).to.be.revertedWith("Access denied: Admin only");
      await expect(vh.connect(stranger).setServiceCenter(stranger.address, true)).to.be.revertedWith("Access denied: Admin only");
    });

    it("rejects the zero address as inspector or service center", async function () {
      const { vh } = await loadFixture(deployFixture);
      await expect(vh.setInspector(ethers.ZeroAddress, true)).to.be.revertedWith("Invalid address");
      await expect(vh.setServiceCenter(ethers.ZeroAddress, true)).to.be.revertedWith("Invalid address");
    });
  });

  // ------------------------------------------------------------ registration
  describe("Vehicle registration", function () {
    it("inspector registers a vehicle; anyone can verify the VIN", async function () {
      const { vh, inspector, owner } = await loadFixture(deployFixture);
      await expect(vh.connect(inspector).registerVehicle(VIN, owner.address, 10000))
        .to.emit(vh, "VehicleRegistered")
        .withArgs(1, owner.address);
      expect(await vh.vehicleCount()).to.equal(1);
      const v = await vh.getVehicle(1);
      expect(v.id).to.equal(1);
      expect(v.vinHash).to.equal(VIN);
      expect(v.owner).to.equal(owner.address);
      expect(v.mileage).to.equal(10000);
      expect(v.status).to.equal(Status.Active);
      expect(v.exists).to.equal(true);
      expect(await vh.verifyVIN(VIN)).to.equal(true);
      expect(await vh.verifyVIN(VIN2)).to.equal(false);
    });

    it("rejects registration by non-inspectors (including the admin and service centers)", async function () {
      const { vh, admin, service, owner } = await loadFixture(deployFixture);
      await expect(vh.connect(admin).registerVehicle(VIN, owner.address, 0)).to.be.revertedWith("Access denied: Inspector only");
      await expect(vh.connect(service).registerVehicle(VIN, owner.address, 0)).to.be.revertedWith("Access denied: Inspector only");
    });

    it("rejects a zero owner and an empty VIN hash", async function () {
      const { vh, inspector, owner } = await loadFixture(deployFixture);
      await expect(vh.connect(inspector).registerVehicle(VIN, ethers.ZeroAddress, 0)).to.be.revertedWith("Invalid owner");
      await expect(vh.connect(inspector).registerVehicle(ethers.ZeroHash, owner.address, 0)).to.be.revertedWith("Invalid VIN hash");
    });

    it("rejects a duplicate VIN (prevents cloned titles)", async function () {
      const { vh, inspector, buyer } = await loadFixture(registeredFixture);
      await expect(vh.connect(inspector).registerVehicle(VIN, buyer.address, 0)).to.be.revertedWith("VIN already registered");
    });

    it("assigns sequential ids to vehicles", async function () {
      const { vh, inspector, buyer } = await loadFixture(registeredFixture);
      await vh.connect(inspector).registerVehicle(VIN2, buyer.address, 0);
      expect(await vh.vehicleCount()).to.equal(2);
      expect((await vh.getVehicle(2)).owner).to.equal(buyer.address);
    });
  });

  // ------------------------------------------------------------ mileage
  describe("Mileage and odometer rollback", function () {
    it("inspector and service center can update mileage upward (event has old and new)", async function () {
      const { vh, inspector, service } = await loadFixture(registeredFixture);
      await expect(vh.connect(inspector).updateMileage(1, 10500))
        .to.emit(vh, "MileageUpdated")
        .withArgs(1, 10000, 10500);
      await vh.connect(service).updateMileage(1, 11000);
      expect((await vh.getVehicle(1)).mileage).to.equal(11000);
    });

    it("rejects an odometer rollback", async function () {
      const { vh, inspector } = await loadFixture(registeredFixture);
      await expect(vh.connect(inspector).updateMileage(1, 9999)).to.be.revertedWith("Odometer rollback detected");
      expect((await vh.getVehicle(1)).mileage).to.equal(10000);
    });

    it("accepts the same reading again (car not driven)", async function () {
      const { vh, inspector } = await loadFixture(registeredFixture);
      await expect(vh.connect(inspector).updateMileage(1, 10000)).to.emit(vh, "MileageUpdated").withArgs(1, 10000, 10000);
    });

    it("rejects mileage updates from the owner or unauthorised accounts", async function () {
      const { vh, owner, stranger } = await loadFixture(registeredFixture);
      await expect(vh.connect(owner).updateMileage(1, 10100)).to.be.revertedWith("Unauthorized mileage update");
      await expect(vh.connect(stranger).updateMileage(1, 10100)).to.be.revertedWith("Unauthorized mileage update");
    });

    it("rejects mileage updates on unknown or suspended vehicles", async function () {
      const { vh, inspector } = await loadFixture(registeredFixture);
      await expect(vh.connect(inspector).updateMileage(99, 10100)).to.be.revertedWith("Vehicle does not exist");
      await vh.connect(inspector).updateVehicleStatus(1, Status.Suspended);
      await expect(vh.connect(inspector).updateMileage(1, 10100)).to.be.revertedWith("Vehicle is not active");
    });
  });

  // ------------------------------------------------------------ maintenance
  describe("Maintenance records", function () {
    it("service center records maintenance; mileage and history are updated", async function () {
      const { vh, service } = await loadFixture(registeredFixture);
      await time.increase(30 * DAY);
      await expect(vh.connect(service).recordMaintenance(1, 15000, REPORT))
        .to.emit(vh, "MaintenanceRecorded")
        .withArgs(1, 15000, REPORT)
        .and.to.emit(vh, "MileageUpdated")
        .withArgs(1, 10000, 15000);
      const h = await vh.getMaintenanceHistory(1);
      expect(h.length).to.equal(1);
      expect(h[0].mileage).to.equal(15000);
      expect(h[0].reportHash).to.equal(REPORT);
      expect(h[0].serviceCenter).to.equal(service.address);
      expect(h[0].date).to.equal(await time.latest());
    });

    it("rejects a maintenance record with a lower odometer reading", async function () {
      const { vh, service } = await loadFixture(registeredFixture);
      await expect(vh.connect(service).recordMaintenance(1, 9000, REPORT)).to.be.revertedWith("Odometer rollback detected");
      expect((await vh.getMaintenanceHistory(1)).length).to.equal(0);
    });

    it("rejects maintenance from non-service-centers and with an empty report hash", async function () {
      const { vh, service, inspector } = await loadFixture(registeredFixture);
      await expect(vh.connect(inspector).recordMaintenance(1, 10100, REPORT)).to.be.revertedWith("Access denied: Service center only");
      await expect(vh.connect(service).recordMaintenance(1, 10100, ethers.ZeroHash)).to.be.revertedWith("Invalid report hash");
      await expect(vh.connect(service).recordMaintenance(99, 10100, REPORT)).to.be.revertedWith("Vehicle does not exist");
    });

    it("allows repairs on a suspended vehicle but not on a scrapped one", async function () {
      const { vh, inspector, service } = await loadFixture(registeredFixture);
      await vh.connect(inspector).updateVehicleStatus(1, Status.Suspended);
      await expect(vh.connect(service).recordMaintenance(1, 10100, REPORT)).to.emit(vh, "MaintenanceRecorded");
      await vh.connect(inspector).updateVehicleStatus(1, Status.Scrapped);
      await expect(vh.connect(service).recordMaintenance(1, 10200, REPORT2)).to.be.revertedWith("Vehicle is scrapped");
    });
  });

  // ------------------------------------------------------------ accidents
  describe("Accident history", function () {
    it("records a minor accident without changing the status", async function () {
      const { vh, inspector } = await loadFixture(registeredFixture);
      await expect(vh.connect(inspector).recordAccident(1, Sev.Minor, REPORT))
        .to.emit(vh, "AccidentRecorded")
        .withArgs(1, Sev.Minor, REPORT);
      const a = await vh.getAccidentHistory(1);
      expect(a.length).to.equal(1);
      expect(a[0].severity).to.equal(Sev.Minor);
      expect(a[0].inspector).to.equal(inspector.address);
      expect((await vh.getVehicle(1)).status).to.equal(Status.Active);
    });

    it("a major accident automatically suspends an active vehicle", async function () {
      const { vh, inspector } = await loadFixture(registeredFixture);
      await expect(vh.connect(inspector).recordAccident(1, Sev.Major, REPORT))
        .to.emit(vh, "StatusUpdated")
        .withArgs(1, Status.Suspended);
      expect((await vh.getVehicle(1)).status).to.equal(Status.Suspended);
    });

    it("a second major accident on a suspended vehicle is recorded without a status event", async function () {
      const { vh, inspector } = await loadFixture(registeredFixture);
      await vh.connect(inspector).recordAccident(1, Sev.Major, REPORT);
      await expect(vh.connect(inspector).recordAccident(1, Sev.Major, REPORT2)).to.not.emit(vh, "StatusUpdated");
      expect((await vh.getAccidentHistory(1)).length).to.equal(2);
    });

    it("rejects accidents from non-inspectors, with no report hash, or on unknown vehicles", async function () {
      const { vh, inspector, service } = await loadFixture(registeredFixture);
      await expect(vh.connect(service).recordAccident(1, Sev.Minor, REPORT)).to.be.revertedWith("Access denied: Inspector only");
      await expect(vh.connect(inspector).recordAccident(1, Sev.Minor, ethers.ZeroHash)).to.be.revertedWith("Invalid report hash");
      await expect(vh.connect(inspector).recordAccident(99, Sev.Minor, REPORT)).to.be.revertedWith("Vehicle does not exist");
    });

    it("accident history cannot be hidden by selling the car", async function () {
      const { vh, inspector, owner, buyer } = await loadFixture(registeredFixture);
      await vh.connect(inspector).recordAccident(1, Sev.Moderate, REPORT);
      await vh.connect(owner).transferOwnership(1, buyer.address);
      const a = await vh.getAccidentHistory(1);
      expect(a.length).to.equal(1);
      expect(a[0].severity).to.equal(Sev.Moderate);
    });
  });

  // ------------------------------------------------------------ ownership
  describe("Ownership transfer", function () {
    it("owner transfers the vehicle; transfer history is recorded", async function () {
      const { vh, owner, buyer } = await loadFixture(registeredFixture);
      await expect(vh.connect(owner).transferOwnership(1, buyer.address))
        .to.emit(vh, "OwnershipTransferred")
        .withArgs(1, owner.address, buyer.address);
      expect((await vh.getVehicle(1)).owner).to.equal(buyer.address);
      const t = await vh.getOwnershipHistory(1);
      expect(t.length).to.equal(1);
      expect(t[0].previousOwner).to.equal(owner.address);
      expect(t[0].newOwner).to.equal(buyer.address);
    });

    it("only the current owner can transfer; the previous owner loses that right", async function () {
      const { vh, owner, buyer, stranger } = await loadFixture(registeredFixture);
      await expect(vh.connect(stranger).transferOwnership(1, stranger.address)).to.be.revertedWith("Not vehicle owner");
      await vh.connect(owner).transferOwnership(1, buyer.address);
      await expect(vh.connect(owner).transferOwnership(1, owner.address)).to.be.revertedWith("Not vehicle owner");
    });

    it("rejects a transfer to the zero address or to oneself", async function () {
      const { vh, owner } = await loadFixture(registeredFixture);
      await expect(vh.connect(owner).transferOwnership(1, ethers.ZeroAddress)).to.be.revertedWith("Invalid new owner");
      await expect(vh.connect(owner).transferOwnership(1, owner.address)).to.be.revertedWith("Already vehicle owner");
    });

    it("a suspended vehicle (e.g. after a major accident) cannot be sold", async function () {
      const { vh, inspector, owner, buyer } = await loadFixture(registeredFixture);
      await vh.connect(inspector).recordAccident(1, Sev.Major, REPORT);
      await expect(vh.connect(owner).transferOwnership(1, buyer.address)).to.be.revertedWith("Vehicle is not active");
    });

    it("rejects a transfer of an unknown vehicle", async function () {
      const { vh, owner, buyer } = await loadFixture(registeredFixture);
      await expect(vh.connect(owner).transferOwnership(99, buyer.address)).to.be.revertedWith("Vehicle does not exist");
    });
  });

  // ------------------------------------------------------------ status
  describe("Vehicle status", function () {
    it("inspector suspends and reactivates a vehicle", async function () {
      const { vh, inspector } = await loadFixture(registeredFixture);
      await expect(vh.connect(inspector).updateVehicleStatus(1, Status.Suspended))
        .to.emit(vh, "StatusUpdated")
        .withArgs(1, Status.Suspended);
      await vh.connect(inspector).updateVehicleStatus(1, Status.Active);
      expect((await vh.getVehicle(1)).status).to.equal(Status.Active);
    });

    it("scrapping is terminal: no restore, no transfer", async function () {
      const { vh, inspector, owner, buyer } = await loadFixture(registeredFixture);
      await vh.connect(inspector).updateVehicleStatus(1, Status.Scrapped);
      await expect(vh.connect(inspector).updateVehicleStatus(1, Status.Active)).to.be.revertedWith("Scrapped vehicle cannot be restored");
      await expect(vh.connect(owner).transferOwnership(1, buyer.address)).to.be.revertedWith("Vehicle is not active");
      expect(await vh.verifyVIN(VIN)).to.equal(true); // the VIN can never be reused
    });

    it("rejects an unchanged status, non-inspectors and unknown vehicles", async function () {
      const { vh, inspector, service } = await loadFixture(registeredFixture);
      await expect(vh.connect(inspector).updateVehicleStatus(1, Status.Active)).to.be.revertedWith("Status unchanged");
      await expect(vh.connect(service).updateVehicleStatus(1, Status.Suspended)).to.be.revertedWith("Access denied: Inspector only");
      await expect(vh.connect(inspector).updateVehicleStatus(99, Status.Suspended)).to.be.revertedWith("Vehicle does not exist");
    });
  });

  // ------------------------------------------------------------ public verification
  describe("Public verification", function () {
    it("all history getters revert for an unknown vehicle id", async function () {
      const { vh } = await loadFixture(registeredFixture);
      await expect(vh.getVehicle(99)).to.be.revertedWith("Vehicle does not exist");
      await expect(vh.getAccidentHistory(99)).to.be.revertedWith("Vehicle does not exist");
      await expect(vh.getMaintenanceHistory(99)).to.be.revertedWith("Vehicle does not exist");
      await expect(vh.getOwnershipHistory(99)).to.be.revertedWith("Vehicle does not exist");
    });

    it("a stranger can read the full history without any role", async function () {
      const { vh, inspector, service, owner, buyer, stranger } = await loadFixture(registeredFixture);
      await vh.connect(service).recordMaintenance(1, 10500, REPORT);
      await vh.connect(inspector).recordAccident(1, Sev.Minor, REPORT2);
      await vh.connect(owner).transferOwnership(1, buyer.address);
      const asStranger = vh.connect(stranger);
      expect((await asStranger.getMaintenanceHistory(1)).length).to.equal(1);
      expect((await asStranger.getAccidentHistory(1)).length).to.equal(1);
      expect((await asStranger.getOwnershipHistory(1)).length).to.equal(1);
    });
  });
});
