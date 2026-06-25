// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BALTPaymentVault.sol";

interface IBALTPaymentsSubscriptionRegistry {
    function isActive(address account) external view returns (bool);
}

contract BALTPaymentsFactory {
    address immutable public subscriptionRegistry;
    address[] public allVaults;

    mapping(address => address[]) public vaultsByPayer;

    event VaultCreated(
        address indexed payer,
        address indexed vaultAddress,
        address indexed paymentToken,
        uint inactivityPeriod
    );

    constructor(address _subscriptionRegistry) {
        require(_subscriptionRegistry != address(0), "Invalid subscription registry");

        subscriptionRegistry = _subscriptionRegistry;
    }

    function createPaymentVault(address paymentToken, uint inactivityPeriod) external returns (address) {
        require(
            IBALTPaymentsSubscriptionRegistry(subscriptionRegistry).isActive(msg.sender),
            "Subscription inactive"
        );

        require(paymentToken != address(0), "Invalid payment token");
        require(inactivityPeriod > 0, "Invalid inactivity period");

        // msg.sender can be an EOA or a Safe/multisig.
        BALTPaymentVault vault = new BALTPaymentVault(
            msg.sender,
            paymentToken,
            inactivityPeriod,
            subscriptionRegistry
        );

        address v = address(vault);
        allVaults.push(v);
        vaultsByPayer[msg.sender].push(v);

        emit VaultCreated(msg.sender, v, paymentToken, inactivityPeriod);
        return v;
    }

    function getVaultsByPayer(address payer) external view returns (address[] memory) {
        return vaultsByPayer[payer];
    }

    function getAllVaults() external view returns (address[] memory) {
        return allVaults;
    }

    function allVaultsCount() external view returns (uint) {
        return allVaults.length;
    }

    function vaultsByPayerCount(address payer) external view returns (uint) {
        return vaultsByPayer[payer].length;
    }

    function getAllVaultsSlice(uint offset, uint limit) external view returns (address[] memory out) {
        uint n = allVaults.length;
        if (offset >= n) return out;

        uint remaining = n - offset;
        uint count = limit > remaining ? remaining : limit;

        out = new address[](count);

        for (uint i = 0; i < count; i++) {
            out[i] = allVaults[offset + i];
        }
    }

    function getVaultsByPayerSlice(address payer, uint offset, uint limit) external view returns (address[] memory out)
    {
        address[] storage arr = vaultsByPayer[payer];
        uint n = arr.length;
        if (offset >= n) return out;

        uint remaining = n - offset;
        uint count = limit > remaining ? remaining : limit;

        out = new address[](count);

        for (uint i = 0; i < count; i++) {
            out[i] = arr[offset + i];
        }
    }
}