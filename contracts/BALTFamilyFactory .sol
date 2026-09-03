// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./BALTFamilyVault.sol";

contract BALTFamilyFactory {
    using Clones for address;

    uint8 public constant WITHDRAWAL_MODE_FREE_AFTER_DATE = 0;
    uint8 public constant WITHDRAWAL_MODE_MONTHLY_LIMIT = 1;

    uint256 public constant MAX_LOCK_DURATION = 30 * 365 days;

    address public owner;
    address public immutable commissionWallet;
    address public immutable familyVaultImplementation;

    address[] public allFamilyVaults;

    mapping(address => address[]) public familyVaultsByCreator;
    mapping(address => address[]) public familyVaultsByBeneficiary;
    mapping(address => bool) public allowedAssets;

    event FamilyVaultCreated(
        address indexed creator,
        address indexed beneficiary,
        address indexed vaultAddress,
        address asset,
        uint256 releaseTimestamp,
        uint8 withdrawalMode,
        uint256 monthlyWithdrawalLimit
    );

    event AllowedAssetUpdated(
        address indexed asset,
        bool allowed
    );

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(address _commissionWallet) {
        require(
            _commissionWallet != address(0),
            "Invalid commission wallet"
        );

        owner = msg.sender;
        commissionWallet = _commissionWallet;

        BALTFamilyVault implementation = new BALTFamilyVault();
        familyVaultImplementation = address(implementation);

        emit OwnershipTransferred(address(0), msg.sender);
    }

    function createFamilyVault(
        address beneficiary,
        address asset,
        uint256 releaseTimestamp,
        uint8 withdrawalMode,
        uint256 monthlyWithdrawalLimit
    ) external returns (address) {
        require(
            beneficiary != address(0),
            "Invalid beneficiary"
        );

        require(
            releaseTimestamp > block.timestamp,
            "Invalid release timestamp"
        );

        require(
            releaseTimestamp <= block.timestamp + MAX_LOCK_DURATION,
            "Release timestamp exceeds maximum duration"
        );

        require(
            withdrawalMode == WITHDRAWAL_MODE_FREE_AFTER_DATE ||
                withdrawalMode == WITHDRAWAL_MODE_MONTHLY_LIMIT,
            "Invalid withdrawal mode"
        );

        if (withdrawalMode == WITHDRAWAL_MODE_FREE_AFTER_DATE) {
            require(
                monthlyWithdrawalLimit == 0,
                "Monthly limit must be zero"
            );
        }

        if (withdrawalMode == WITHDRAWAL_MODE_MONTHLY_LIMIT) {
            require(
                monthlyWithdrawalLimit > 0,
                "Invalid monthly limit"
            );
        }

        require(
            asset == address(0) || allowedAssets[asset],
            "Asset is not allowed"
        );

        address vaultAddress = familyVaultImplementation.clone();

        BALTFamilyVault(payable(vaultAddress)).initialize(
            msg.sender,
            beneficiary,
            asset,
            releaseTimestamp,
            withdrawalMode,
            monthlyWithdrawalLimit,
            commissionWallet
        );

        allFamilyVaults.push(vaultAddress);
        familyVaultsByCreator[msg.sender].push(vaultAddress);
        familyVaultsByBeneficiary[beneficiary].push(vaultAddress);

        emit FamilyVaultCreated(
            msg.sender,
            beneficiary,
            vaultAddress,
            asset,
            releaseTimestamp,
            withdrawalMode,
            monthlyWithdrawalLimit
        );

        return vaultAddress;
    }

    function setAllowedAsset(
        address asset,
        bool allowed
    ) external onlyOwner {
        require(
            asset != address(0),
            "Native RBTC is always allowed"
        );

        if (allowed) {
            require(
                asset.code.length > 0,
                "Asset must be a contract"
            );
        }

        allowedAssets[asset] = allowed;

        emit AllowedAssetUpdated(
            asset,
            allowed
        );
    }

    function transferOwnership(
        address newOwner
    ) external onlyOwner {
        require(
            newOwner != address(0),
            "Invalid new owner"
        );

        address previousOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(
            previousOwner,
            newOwner
        );
    }

    function getFamilyVaultsByCreator(
        address creator
    ) external view returns (address[] memory) {
        return familyVaultsByCreator[creator];
    }

    function getFamilyVaultsByBeneficiary(
        address beneficiary
    ) external view returns (address[] memory) {
        return familyVaultsByBeneficiary[beneficiary];
    }

    function getAllFamilyVaults()
        external
        view
        returns (address[] memory)
    {
        return allFamilyVaults;
    }

    function getTotalFamilyVaults()
        external
        view
        returns (uint256)
    {
        return allFamilyVaults.length;
    }
}