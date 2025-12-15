// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ETHInheritanceVaultV2.sol";

contract ETHInheritanceFactoryV2 {
    address public immutable commissionWallet;

    address[] public allVaults;
    mapping(address => address[]) public vaultsByTestator;

    event VaultCreated(address indexed testator, address vaultAddress);

    constructor(address _commissionWallet) {
        require(_commissionWallet != address(0), "Invalid commission wallet");
        commissionWallet = _commissionWallet;
    }

    function createInheritanceVault(uint inactivityPeriod)
        external
        returns (address)
    {
        require(inactivityPeriod > 0, "Invalid inactivity");

        ETHInheritanceVaultV2 vault = new ETHInheritanceVaultV2(
            msg.sender,
            inactivityPeriod,
            commissionWallet
        );

        address v = address(vault);
        allVaults.push(v);
        vaultsByTestator[msg.sender].push(v);

        emit VaultCreated(msg.sender, v);
        return v;
    }

    function getVaultsByTestator(address testator)
        external
        view
        returns (address[] memory)
    {
        return vaultsByTestator[testator];
    }

    function getAllVaults() external view returns (address[] memory) {
        return allVaults;
    }
}