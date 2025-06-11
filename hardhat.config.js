require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.28",
  networks: {
    rsk_testnet: {
      url: process.env.RSK_TESTNET_RPC_URL || "https://public-node.testnet.rsk.co",
      accounts: [process.env.PRIVATE_KEY],
      chainId: 31,
    },
  },
};