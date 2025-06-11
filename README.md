# 🧾 Inheritance Smart Contracts – BΔLT

This repository contains the smart contracts powering **BΔLT (Bitcoin Automated Legacy Trust)** — a decentralized inheritance protocol designed to operate on **Rootstock (RSK)**blockchains.

## 📦 Project Structure

- **InheritanceFactory.sol**  
  The factory contract responsible for deploying new instances of `InheritanceVault.sol`. It maintains a registry of all Vaults created by users and acts as the entry point for inheritance configuration.

- **InheritanceVault.sol**  
  A personalized inheritance vault deployed per user. It securely holds funds and manages inheritance logic based on inactivity timeframes. The vault allows for:
  - Setting a designated heir
  - Defining an inactivity period (e.g., 6 months)
  - Manual claim by heir if the testator becomes inactive
  - Cancellation or retrieval by the testator while still active

## ⚙️ Requirements

- Node.js & npm
- Hardhat (development environment)
- Metamask or any Web3-compatible wallet
- An RSK node or public RPC endpoint

## 🚀 Getting Started

1. Clone the repository:

   ```bash
   git clone https://github.com/your-org/inheritance-contracts.git
   cd inheritance-contracts