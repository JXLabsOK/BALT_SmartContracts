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
  },
};