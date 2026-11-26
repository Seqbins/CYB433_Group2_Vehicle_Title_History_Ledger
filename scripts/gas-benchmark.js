// Deterministic gas benchmark: one fixed scenario, same calls and inputs for the
// original and the optimised contract.   Usage: npx hardhat run scripts/gas-benchmark.js
const { ethers } = require("hardhat");

async function main() {
  const [admin, inspector, service, owner, buyer] = await ethers.getSigners();
  const rows = [];
  const measure = async (label, txPromise) => {
    const rc = await (await txPromise).wait();
    rows.push({ call: label, gasUsed: Number(rc.gasUsed) });
  };

  const Factory = await ethers.getContractFactory("VehicleHistory");
  const args = Factory.interface.deploy.inputs.length ? [2000] : [];
  const vh = await Factory.deploy(...args);
  rows.push({ call: "deployment", gasUsed: Number((await vh.deploymentTransaction().wait()).gasUsed) });

  const VIN = ethers.id("JTDKB20U793456789");
  const VIN2 = ethers.id("1HGCM82633A004352");
  const R1 = ethers.id("report-1");
  const R2 = ethers.id("report-2");
  const skip = async (s) => {
    await ethers.provider.send("evm_increaseTime", [s]);
    await ethers.provider.send("evm_mine", []);
  };

  await measure("setInspector", vh.setInspector(inspector.address, true));
  await measure("setServiceCenter", vh.setServiceCenter(service.address, true));
  await measure("registerVehicle (1st)", vh.connect(inspector).registerVehicle(VIN, owner.address, 10000));
  await measure("registerVehicle (2nd)", vh.connect(inspector).registerVehicle(VIN2, owner.address, 0));
  await skip(30 * 86400);
  await measure("updateMileage", vh.connect(inspector).updateMileage(1, 12000));
  await measure("recordMaintenance (1st)", vh.connect(service).recordMaintenance(1, 13000, R1));
  await measure("recordMaintenance (2nd)", vh.connect(service).recordMaintenance(1, 13500, R2));
  await measure("recordAccident (Minor)", vh.connect(inspector).recordAccident(1, 0, R1));
  await measure("transferOwnership (1st)", vh.connect(owner).transferOwnership(1, buyer.address));
  await measure("transferOwnership (2nd)", vh.connect(buyer).transferOwnership(1, owner.address));
  await measure("recordAccident (Major, suspends)", vh.connect(inspector).recordAccident(1, 2, R2));
  await measure("updateVehicleStatus (reactivate)", vh.connect(inspector).updateVehicleStatus(1, 0));
  await measure("updateVehicleStatus (scrap)", vh.connect(inspector).updateVehicleStatus(2, 2));

  console.table(rows);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
