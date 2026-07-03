const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();  
  const commissionWallet = "0x1E64199D4bDDB9A50Aa19D58496ea684D862a643"; // dirección de comisión

  console.log("Deploying GiftFactory...");
  const GiftFactory = await hre.ethers.getContractFactory("BALTGiftFactory", signer);
  const factory = await GiftFactory.deploy(commissionWallet);
  await factory.waitForDeployment();
  console.log(`✅ GiftFactory deployed at: ${factory.target}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});