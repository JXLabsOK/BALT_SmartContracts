// scripts/deployPaymentsFactory.js
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;

  const SUBSCRIPTION_REGISTRY = "0x166d96B871B13CBc4aA3Ebfcab9a6267cE0588fd";

  const [deployer] = await ethers.getSigners();

  console.log("Using signer:", deployer.address);

  if (!ethers.isAddress(SUBSCRIPTION_REGISTRY)) {
    throw new Error("Invalid subscription registry address");
  }

  const Factory = await ethers.getContractFactory("BALTPaymentsFactory");
  const factory = await Factory.deploy(SUBSCRIPTION_REGISTRY);

  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();

  console.log("✅ BALTPaymentsFactory deployed at:", factoryAddress);
  console.log("Subscription registry:", SUBSCRIPTION_REGISTRY);
}
  
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});