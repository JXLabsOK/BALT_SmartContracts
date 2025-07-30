// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./InheritanceVault.sol";

contract InheritanceFactory {
    address public commissionWallet;
    address[] public allVaults;
    mapping(address => address[]) public vaultsByTestator;

    event VaultCreated(address indexed testator, address vaultAddress);

    constructor(address _commissionWallet) {
        require(_commissionWallet != address(0), "Invalid commission wallet"); //BΔLT-005
        commissionWallet = _commissionWallet;
    }

    function createInheritanceVault(uint inactivityPeriod) external returns (address) {
        InheritanceVault vault = new InheritanceVault(msg.sender, inactivityPeriod, commissionWallet);

        allVaults.push(address(vault));
        vaultsByTestator[msg.sender].push(address(vault));

        emit VaultCreated(msg.sender, address(vault));
        return address(vault);
    }

    function getVaultsByTestator(address testator) external view returns (address[] memory) {
        return vaultsByTestator[testator];
    }

    function getAllVaults() external view returns (address[] memory) {
        return allVaults;
    }
}