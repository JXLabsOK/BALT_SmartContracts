// scripts/deployPaymentsUSD6Factory.js
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;

  const SUBSCRIPTION_REGISTRY = "0x267d0473ebc1c31ab28ea423b33b2b4ccccc9d6c";

  const [deployer] = await ethers.getSigners();

  console.log("Using signer:", deployer.address);

  if (!ethers.isAddress(SUBSCRIPTION_REGISTRY)) {
    throw new Error("Invalid subscription registry address");
  }

  const Factory = await ethers.getContractFactory("BALTPaymentsFactoryUSD6");
  const factory = await Factory.deploy(SUBSCRIPTION_REGISTRY);

  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();

  console.log("✅ BALTPaymentsFactoryUSD6 deployed at:", factoryAddress);
  console.log("Subscription registry:", SUBSCRIPTION_REGISTRY);
}
  
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});