// scripts/deployEthFactoryMainnetRaw.js
require("dotenv").config();
const { ethers } = require("ethers");

// Commission wallet Ethereum mainnet
const COMMISSION_WALLET = "0x7777f214CE0164De53D7017C78d9659eE5C28218";

// Import ABI + bytecode from artifacts de Hardhat
const factoryJson = require("../artifacts/contracts/ETHInheritanceFactoryV2.sol/ETHInheritanceFactoryV2.json");

async function main() {
  const rpcUrl = process.env.ETH_MAINNET_RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const balance = await provider.getBalance(wallet.address);

  console.log("Deploying ETHInheritanceFactoryV2 (raw ethers)");
  console.log("Network      : mainnet (chainId=1)");
  console.log("Deployer     :", wallet.address);
  console.log("Balance      :", ethers.formatEther(balance), "ETH");
  console.log("Commission   :", COMMISSION_WALLET);

  const Factory = new ethers.ContractFactory(
    factoryJson.abi,
    factoryJson.bytecode,
    wallet
  );

  const factory = await Factory.deploy(COMMISSION_WALLET);
  const tx = await factory.deploymentTransaction().wait();

  const factoryAddress = await factory.getAddress();
  console.log("✅ ETHInheritanceFactoryV2 deployed at:", factoryAddress);
  console.log("Tx hash:", tx.hash);

  const storedCommission = await factory.commissionWallet();
  console.log("commissionWallet in contract:", storedCommission);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});