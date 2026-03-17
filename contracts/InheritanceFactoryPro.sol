// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./InheritanceVaultPro.sol";

contract InheritanceFactoryPro {
    address immutable public commissionWallet;
    address[] public allVaults;
    mapping(address => address[]) public vaultsByTestator;

    event VaultCreated(address indexed testator, address indexed vaultAddress, uint inactivityPeriod);

    constructor(address _commissionWallet) {
        require(_commissionWallet != address(0), "Invalid commission wallet"); //BΔLT-005
        commissionWallet = _commissionWallet;
    }

    function createInheritanceVault(uint inactivityPeriod) external returns (address) {
        // msg.sender puede ser EOA o Safe (multisig). En ambos casos sirve perfecto.
        InheritanceVaultPro vault = new InheritanceVaultPro(msg.sender, inactivityPeriod, commissionWallet);

        address v = address(vault);
        allVaults.push(v);
        vaultsByTestator[msg.sender].push(v);

        emit VaultCreated(msg.sender, v, inactivityPeriod);
        return v;
    }

    function getVaultsByTestator(address testator) external view returns (address[] memory) {
        return vaultsByTestator[testator];
    }

    function getAllVaults() external view returns (address[] memory) {
        return allVaults;
    }

    function allVaultsCount() external view returns (uint) {
        return allVaults.length;
    }

    function vaultsByTestatorCount(address testator) external view returns (uint) {
        return vaultsByTestator[testator].length;
    }

    function getAllVaultsSlice(uint offset, uint limit) external view returns (address[] memory out) {
        uint n = allVaults.length;
        if (offset >= n) return out;

        uint end = offset + limit;
        if (end > n) end = n;

        out = new address[](end - offset);
        for (uint i = offset; i < end; i++) {
            out[i - offset] = allVaults[i];
        }
    }

    function getVaultsByTestatorSlice(address testator, uint offset, uint limit) external view returns (address[] memory out)
    {
        address[] storage arr = vaultsByTestator[testator];
        uint n = arr.length;
        if (offset >= n) return out;

        uint end = offset + limit;
        if (end > n) end = n;

        out = new address[](end - offset);
        for (uint i = offset; i < end; i++) {
            out[i - offset] = arr[i];
        }
    }
}