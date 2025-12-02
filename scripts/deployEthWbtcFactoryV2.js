require("dotenv").config();
const { ethers } = require("ethers");

// Commission wallet Ethereum mainnet
const COMMISSION_WALLET = "0x7777f214CE0164De53D7017C78d9659eE5C28218";

// WBTC (Wrapped Bitcoin) contract on Ethereum mainnet (8 decimals)
const WBTC_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";

const FEE_BPS = 50; // 0.5%
const MIN_DEPOSIT_WBTC = "0.00001"; 

const factoryJson = require("../artifacts/contracts/ERC20InheritanceFactoryWBTCV2.sol/ERC20InheritanceFactoryWBTCV2.json");
                                
async function main() {
  const rpcUrl = process.env.ETH_MAINNET_RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;

  if (!rpcUrl || !privateKey) {
    throw new Error("Faltan ETH_MAINNET_RPC_URL o PRIVATE_KEY en .env");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const balance = await provider.getBalance(wallet.address);
  const minDeposit = ethers.parseUnits(MIN_DEPOSIT_WBTC, 8); // 8 decimales de WBTC

  console.log("Deploying ERC20InheritanceFactoryWBTCV2 (raw ethers)");
  console.log("Network      : mainnet (chainId = 1)");
  console.log("Deployer     :", wallet.address);
  console.log("Balance      :", ethers.formatEther(balance), "ETH");
  console.log("Commission   :", COMMISSION_WALLET);
  console.log("WBTC Token   :", WBTC_ADDRESS);
  console.log("Fee BPS      :", FEE_BPS);
  console.log("Min deposit  :", MIN_DEPOSIT_WBTC, "WBTC (", minDeposit.toString(), "in units)");

  const Factory = new ethers.ContractFactory(
    factoryJson.abi,
    factoryJson.bytecode,
    wallet
  );

  // constructor(address _commissionWallet, address _token, uint16 _feeBps, uint256 _minDeposit)
  const factory = await Factory.deploy(
    COMMISSION_WALLET,
    WBTC_ADDRESS,
    FEE_BPS,
    minDeposit
  );

  const deployTx = factory.deploymentTransaction();
  console.log("Deploy tx sent:", deployTx.hash);

  const receipt = await deployTx.wait();
  const factoryAddress = await factory.getAddress();

  console.log("✅ ERC20InheritanceFactoryWBTCV2 deployed at:", factoryAddress);
  console.log("Tx hash:", receipt.hash);
  
  const storedCommission = await factory.commissionWallet();
  const storedToken = await factory.token();
  const storedFee = await factory.feeBps();
  const storedMinDeposit = await factory.minDeposit();

  console.log("commissionWallet in contract:", storedCommission);
  console.log("token in contract           :", storedToken);
  console.log("feeBps in contract          :", storedFee.toString());
  console.log("minDeposit in contract      :", storedMinDeposit.toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});