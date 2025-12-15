require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.28",
  networks: {
    rsk_mainnet: {
      url: process.env.RSK_MAINNET_RPC_URL || "https://public-node.rsk.co",
      accounts: [process.env.PRIVATE_KEY],
      chainId: 30,
    },
    rsk_testnet: {
      url: process.env.RSK_TESTNET_RPC_URL || "https://public-node.testnet.rsk.co",
      accounts: [process.env.PRIVATE_KEY],
      chainId: 31,
    },
    // Ethereum mainnet
    mainnet: {
      url: process.env.ETH_MAINNET_RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/hKJAoNuS2RclSpv2Jtvv7",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 1,
    },
  },
};