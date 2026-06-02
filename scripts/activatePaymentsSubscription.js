// scripts/activatePaymentsSubscription.js
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;

  const SUBSCRIPTION_REGISTRY = "0x98cA1D2cd8Df4B1830Fa9a5c5E56dE9A74bc3c14";
  const COMPANY_WALLET = "0x2e1B3b642eF2ae281535D9Fb8DF6876E4E9EF6d9";

  const SUBSCRIPTION_DAYS = 1000;

  const [admin] = await ethers.getSigners();

  console.log("Using admin signer:", admin.address);

  if (!ethers.isAddress(SUBSCRIPTION_REGISTRY)) {
    throw new Error("Invalid subscription registry address");
  }

  if (!ethers.isAddress(COMPANY_WALLET)) {
    throw new Error("Invalid company wallet address");
  }

  const registry = await ethers.getContractAt(
    "BALTPaymentsSubscriptionRegistry",
    SUBSCRIPTION_REGISTRY
  );

  const currentBlock = await ethers.provider.getBlock("latest");
  const expirationTimestamp =
    BigInt(currentBlock.timestamp) + BigInt(SUBSCRIPTION_DAYS * 24 * 60 * 60);

  const tx = await registry.setSubscription(COMPANY_WALLET, expirationTimestamp);
  await tx.wait();

  console.log("✅ Subscription activated");
  console.log("Company wallet:", COMPANY_WALLET);
  console.log("Active until:", expirationTimestamp.toString());
  console.log("Is active:", await registry.isActive(COMPANY_WALLET));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});