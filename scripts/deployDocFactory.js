// scripts/deployDocFactory.js
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  
  const COMMISSION_WALLET = "0x4a460F2a401E5687493A7A2e1D15ACDC1ab9436e";
  const DOC_TOKEN_MAINNET = "0xe700691da7b9851f2f35f8b8182c69c53ccad9db"; // DoC oficial
  const FEE_BPS = 50; // 0.50%
  const MIN_DEPOSIT_DOC = "10"; // minimun DoC (ej: 10 DoC)

  const [deployer] = await ethers.getSigners();

  console.log("Using signer:", deployer.address);

  const minDeposit = ethers.parseUnits(MIN_DEPOSIT_DOC, 18);

  const Factory = await ethers.getContractFactory("ERC20InheritanceFactoryV2");
  const factory = await Factory.deploy(
    COMMISSION_WALLET,
    DOC_TOKEN_MAINNET,
    FEE_BPS,
    minDeposit
  );

  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  console.log("✅ ERC20InheritanceFactoryV2 (DoC) deployed at:", factoryAddress);
  console.log("Token (DoC):", DOC_TOKEN_MAINNET);
  console.log("Commission wallet:", COMMISSION_WALLET);
  console.log("Fee (bps):", FEE_BPS);
  console.log("Min net deposit (DoC):", MIN_DEPOSIT_DOC);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
