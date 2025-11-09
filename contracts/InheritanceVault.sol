// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract InheritanceVault {
    address immutable public testator;
    address public heir;
    address immutable public commissionWallet;
    uint public inheritanceAmount;
    uint public lastCheckIn;
    uint immutable public inactivityPeriod;
    uint public createdAt;
    uint256 constant MIN_DEPOSIT = 1000 * 1e10; // 1000 satoshis in wei //BΔLT-003

    enum Status { Active, Released, Cancelled }
    Status public inheritanceStatus;

    event InheritanceRegistered(address indexed testator, address indexed heir, uint amount, uint inactivityPeriod);
    event CheckInPerformed(address indexed testator, uint timestamp);
    event InheritanceReleased(address indexed heir, uint amount);
    event InheritanceCancelled(address indexed testator, uint refundedAmount);    
    event FeeApplied(address indexed testator, uint16 bpsApplied, uint capAppliedWei, uint feeWei, uint grossDepositWei);
    
    uint constant ONE_BTC_WEI       = 1e18;  // BTC 18 dec
    uint constant FREE_TIER_MAX_WEI = 1e16;  // 0.01 BTC
    uint16  constant BPS_DENOM      = 10_000;

    function _feeBps(uint amountWei) internal pure returns (uint16) {        
        if (amountWei <=  5  * ONE_BTC_WEI) return 80;
        if (amountWei <= 30  * ONE_BTC_WEI) return 70;
        if (amountWei <= 100 * ONE_BTC_WEI) return 60;
        return 50;
    }

    function _capWei(uint amountWei) internal pure returns (uint) {        
        if (amountWei <=   50 * ONE_BTC_WEI)  return  2e17;  // 0.20
        if (amountWei <=  250 * ONE_BTC_WEI)  return  3e17;  // 0.30
        if (amountWei <=  500 * ONE_BTC_WEI)  return  4e17;  // 0.40
        if (amountWei <= 1000 * ONE_BTC_WEI)  return  5e17;  // 0.50
        return 75e16;                                        // 0.75
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
        uint raw = (amountWei * bps) / BPS_DENOM;
        uint cap = _capWei(amountWei);
        uint fee = raw > cap ? cap : raw;
        return (fee, bps, cap);
    }    

    constructor(address _testator, uint _inactivityPeriod, address _commissionWallet) {        
        require(_testator != address(0), "Invalid testator");
        require(_commissionWallet != address(0), "Invalid commission wallet");
        require(_inactivityPeriod > 0, "Invalid inactivity period");

        testator = _testator;
        commissionWallet = _commissionWallet;
        inactivityPeriod = _inactivityPeriod;
        lastCheckIn = block.timestamp;
        createdAt = block.timestamp;
        inheritanceStatus = Status.Active;
    }

    function registerInheritance(address _heir) public payable {
        require(msg.sender == testator, "Only the testator can register the inheritance");
        require(msg.value > 0, "Must deposit funds for inheritance");
        require(_heir != address(0), "Invalid heir address"); //BΔLT-006
        require(heir == address(0), "Inheritance already registered");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");

        //Dynamic commission
        (uint fee, uint16 bps, uint cap) = _computeUpfrontFee(msg.value);

        uint netAmount = msg.value - fee;
        require(netAmount >= MIN_DEPOSIT, "Deposit too small, minimum is 1000 satoshis"); //BΔLT-003
        //BΔLT-004
        heir = _heir;
        inheritanceAmount = netAmount;
        lastCheckIn = block.timestamp; //BΔLT-002

        if (fee > 0) {
            (bool sent, ) = commissionWallet.call{value: fee}("");
            require(sent, "Commission transfer failed");
        }
        //BΔLT-004 END

        emit InheritanceRegistered(testator, heir, inheritanceAmount, inactivityPeriod);
        emit FeeApplied(testator, bps, cap, fee, msg.value);
    }

    function performCheckIn() public {
        require(msg.sender == testator, "Only the testator can confirm activity");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");
        lastCheckIn = block.timestamp;
        emit CheckInPerformed(testator, lastCheckIn);
    }

    function cancelInheritance() public {
        require(msg.sender == testator, "Only testator can cancel");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");
        require(address(this).balance > 0, "No balance to return");

        inheritanceStatus = Status.Cancelled;

        (bool success, ) = testator.call{value: address(this).balance}("");
        require(success, "Refund failed");

        emit InheritanceCancelled(testator, inheritanceAmount);
    }

    function claimInheritance() public {
        require(block.timestamp >= lastCheckIn + inactivityPeriod, "Testator is still active");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");
        require(msg.sender == heir, "Only the heir can claim the inheritance");

        inheritanceStatus = Status.Released;

        uint amount = address(this).balance;
        (bool success, ) = payable(heir).call{value: amount}("");
        require(success, "Transfer failed");

        emit InheritanceReleased(heir, amount);
    }

    function getInheritanceDetails() public view returns (address, uint, uint, uint, Status) {
        return (heir, inheritanceAmount, lastCheckIn, createdAt, inheritanceStatus);
    }
}