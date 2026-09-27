// scripts/deployRequestRbtcTestnet.js

const hre = require("hardhat");

const COMMISSION_WALLET = "0x7777f214CE0164De53D7017C78d9659eE5C28218";

async function main() {
    const { ethers } = hre;

    console.log(">>> Starting deployRequestRbtcTestnet...");

    const network = await ethers.provider.getNetwork();

    if (network.chainId !== 31n) {
        throw new Error(`Wrong network. Expected Rootstock Testnet chainId=31, received chainId=${network.chainId}`);
    }

    const [deployer] = await ethers.getSigners();
    const balance = await ethers.provider.getBalance(deployer.address);

    console.log("");
    console.log("Deploying BALTRequest for rBTC");
    console.log("Network                 : Rootstock Testnet (chainId=31)");
    console.log("Deployer                :", deployer.address);
    console.log("Balance                 :", ethers.formatEther(balance), "tRBTC");
    console.log("Commission wallet       :", COMMISSION_WALLET);
    console.log("Request asset           : Native rBTC");
    console.log("Request asset address   :", ethers.ZeroAddress);
    console.log("");

    const BALTRequest = await ethers.getContractFactory("BALTRequest");

    const request = await BALTRequest.deploy(
        COMMISSION_WALLET,
        ethers.ZeroAddress
    );

    const deploymentTx = request.deploymentTransaction();

    console.log("Deployment tx sent:", deploymentTx.hash);

    const receipt = await deploymentTx.wait();
    const requestAddress = await request.getAddress();

    console.log("");
    console.log("✅ BALTRequest rBTC deployed at:", requestAddress);
    console.log("Tx hash:", receipt.hash);
    console.log("");

    const commissionWallet = await request.commissionWallet();
    const requestAsset = await request.requestAsset();
    const requestFeeBps = await request.REQUEST_FEE_BPS();
    const maxBatchSize = await request.MAX_BATCH_SIZE();

    console.log("Contract configuration");
    console.log("----------------------");
    console.log("commissionWallet       :", commissionWallet);
    console.log("requestAsset           :", requestAsset);
    console.log("REQUEST_FEE_BPS        :", requestFeeBps.toString());
    console.log("MAX_BATCH_SIZE         :", maxBatchSize.toString());

    if (commissionWallet.toLowerCase() !== COMMISSION_WALLET.toLowerCase()) {
        throw new Error("Commission wallet verification failed");
    }

    if (requestAsset !== ethers.ZeroAddress) {
        throw new Error("rBTC request asset verification failed");
    }

    if (requestFeeBps !== 50n) {
        throw new Error("Request fee verification failed");
    }

    if (maxBatchSize !== 10n) {
        throw new Error("Max batch size verification failed");
    }

    console.log("");
    console.log("✅ Deployment verification completed successfully.");
}

main().catch((error) => {
    console.error("Error in deployRequestRbtcTestnet:", error);
    process.exitCode = 1;
});