// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./BALTGiftVault.sol";

contract BALTGiftFactory {
    using Clones for address;

    address immutable public commissionWallet;
    address immutable public giftVaultImplementation;

    address[] public allGiftVaults;
    mapping(address => address[]) public giftVaultsByCreator;

    event GiftVaultCreated(
        address indexed creator,
        address vaultAddress,
        uint releaseTimestamp
    );

    constructor(address _commissionWallet) {
        require(_commissionWallet != address(0), "Invalid commission wallet"); // BΔLT-GIFT-005

        commissionWallet = _commissionWallet;

        BALTGiftVault implementation = new BALTGiftVault();
        giftVaultImplementation = address(implementation);
    }

    function createGiftVault(uint releaseTimestamp) external returns (address) {
        require(releaseTimestamp > block.timestamp, "Invalid release timestamp");

        address vaultAddress = giftVaultImplementation.clone();

        BALTGiftVault(vaultAddress).initialize(
            msg.sender,
            releaseTimestamp,
            commissionWallet
        );

        allGiftVaults.push(vaultAddress);
        giftVaultsByCreator[msg.sender].push(vaultAddress);

        emit GiftVaultCreated(
            msg.sender,
            vaultAddress,
            releaseTimestamp
        );

        return vaultAddress;
    }

    function getGiftVaultsByCreator(address creator) external view returns (address[] memory) {
        return giftVaultsByCreator[creator];
    }

    function getAllGiftVaults() external view returns (address[] memory) {
        return allGiftVaults;
    }
}