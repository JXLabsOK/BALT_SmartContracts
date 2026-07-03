// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BALTGiftVault {
    address public creator;
    address public beneficiary;
    address public commissionWallet;
    uint public giftAmount;
    uint public releaseTimestamp;
    uint public createdAt;
    uint256 constant MIN_DEPOSIT = 1000 * 1e10; // 1000 satoshis in wei // BΔLT-GIFT-003

    enum Status { Active, Released, Cancelled }
    Status public giftStatus;

    bool private initialized;

    event GiftRegistered(address indexed creator, address indexed beneficiary, uint amount, uint releaseTimestamp);
    event GiftReleased(address indexed beneficiary, uint amount);
    event GiftCancelled(address indexed creator, uint refundedAmount);
    event FeeApplied(address indexed creator, uint16 bpsApplied, uint capAppliedWei, uint feeWei, uint grossDepositWei);

    uint constant FREE_TIER_MAX_WEI = 1e16;  // 0.01 BTC
    uint constant MAX_FEE_WEI       = 5e16;  // 0.05 BTC
    uint16 constant GIFT_FEE_BPS    = 20;    // 0.20%
    uint16 constant BPS_DENOM       = 10_000;

    constructor() {
        // Locks the implementation contract.
        // Clones keep their own storage, so they can still call initialize().
        initialized = true;
    }

    modifier onlyInitialized() {
        require(initialized, "Vault is not initialized");
        _;
    }

    function initialize(
        address _creator,
        uint _releaseTimestamp,
        address _commissionWallet
    ) external {
        require(!initialized, "Vault already initialized");
        require(_creator != address(0), "Invalid creator");
        require(_commissionWallet != address(0), "Invalid commission wallet");
        require(_releaseTimestamp > block.timestamp, "Invalid release timestamp");

        initialized = true;
        creator = _creator;
        commissionWallet = _commissionWallet;
        releaseTimestamp = _releaseTimestamp;
        createdAt = block.timestamp;
        giftStatus = Status.Active;
    }

    function _computeUpfrontFee(uint amountWei)
        internal
        pure
        returns (uint feeWei, uint16 bpsApplied, uint capAppliedWei)
    {
        if (amountWei <= FREE_TIER_MAX_WEI) {
            return (0, 0, 0);
        }

        uint rawFee = (amountWei * GIFT_FEE_BPS) / BPS_DENOM;
        uint fee = rawFee > MAX_FEE_WEI ? MAX_FEE_WEI : rawFee;

        return (fee, GIFT_FEE_BPS, MAX_FEE_WEI);
    }

    function registerGift(address _beneficiary) public payable onlyInitialized {
        require(msg.sender == creator, "Only the creator can register the gift");
        require(msg.value > 0, "Must deposit funds for gift");
        require(_beneficiary != address(0), "Invalid beneficiary address"); // BΔLT-GIFT-006
        require(beneficiary == address(0), "Gift already registered");
        require(giftStatus == Status.Active, "Gift is not active");
        require(block.timestamp < releaseTimestamp, "Release timestamp has already passed");

        // Flat gift commission
        (uint fee, uint16 bps, uint cap) = _computeUpfrontFee(msg.value);

        uint netAmount = msg.value - fee;
        require(netAmount >= MIN_DEPOSIT, "Deposit too small, minimum is 1000 satoshis"); // BΔLT-GIFT-003

        beneficiary = _beneficiary;
        giftAmount = netAmount;

        if (fee > 0) {
            (bool sent, ) = commissionWallet.call{value: fee}("");
            require(sent, "Commission transfer failed");
        }

        emit GiftRegistered(creator, beneficiary, giftAmount, releaseTimestamp);
        emit FeeApplied(creator, bps, cap, fee, msg.value);
    }

    function cancelGift() public onlyInitialized {
        require(msg.sender == creator, "Only creator can cancel");
        require(giftStatus == Status.Active, "Gift is not active");
        require(block.timestamp < releaseTimestamp, "Gift is already claimable");
        require(address(this).balance > 0, "No balance to return");

        giftStatus = Status.Cancelled;

        uint refundAmount = address(this).balance;

        (bool success, ) = creator.call{value: refundAmount}("");
        require(success, "Refund failed");

        emit GiftCancelled(creator, refundAmount);
    }

    function claimGift() public onlyInitialized {
        require(block.timestamp >= releaseTimestamp, "Gift is not claimable yet");
        require(giftStatus == Status.Active, "Gift is not active");
        require(msg.sender == beneficiary, "Only the beneficiary can claim the gift");

        giftStatus = Status.Released;

        uint amount = address(this).balance;

        (bool success, ) = payable(beneficiary).call{value: amount}("");
        require(success, "Transfer failed");

        emit GiftReleased(beneficiary, amount);
    }

    function getGiftDetails() public view onlyInitialized returns (address, uint, uint, uint, Status) {
        return (beneficiary, giftAmount, releaseTimestamp, createdAt, giftStatus);
    }
}