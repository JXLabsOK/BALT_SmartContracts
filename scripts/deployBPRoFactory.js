// scripts/deploy_BPROInheritanceFactoryV2.js
const { ethers } = require("hardhat");

async function main() {  
  const COMMISSION_WALLET = "0x4a460F2a401E5687493A7A2e1D15ACDC1ab9436e";
  const BPRO_TOKEN_MAINNET = "0x440cd83c160de5c96ddb20246815ea44c7abbca8";  // BPRO Official

  const feeBps = 80;                                   // 0.80%
  const minDeposit = ethers.parseUnits("0.00001", 18); // 0.00001000 BPRO

  console.log("Deploying BPROInheritanceFactoryV2...");
  console.log(" commissionWallet:", COMMISSION_WALLET);
  console.log(" token:", BPRO_TOKEN_MAINNET);
  console.log(" feeBps:", feeBps);
  console.log(" minDeposit:", minDeposit.toString());

  const Factory = await ethers.getContractFactory("BPROInheritanceFactoryV2");
  const factory = await Factory.deploy(
    COMMISSION_WALLET,
    BPRO_TOKEN_MAINNET,
    feeBps,
    minDeposit
  );

  await factory.waitForDeployment();

  const addr = await factory.getAddress();
  console.log("✅ BPROInheritanceFactoryV2 deployed at:", addr);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});