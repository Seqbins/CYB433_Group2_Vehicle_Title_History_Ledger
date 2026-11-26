// Deploys VehicleHistory.
//   Local:   npx hardhat run scripts/deploy.js
//   Sepolia: npx hardhat run scripts/deploy.js --network sepolia
// Keys are read from .env by hardhat.config.js - never hard-code them here.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const MAX_KM_PER_DAY = 2000; // constructor argument (also needed for `hardhat verify`)

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Network:   ${network.name}`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH`);

  const Factory = await ethers.getContractFactory("VehicleHistory");
  const vh = await Factory.deploy(MAX_KM_PER_DAY);
  const deployTx = vh.deploymentTransaction();
  console.log(`Deploy tx: ${deployTx.hash}`);

  // Wait for a few confirmations on public networks so Etherscan has indexed the bytecode.
  const confirmations = network.name === "hardhat" || network.name === "localhost" ? 1 : 5;
  const receipt = await deployTx.wait(confirmations);
  const address = await vh.getAddress();

  console.log(`\nVehicleHistory deployed to: ${address}`);
  console.log(`Block: ${receipt.blockNumber}   Gas used: ${receipt.gasUsed}`);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    contract: "VehicleHistory",
    address,
    deployer: deployer.address,
    deployTxHash: deployTx.hash,
    blockNumber: receipt.blockNumber,
    constructorArgs: [MAX_KM_PER_DAY],
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(`Saved deployments/${network.name}.json`);

  if (network.name === "sepolia") {
    console.log(`\nEtherscan: https://sepolia.etherscan.io/address/${address}`);
    console.log(`Verify with:\n  npx hardhat verify --network sepolia ${address} ${MAX_KM_PER_DAY}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
