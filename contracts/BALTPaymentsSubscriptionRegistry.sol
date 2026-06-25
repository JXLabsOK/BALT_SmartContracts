// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BALTPaymentsSubscriptionRegistry {
    address public admin;
    address public pendingAdmin;

    mapping(address => uint256) public activeUntil;

    event SubscriptionUpdated(address indexed account, uint256 activeUntil);
    event SubscriptionRenewed(address indexed account, uint256 previousActiveUntil, uint256 newActiveUntil, uint256 duration);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferCancelled(address indexed currentAdmin, address indexed cancelledPendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    constructor() {
        admin = msg.sender;
        emit AdminTransferred(address(0), admin);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Invalid admin");
        require(newAdmin != admin, "Already admin");

        pendingAdmin = newAdmin;

        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "Only pending admin");

        address previousAdmin = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);

        emit AdminTransferred(previousAdmin, admin);
    }

    function cancelAdminTransfer() external onlyAdmin {
        address cancelledPendingAdmin = pendingAdmin;
        require(cancelledPendingAdmin != address(0), "No pending admin");

        pendingAdmin = address(0);

        emit AdminTransferCancelled(admin, cancelledPendingAdmin);
    }

    function setSubscription(address account, uint256 expirationTimestamp) external onlyAdmin {
        require(account != address(0), "Invalid account");
        require(expirationTimestamp > block.timestamp, "Invalid expiration");

        activeUntil[account] = expirationTimestamp;

        emit SubscriptionUpdated(account, expirationTimestamp);
    }

    function renewSubscription(address account, uint256 duration) external onlyAdmin {
        require(account != address(0), "Invalid account");
        require(duration > 0, "Invalid duration");

        uint256 previousActiveUntil = activeUntil[account];

        uint256 baseTime = previousActiveUntil > block.timestamp
            ? previousActiveUntil
            : block.timestamp;

        uint256 newActiveUntil = baseTime + duration;

        activeUntil[account] = newActiveUntil;

        emit SubscriptionRenewed(account, previousActiveUntil, newActiveUntil, duration);
        emit SubscriptionUpdated(account, newActiveUntil);
    }

    function deactivateSubscription(address account) external onlyAdmin {
        require(account != address(0), "Invalid account");

        activeUntil[account] = 0;

        emit SubscriptionUpdated(account, 0);
    }

    function isActive(address account) external view returns (bool) {
        return account != address(0) && block.timestamp <= activeUntil[account];
    }
}