// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal ERC-20 metadata interface for 6-decimal stablecoins
interface IERC20MetadataUSD6 {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IBALTPaymentsSubscriptionValidatorUSD6 {
    function isActive(address account) external view returns (bool);
}

contract BALTPaymentVaultUSD6 {
    address immutable public payer;
    address immutable public paymentToken;
    address immutable public subscriptionRegistry;
    uint8 immutable public tokenDecimals;

    uint256 public totalPaymentAmount;
    uint256 public totalClaimed;
    uint256 public totalRecovered;
    uint256 public lastCheckIn;
    uint256 immutable public inactivityPeriod;
    uint256 public createdAt;
    uint256 public paymentId;
    uint256 public recipientCount;
    uint256 public claimedCount;

    uint256 public constant MAX_RECIPIENTS = 100;
    uint256 public constant CLAIM_WINDOW = 90 days;

    // Standard ERC-20 selectors
    bytes4 private constant TRANSFER_SELECTOR =
        0xa9059cbb; // keccak256("transfer(address,uint256)")

    bytes4 private constant TRANSFER_FROM_SELECTOR =
        0x23b872dd; // keccak256("transferFrom(address,address,uint256)")

    enum Status { Idle, Active, Released, Cancelled, Closed }
    Status public paymentStatus;

    address[] private recipients;

    mapping(uint256 => mapping(address => uint256)) public amountDue;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    event PaymentRegistered(
        address indexed payer,
        uint256 indexed paymentId,
        address indexed paymentToken,
        uint256 totalAmount,
        uint256 recipientCount,
        uint256 inactivityPeriod
    );

    event CheckInPerformed(address indexed payer, uint256 indexed paymentId, uint256 timestamp);
    event PaymentClaimed(address indexed recipient, uint256 indexed paymentId, uint256 amount);
    event PaymentReleased(uint256 indexed paymentId, uint256 totalAmount);
    event PaymentCancelled(address indexed payer, uint256 indexed paymentId, uint256 refundedAmount);
    event PaymentClosed(address indexed payer, uint256 indexed paymentId, uint256 recoveredAmount);
    event ExcessTokenRecovered(address indexed token, address indexed to, uint256 amount);

    receive() external payable {
        revert("Native token not accepted");
    }

    modifier onlyPayer() {
        require(msg.sender == payer, "Only payer");
        _;
    }

    constructor(
        address _payer,
        address _paymentToken,
        uint256 _inactivityPeriod,
        address _subscriptionRegistry
    ) {
        require(_payer != address(0), "Invalid payer");
        require(_paymentToken != address(0), "Invalid payment token");
        require(_subscriptionRegistry != address(0), "Invalid subscription registry");
        require(_paymentToken.code.length > 0, "Payment token must be contract");
        require(_subscriptionRegistry.code.length > 0, "Subscription registry must be contract");
        require(_inactivityPeriod > 0, "Invalid inactivity period");

        uint8 decimals = IERC20MetadataUSD6(_paymentToken).decimals();
        require(decimals == 6, "Token must have 6 decimals");

        payer = _payer;
        paymentToken = _paymentToken;
        subscriptionRegistry = _subscriptionRegistry;
        tokenDecimals = decimals;
        inactivityPeriod = _inactivityPeriod;

        lastCheckIn = block.timestamp;
        createdAt = block.timestamp;
        paymentStatus = Status.Idle;
    }

    function registerPayment(
        uint256 _totalAmount,
        address[] calldata _recipients,
        uint256[] calldata _amounts
    ) external onlyPayer {
        require(
            IBALTPaymentsSubscriptionValidatorUSD6(subscriptionRegistry).isActive(payer),
            "Subscription inactive"
        );

        require(
            paymentStatus == Status.Idle ||
            paymentStatus == Status.Released ||
            paymentStatus == Status.Cancelled ||
            paymentStatus == Status.Closed,
            "Payment already active"
        );

        require(_totalAmount > 0, "Invalid total amount");
        require(_recipients.length > 0, "No recipients");
        require(_recipients.length == _amounts.length, "Length mismatch");
        require(_recipients.length <= MAX_RECIPIENTS, "Too many recipients");

        uint256 newPaymentId = paymentId + 1;
        uint256 sum = 0;

        delete recipients;

        for (uint256 i = 0; i < _recipients.length; i++) {
            address recipient = _recipients[i];
            uint256 amount = _amounts[i];

            require(recipient != address(0), "Invalid recipient");
            require(amount > 0, "Invalid recipient amount");
            require(amountDue[newPaymentId][recipient] == 0, "Duplicate recipient");

            amountDue[newPaymentId][recipient] = amount;
            recipients.push(recipient);

            sum += amount;
        }

        require(sum == _totalAmount, "Amounts must match total");

        paymentId = newPaymentId;
        totalPaymentAmount = _totalAmount;
        totalClaimed = 0;
        totalRecovered = 0;
        recipientCount = _recipients.length;
        claimedCount = 0;
        lastCheckIn = block.timestamp;
        paymentStatus = Status.Active;

        uint256 balanceBefore = IERC20MetadataUSD6(paymentToken).balanceOf(address(this));

        _safeTransferFrom(paymentToken, payer, address(this), _totalAmount);

        uint256 balanceAfter = IERC20MetadataUSD6(paymentToken).balanceOf(address(this));
        require(balanceAfter - balanceBefore == _totalAmount, "Invalid received amount");

        emit PaymentRegistered(
            payer,
            paymentId,
            paymentToken,
            totalPaymentAmount,
            recipientCount,
            inactivityPeriod
        );
    }

    function performCheckIn() external onlyPayer {
        require(
            IBALTPaymentsSubscriptionValidatorUSD6(subscriptionRegistry).isActive(payer),
            "Subscription inactive"
        );

        require(paymentStatus == Status.Active, "Payment is not active");
        require(block.timestamp < claimableAt(), "Payment already claimable");

        lastCheckIn = block.timestamp;

        emit CheckInPerformed(payer, paymentId, lastCheckIn);
    }

    function claimPayment() external {
        require(paymentStatus == Status.Active, "Payment is not active");
        require(block.timestamp >= claimableAt(), "Payment is not claimable yet");
        require(block.timestamp < claimExpiresAt(), "Claim window expired");

        uint256 amount = amountDue[paymentId][msg.sender];

        require(amount > 0, "No payment assigned");
        require(!hasClaimed[paymentId][msg.sender], "Payment already claimed");

        hasClaimed[paymentId][msg.sender] = true;
        totalClaimed += amount;
        claimedCount += 1;

        _safeTransfer(paymentToken, msg.sender, amount);

        emit PaymentClaimed(msg.sender, paymentId, amount);

        if (claimedCount == recipientCount) {
            paymentStatus = Status.Released;
            emit PaymentReleased(paymentId, totalPaymentAmount);
        }
    }

    function cancelPayment() external onlyPayer {
        require(paymentStatus == Status.Active, "Payment is not active");
        require(block.timestamp < claimableAt(), "Payment already claimable");

        paymentStatus = Status.Cancelled;

        uint256 pending = _pendingAmount();
        totalRecovered += pending;

        _safeTransfer(paymentToken, payer, pending);

        emit PaymentCancelled(payer, paymentId, pending);
    }

    function closeExpiredPayment() external onlyPayer {
        require(paymentStatus == Status.Active, "Payment is not active");
        require(block.timestamp >= claimExpiresAt(), "Claim window not expired");

        paymentStatus = Status.Closed;

        uint256 pending = _pendingAmount();
        totalRecovered += pending;

        if (pending > 0) {
            _safeTransfer(paymentToken, payer, pending);
        }

        emit PaymentClosed(payer, paymentId, pending);
    }

    function recoverExcessToken(address token, uint256 amount) external onlyPayer {
        require(token != address(0), "Invalid token");
        require(token.code.length > 0, "Token must be contract");
        require(amount > 0, "Invalid amount");

        if (token == paymentToken && paymentStatus == Status.Active) {
            uint256 vaultBalance = IERC20MetadataUSD6(paymentToken).balanceOf(address(this));
            uint256 pending = _pendingAmount();

            require(vaultBalance > pending, "No excess token");
            require(amount <= vaultBalance - pending, "Amount exceeds excess");
        }

        _safeTransfer(token, payer, amount);

        emit ExcessTokenRecovered(token, payer, amount);
    }

    function getRecipients()
        external
        view
        returns (
            address[] memory recipientAddresses,
            uint256[] memory recipientAmounts,
            bool[] memory claimed
        )
    {
        uint256 count = recipients.length;

        recipientAddresses = new address[](count);
        recipientAmounts = new uint256[](count);
        claimed = new bool[](count);

        for (uint256 i = 0; i < count; i++) {
            address recipient = recipients[i];

            recipientAddresses[i] = recipient;
            recipientAmounts[i] = amountDue[paymentId][recipient];
            claimed[i] = hasClaimed[paymentId][recipient];
        }
    }

    function getPaymentDetails()
        external
        view
        returns (
            address,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            Status
        )
    {
        return (
            paymentToken,
            paymentId,
            totalPaymentAmount,
            totalClaimed,
            lastCheckIn,
            createdAt,
            recipientCount,
            claimedCount,
            paymentStatus
        );
    }

    function claimableAt() public view returns (uint256) {
        return lastCheckIn + inactivityPeriod;
    }

    function claimExpiresAt() public view returns (uint256) {
        return claimableAt() + CLAIM_WINDOW;
    }

    function isClaimable() external view returns (bool) {
        return paymentStatus == Status.Active
            && block.timestamp >= claimableAt()
            && block.timestamp < claimExpiresAt();
    }

    function isClaimExpired() external view returns (bool) {
        return paymentStatus == Status.Active
            && block.timestamp >= claimExpiresAt();
    }

    function getAmountDue(address account) external view returns (uint256) {
        return amountDue[paymentId][account];
    }

    function hasRecipientClaimed(address account) external view returns (bool) {
        return hasClaimed[paymentId][account];
    }

    function pendingAmount() external view returns (uint256) {
        return _pendingAmount();
    }

    function getRecipientsCount() external view returns (uint256) {
        return recipients.length;
    }

    function _pendingAmount() internal view returns (uint256) {
        return totalPaymentAmount - totalClaimed - totalRecovered;
    }

    function _safeTransfer(address token, address to, uint256 value) internal {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(TRANSFER_SELECTOR, to, value));

        require(success, "USD6: transfer failed");

        if (data.length > 0) {
            require(abi.decode(data, (bool)), "USD6: transfer returned false");
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(TRANSFER_FROM_SELECTOR, from, to, value));

        require(success, "USD6: transferFrom failed");

        if (data.length > 0) {
            require(abi.decode(data, (bool)), "USD6: transferFrom returned false");
        }
    }
}