// scripts/deployPaymentsSubscriptionRegistry.js
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;

  const [deployer] = await ethers.getSigners();

  console.log("Using signer:", deployer.address);

  const Registry = await ethers.getContractFactory("BALTPaymentsSubscriptionRegistry");
  const registry = await Registry.deploy();

  await registry.waitForDeployment();

  const registryAddress = await registry.getAddress();

  console.log("✅ BALTPaymentsSubscriptionRegistry deployed at:", registryAddress);
  console.log("Admin:", await registry.admin());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});