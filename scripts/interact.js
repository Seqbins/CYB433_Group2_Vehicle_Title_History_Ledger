// Sends live write transactions to the deployed contract (rubric: >= 3 on Sepolia).
//   npx hardhat run scripts/interact.js --network sepolia
// The contract address is read from deployments/<network>.json (written by deploy.js)
// or from CONTRACT_ADDRESS in .env.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const address =
    process.env.CONTRACT_ADDRESS || (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)).address : null);
  if (!address) throw new Error("No contract address: run deploy.js first or set CONTRACT_ADDRESS in .env");

  const [signer] = await ethers.getSigners();
  const vh = await ethers.getContractAt("VehicleHistory", address, signer);
  const explorer = network.name === "sepolia" ? "https://sepolia.etherscan.io/tx/" : "";
  console.log(`Using VehicleHistory at ${address} as ${signer.address}\n`);

  const send = async (label, txPromise) => {
    const tx = await txPromise;
    const rc = await tx.wait();
    console.log(`${label.padEnd(38)} ${explorer}${tx.hash}  (gas ${rc.gasUsed})`);
  };

  // Demo data. Only keccak256(VIN) and report hashes go on-chain.
  const vin = process.env.DEMO_VIN || `DEMO${Date.now()}`; // unique per run
  const vinHash = ethers.id(vin);
  // The demo owner must differ from the signer: writers may not write history for their own car.
  const demoOwner = process.env.DEMO_OWNER_ADDRESS || ethers.Wallet.createRandom().address;
  const report = (name) => ethers.id(`ipfs://demo-${name}-${vin}`);

  if (!(await vh.inspectors(signer.address))) {
    await send("1. setInspector(deployer, true)", vh.setInspector(signer.address, true));
  }
  if (!(await vh.serviceCenters(signer.address))) {
    await send("2. setServiceCenter(deployer, true)", vh.setServiceCenter(signer.address, true));
  }
  await send("3. registerVehicle (10,000 km)", vh.registerVehicle(vinHash, demoOwner, 10000));
  const id = await vh.vehicleCount();
  await send(`4. recordMaintenance (#${id}, 10,500 km)`, vh.recordMaintenance(id, 10500, report("service")));
  await send(`5. recordAccident (#${id}, Minor)`, vh.recordAccident(id, 0, report("accident")));

  // Show that a rollback is rejected (simulated call only - costs no gas).
  try {
    await vh.updateMileage.staticCall(id, 9000);
  } catch (e) {
    const why = e.revert ? `${e.revert.name}(${e.revert.args.join(", ")})` : e.shortMessage || e.message;
    console.log(`\nRollback to 9,000 km rejected: ${why}`);
  }

  const v = await vh.getVehicle(id);
  console.log(`\nVehicle #${id}  VIN "${vin}" -> ${vinHash}`);
  console.log(`owner=${v.owner} mileage=${v.mileage} status=${v.status}`);
  console.log(`accidents=${(await vh.getAccidentHistory(id)).length} maintenance=${(await vh.getMaintenanceHistory(id)).length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
