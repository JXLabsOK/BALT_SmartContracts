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

    enum Status { Active, Released, Cancelled }
    Status public inheritanceStatus;

    event InheritanceRegistered(address indexed testator, address indexed heir, uint amount, uint inactivityPeriod);
    event CheckInPerformed(address indexed testator, uint timestamp);
    event InheritanceReleased(address indexed heir, uint amount);
    event InheritanceCancelled(address indexed testator, uint refundedAmount);

    constructor(address _testator, uint _inactivityPeriod, address _commissionWallet) {
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
        require(heir == address(0), "Inheritance already registered");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");

        uint fee = (msg.value * 5) / 1000; // 0.5% commission
        uint netAmount = msg.value - fee;

        (bool sent, ) = commissionWallet.call{value: fee}("");
        require(sent, "Commission transfer failed");

        heir = _heir;
        inheritanceAmount = netAmount;

        emit InheritanceRegistered(testator, heir, inheritanceAmount, inactivityPeriod);
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