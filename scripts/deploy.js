const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();  
  const commissionWallet = "0x1E64199D4bDDB9A50Aa19D58496ea684D862a643"; // dirección de comisión

  console.log("Deploying InheritanceFactory...");
  const InheritanceFactory = await hre.ethers.getContractFactory("InheritanceFactory", signer);
  const factory = await InheritanceFactory.deploy(commissionWallet);
  await factory.waitForDeployment();
  console.log(`✅ InheritanceFactory deployed at: ${factory.target}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});