// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./BALTGiftVaultUSD6.sol";

contract BALTGiftFactoryUSD6 {
    using Clones for address;

    address immutable public commissionWallet;
    address immutable public giftToken;
    address immutable public giftVaultImplementation;

    address[] public allGiftVaults;

    mapping(address => address[]) public giftVaultsByCreator;

    event GiftVaultCreated(address indexed creator, address vaultAddress, uint releaseTimestamp);

    constructor(address _commissionWallet, address _giftToken) {
        require(_commissionWallet != address(0), "Invalid commission wallet");
        require(_giftToken != address(0), "Invalid gift token");
        require(_giftToken.code.length > 0, "Gift token must be contract");
        require(IERC20MetadataGiftUSD6(_giftToken).decimals() == 6, "Token must have 6 decimals");

        commissionWallet = _commissionWallet;
        giftToken = _giftToken;

        BALTGiftVaultUSD6 implementation = new BALTGiftVaultUSD6();

        giftVaultImplementation = address(implementation);
    }

    function createGiftVault(uint releaseTimestamp) external returns (address) {
        require(releaseTimestamp > block.timestamp, "Invalid release timestamp");

        address vaultAddress = giftVaultImplementation.clone();

        BALTGiftVaultUSD6(vaultAddress).initialize(msg.sender, giftToken, releaseTimestamp, commissionWallet);

        allGiftVaults.push(vaultAddress);
        giftVaultsByCreator[msg.sender].push(vaultAddress);

        emit GiftVaultCreated(msg.sender, vaultAddress, releaseTimestamp);

        return vaultAddress;
    }

    function getGiftVaultsByCreator(address creator) external view returns (address[] memory) {
        return giftVaultsByCreator[creator];
    }

    function getAllGiftVaults() external view returns (address[] memory) {
        return allGiftVaults;
    }
}
