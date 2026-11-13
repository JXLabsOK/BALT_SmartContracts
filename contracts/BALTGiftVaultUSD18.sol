// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal ERC-20 metadata interface for 18-decimal stablecoins.
interface IERC20MetadataGiftUSD18 {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract BALTGiftVaultUSD18 {
    address public creator;
    address public beneficiary;
    address public commissionWallet;
    address public giftToken;

    uint public giftAmount;
    uint public releaseTimestamp;
    uint public createdAt;

    uint256 constant MIN_DEPOSIT = 1 * 1e18; // 1 DoC or 1 USDRIF

    enum Status { Active, Released, Cancelled }

    Status public giftStatus;

    bool private initialized;

    event GiftRegistered(address indexed creator, address indexed beneficiary, uint amount, uint releaseTimestamp);
    event GiftReleased(address indexed beneficiary, uint amount);
    event GiftCancelled(address indexed creator, uint refundedAmount);
    event FeeApplied(address indexed creator, uint16 bpsApplied, uint capApplied, uint feeAmount, uint grossDepositAmount);

    uint constant FREE_TIER_MAX = 200 * 1e18; // 200 tokens
    uint constant MAX_FEE = 50 * 1e18; // 50 tokens
    uint16 constant GIFT_FEE_BPS = 20; // 0.20%
    uint16 constant BPS_DENOM = 10_000;

    bytes4 private constant TRANSFER_SELECTOR = 0xa9059cbb; // keccak256("transfer(address,uint256)")
    bytes4 private constant TRANSFER_FROM_SELECTOR = 0x23b872dd; // keccak256("transferFrom(address,address,uint256)")

    constructor() {
        // Lock the implementation; clones have their own storage.
        initialized = true;
    }

    modifier onlyInitialized() {
        require(initialized, "Vault is not initialized");
        _;
    }

    function initialize(address _creator, address _giftToken, uint _releaseTimestamp, address _commissionWallet) external {
        require(!initialized, "Vault already initialized");
        require(_creator != address(0), "Invalid creator");
        require(_giftToken != address(0), "Invalid gift token");
        require(_commissionWallet != address(0), "Invalid commission wallet");
        require(_giftToken.code.length > 0, "Gift token must be contract");
        require(IERC20MetadataGiftUSD18(_giftToken).decimals() == 18, "Token must have 18 decimals");
        require(_releaseTimestamp > block.timestamp, "Invalid release timestamp");

        initialized = true;

        creator = _creator;
        giftToken = _giftToken;
        commissionWallet = _commissionWallet;
        releaseTimestamp = _releaseTimestamp;
        createdAt = block.timestamp;
        giftStatus = Status.Active;
    }

    function _computeUpfrontFee(uint amount) internal pure returns (uint feeAmount, uint16 bpsApplied, uint capApplied) {
        if (amount <= FREE_TIER_MAX) {
            return (0, 0, 0);
        }

        uint rawFee = (amount * GIFT_FEE_BPS) / BPS_DENOM;
        uint fee = rawFee > MAX_FEE ? MAX_FEE : rawFee;

        return (fee, GIFT_FEE_BPS, MAX_FEE);
    }

    function registerGift(address _beneficiary, uint depositAmount) public payable onlyInitialized {
        require(msg.sender == creator, "Only the creator can register the gift");
        require(depositAmount > 0, "Must deposit funds for gift");
        require(_beneficiary != address(0), "Invalid beneficiary address");
        require(beneficiary == address(0), "Gift already registered");
        require(giftStatus == Status.Active, "Gift is not active");
        require(block.timestamp < releaseTimestamp, "Release timestamp has already passed");
        require(msg.value == 0, "No RBTC top-up required");

        (uint fee, uint16 bps, uint cap) = _computeUpfrontFee(depositAmount);
        uint netAmount = depositAmount - fee;
        require(netAmount >= MIN_DEPOSIT, "Deposit too small, minimum is 1 token");

        beneficiary = _beneficiary;
        giftAmount = netAmount;

        uint balanceBefore = IERC20MetadataGiftUSD18(giftToken).balanceOf(address(this));
        _safeTransferFrom(giftToken, creator, address(this), depositAmount);
        uint balanceAfter = IERC20MetadataGiftUSD18(giftToken).balanceOf(address(this));
        require(balanceAfter - balanceBefore == depositAmount, "Invalid received amount");

        if (fee > 0) {
            _safeTransfer(giftToken, commissionWallet, fee);
        }

        emit GiftRegistered(creator, beneficiary, giftAmount, releaseTimestamp);
        emit FeeApplied(creator, bps, cap, fee, depositAmount);
    }

    function cancelGift() public onlyInitialized {
        require(msg.sender == creator, "Only creator can cancel");
        require(giftStatus == Status.Active, "Gift is not active");
        require(block.timestamp < releaseTimestamp, "Gift is already claimable");

        uint refundAmount = IERC20MetadataGiftUSD18(giftToken).balanceOf(address(this));
        require(refundAmount > 0, "No balance to return");

        giftStatus = Status.Cancelled;
        _safeTransfer(giftToken, creator, refundAmount);

        emit GiftCancelled(creator, refundAmount);
    }

    function claimGift() public onlyInitialized {
        require(block.timestamp >= releaseTimestamp, "Gift is not claimable yet");
        require(giftStatus == Status.Active, "Gift is not active");
        require(msg.sender == beneficiary, "Only the beneficiary can claim the gift");

        uint amount = IERC20MetadataGiftUSD18(giftToken).balanceOf(address(this));
        require(amount > 0, "No balance to claim");

        giftStatus = Status.Released;
        _safeTransfer(giftToken, beneficiary, amount);

        emit GiftReleased(beneficiary, amount);
    }

    function getGiftDetails() public view onlyInitialized returns (address, uint, uint, uint, Status) {
        return (beneficiary, giftAmount, releaseTimestamp, createdAt, giftStatus);
    }

    function _safeTransfer(address token, address to, uint256 value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(TRANSFER_SELECTOR, to, value));
        require(success, "USD18: transfer failed");
        if (data.length > 0) {
            require(abi.decode(data, (bool)), "USD18: transfer returned false");
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(TRANSFER_FROM_SELECTOR, from, to, value));
        require(success, "USD18: transferFrom failed");
        if (data.length > 0) {
            require(abi.decode(data, (bool)), "USD18: transferFrom returned false");
        }
    }
}
