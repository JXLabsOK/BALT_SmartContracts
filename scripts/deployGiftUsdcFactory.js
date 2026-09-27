// scripts/deployGiftUsdcFactory.js

require("dotenv").config();

const { ethers } = require("ethers");

// Commission wallet Ethereum mainnet
const COMMISSION_WALLET = "0x7777f214CE0164De53D7017C78d9659eE5C28218";

// Official USDC Ethereum mainnet (6 decimals)
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// ABI + bytecode of BALT Gift USD6 Factory
const factoryJson = require("../artifacts/contracts/BALTGiftFactoryUSD6.sol/BALTGiftFactoryUSD6.json");

async function main() {
    console.log(">>> Starting deployGiftUsdcFactory...");

    const rpcUrl = process.env.ETH_MAINNET_RPC_URL;
    const privateKey = process.env.PRIVATE_KEY;

    if (!rpcUrl) throw new Error("ETH_MAINNET_RPC_URL not defined in .env");
    if (!privateKey) throw new Error("PRIVATE_KEY not defined in .env");

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    const network = await provider.getNetwork();

    if (network.chainId !== 1n) {
        throw new Error(`Wrong network. Expected Ethereum Mainnet chainId=1, received chainId=${network.chainId}`);
    }

    const balance = await provider.getBalance(wallet.address);

    console.log("Deploying BALTGiftFactoryUSD6 for USDC");
    console.log("Network                 : Ethereum Mainnet (chainId=1)");
    console.log("Deployer                :", wallet.address);
    console.log("Balance                 :", ethers.formatEther(balance), "ETH");
    console.log("Commission wallet       :", COMMISSION_WALLET);
    console.log("Gift token (USDC)       :", USDC_ADDRESS);

    const Factory = new ethers.ContractFactory(factoryJson.abi, factoryJson.bytecode, wallet);

    const factory = await Factory.deploy(
        COMMISSION_WALLET,
        USDC_ADDRESS
    );

    const deploymentTx = factory.deploymentTransaction();

    console.log("Deployment tx sent:", deploymentTx.hash);

    const receipt = await deploymentTx.wait();
    const factoryAddress = await factory.getAddress();

    console.log("");
    console.log("✅ BALTGiftFactoryUSD6 deployed at:", factoryAddress);
    console.log("Tx hash:", receipt.hash);
    console.log("");

    const commissionWallet = await factory.commissionWallet();
    const giftToken = await factory.giftToken();
    const giftVaultImplementation = await factory.giftVaultImplementation();

    console.log("Factory configuration");
    console.log("---------------------");
    console.log("commissionWallet       :", commissionWallet);
    console.log("giftToken              :", giftToken);
    console.log("giftVaultImplementation:", giftVaultImplementation);

    if (commissionWallet.toLowerCase() !== COMMISSION_WALLET.toLowerCase()) {
        throw new Error("Commission wallet verification failed");
    }

    if (giftToken.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
        throw new Error("USDC address verification failed");
    }

    console.log("");
    console.log("✅ Deployment verification completed successfully.");
}

main().catch((error) => {
    console.error("Error in deployGiftUsdcFactory:", error);
    process.exitCode = 1;
});