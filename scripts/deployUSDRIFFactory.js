// scripts/deployUSDRIFFactory.js
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  
  const COMMISSION_WALLET = "0x4a460F2a401E5687493A7A2e1D15ACDC1ab9436e";
  const USDRIF_TOKEN_MAINNET = "0x3a15461d8ae0f0fb5fa2629e9da7d66a794a6e37"; // USDRIF oficial
  const FEE_BPS = 50; // 0.50%
  const MIN_DEPOSIT_USDRIF = "10"; // minimun USDRIF (ej: 10 USDRIF)

  const [deployer] = await ethers.getSigners();

  console.log("Using signer:", deployer.address);

  const minDeposit = ethers.parseUnits(MIN_DEPOSIT_USDRIF, 18);

  const Factory = await ethers.getContractFactory("ERC20InheritanceFactoryV2");
  const factory = await Factory.deploy(
    COMMISSION_WALLET,
    USDRIF_TOKEN_MAINNET,
    FEE_BPS,
    minDeposit
  );

  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  console.log("✅ ERC20InheritanceFactoryV2 (USDRIF) deployed at:", factoryAddress);
  console.log("Token (USDRIF):", USDRIF_TOKEN_MAINNET);
  console.log("Commission wallet:", COMMISSION_WALLET);
  console.log("Fee (bps):", FEE_BPS);
  console.log("Min net deposit (USDRIF):", MIN_DEPOSIT_USDRIF);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
