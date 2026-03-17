const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const commissionWallet = "0x1E64199D4bDDB9A50Aa19D58496ea684D862a643";

  console.log("Deploying InheritanceFactoryPro...");
  const FactoryPro = await hre.ethers.getContractFactory("InheritanceFactoryPro", signer);
  const factory = await FactoryPro.deploy(commissionWallet);
  await factory.waitForDeployment();
  console.log(`✅ InheritanceFactoryPro deployed at: ${factory.target}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});