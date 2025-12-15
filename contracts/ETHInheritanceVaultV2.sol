// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ETHInheritanceVaultV2 {    
    address public immutable testator;
    address public immutable commissionWallet;
    
    address public heir;
    uint public inheritanceAmount;
    uint public lastCheckIn;
    uint public immutable inactivityPeriod;
    uint public createdAt;

    enum Status { Active, Released, Cancelled }
    Status public inheritanceStatus;

    uint constant ONE_ETH_WEI       = 1e18;                // 1 ETH
    uint constant FREE_TIER_MAX_WEI = 1e16;                // 0.01 ETH → 0% fee
    uint constant MIN_DEPOSIT_WEI   = 1000 * 1e10;         // 0.00001000 ETH
    uint16 constant BPS_DENOM       = 10_000;              // 100% = 10_000 bps

    event InheritanceRegistered(
        address indexed testator,
        address indexed heir,
        uint amount,
        uint inactivityPeriod
    );
    event CheckInPerformed(address indexed testator, uint timestamp);
    event InheritanceReleased(address indexed heir, uint amount);
    event InheritanceCancelled(address indexed testator, uint refundedAmount);
    event FeeApplied(
        address indexed testator,
        uint16 bpsApplied,
        uint capAppliedWei,
        uint feeWei,
        uint grossDepositWei
    );

    constructor(
        address _testator,
        uint _inactivityPeriod,
        address _commissionWallet
    ) {
        require(_testator != address(0), "Invalid testator");
        require(_commissionWallet != address(0), "Invalid commission wallet");
        require(_inactivityPeriod > 0, "Invalid inactivity period");

        testator          = _testator;
        commissionWallet  = _commissionWallet;
        inactivityPeriod  = _inactivityPeriod;
        lastCheckIn       = block.timestamp;
        createdAt         = block.timestamp;
        inheritanceStatus = Status.Active;
    }

    function _feeBps(uint amountWei) internal pure returns (uint16) {
        if (amountWei <=  5  * ONE_ETH_WEI) return 80; // 0.80%
        if (amountWei <= 30  * ONE_ETH_WEI) return 70; // 0.70%
        if (amountWei <= 100 * ONE_ETH_WEI) return 60; // 0.60%
        return 50;                                     // 0.50%
    }

    function _capWei(uint amountWei) internal pure returns (uint) {
        if (amountWei <=   50 * ONE_ETH_WEI)  return  2e17; // 0.20 ETH
        if (amountWei <=  250 * ONE_ETH_WEI)  return  3e17; // 0.30 ETH
        if (amountWei <=  500 * ONE_ETH_WEI)  return  4e17; // 0.40 ETH
        if (amountWei <= 1000 * ONE_ETH_WEI)  return  5e17; // 0.50 ETH
        return 75e16;                                       // 0.75 ETH
    }

    function _computeUpfrontFee(uint amountWei)
        internal
        pure
        returns (uint feeWei, uint16 bpsApplied, uint capAppliedWei)
    {
        if (amountWei <= FREE_TIER_MAX_WEI) {
            return (0, 0, 0);
        }

        uint16 bps = _feeBps(amountWei);
        uint raw   = (amountWei * bps) / BPS_DENOM;
        uint cap   = _capWei(amountWei);
        uint fee   = raw > cap ? cap : raw;

        return (fee, bps, cap);
    }

    function registerInheritance(address _heir) external payable {
        require(msg.sender == testator, "Only the testator can register");
        require(msg.value > 0, "Must deposit funds for inheritance");
        require(_heir != address(0), "Invalid heir address");
        require(heir == address(0), "Inheritance already registered");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");

        (uint fee, uint16 bps, uint cap) = _computeUpfrontFee(msg.value);
        uint netAmount = msg.value - fee;

        require(
            netAmount >= MIN_DEPOSIT_WEI,
            "Deposit too small, minimum is 0.00001000 ETH"
        );

        heir = _heir;
        inheritanceAmount = netAmount;
        lastCheckIn = block.timestamp;

        if (fee > 0) {
            (bool sent, ) = commissionWallet.call{value: fee}("");
            require(sent, "Commission transfer failed");
        }

        emit InheritanceRegistered(testator, heir, inheritanceAmount, inactivityPeriod);
        emit FeeApplied(testator, bps, cap, fee, msg.value);
    }

    function performCheckIn() external {
        require(msg.sender == testator, "Only the testator can confirm activity");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");
        lastCheckIn = block.timestamp;
        emit CheckInPerformed(testator, lastCheckIn);
    }

    function cancelInheritance() external {
        require(msg.sender == testator, "Only testator can cancel");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");
        require(address(this).balance > 0, "No balance to return");

        inheritanceStatus = Status.Cancelled;

        uint amount = address(this).balance;
        (bool success, ) = payable(testator).call{value: amount}("");
        require(success, "Refund failed");

        emit InheritanceCancelled(testator, inheritanceAmount);
    }

    function claimInheritance() external {
        require(block.timestamp >= lastCheckIn + inactivityPeriod, "Testator is still active");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");
        require(msg.sender == heir, "Only the heir can claim");

        inheritanceStatus = Status.Released;

        uint amount = address(this).balance;
        (bool success, ) = payable(heir).call{value: amount}("");
        require(success, "Transfer failed");

        emit InheritanceReleased(heir, amount);
    }

    function getInheritanceDetails()
        external
        view
        returns (address _heir, uint _amount, uint _lastCheckIn, uint _createdAt, Status _status)
    {
        return (heir, inheritanceAmount, lastCheckIn, createdAt, inheritanceStatus);
    }
   
    receive() external payable {
        revert("use registerInheritance");
    }

    fallback() external payable {
        revert("use registerInheritance");
    }
}