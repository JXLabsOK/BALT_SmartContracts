// scripts/deployEthUsdtFactoryV2.js
require("dotenv").config();
const { ethers } = require("ethers");

// Commission wallet Ethereum mainnet
const COMMISSION_WALLET = "0x7777f214CE0164De53D7017C78d9659eE5C28218";

// USDT mainnet (6 decimales)
const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const FEE_BPS = 80;
const MIN_DEPOSIT_USDT = ethers.parseUnits("20", 6);

// ABI + bytecode de la factory ERC20 USD6
const factoryJson = require("../artifacts/contracts/ERC20InheritanceFactoryUSD6V2.sol/ERC20InheritanceFactoryUSD6V2.json");

async function main() {
  console.log(">>> Iniciando deployEthUsdtFactoryV2...");

  const rpcUrl = process.env.ETH_MAINNET_RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;

  if (!rpcUrl) throw new Error("ETH_MAINNET_RPC_URL not defined in .env");
  if (!privateKey) throw new Error("PRIVATE_KEY not defined in .env");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const balance = await provider.getBalance(wallet.address);

  console.log("Deploying ERC20InheritanceFactoryUSD6V2 for USDT (raw ethers)");
  console.log("Network      : mainnet (chainId=1)");
  console.log("Deployer     :", wallet.address);
  console.log("Balance      :", ethers.formatEther(balance), "ETH");
  console.log("Commission   :", COMMISSION_WALLET);
  console.log("Token (USDT) :", USDT_ADDRESS);
  console.log("Fee (bps)    :", FEE_BPS);
  console.log("Min deposit  :", MIN_DEPOSIT_USDT.toString(), "(raw, 6 decimals)");

  const Factory = new ethers.ContractFactory(
    factoryJson.abi,
    factoryJson.bytecode,
    wallet
  );

  const factory = await Factory.deploy(
    COMMISSION_WALLET,
    USDT_ADDRESS,
    FEE_BPS,
    MIN_DEPOSIT_USDT
  );

  const deploymentTx = factory.deploymentTransaction();
  console.log("Deployment tx sent:", deploymentTx.hash);

  const receipt = await deploymentTx.wait();

  const factoryAddress = await factory.getAddress();
  console.log("✅ ERC20InheritanceFactoryUSD6V2 (USDT) deployed at:", factoryAddress);
  console.log("Tx hash:", receipt.hash);

  console.log("commissionWallet:", await factory.commissionWallet());
  console.log("token           :", await factory.token());
  console.log("feeBps          :", (await factory.feeBps()).toString());
  console.log("minDeposit      :", (await factory.minDeposit()).toString());
}

main().catch((error) => {
  console.error("Error en deployEthUsdtFactoryV2:", error);
  process.exitCode = 1;
});