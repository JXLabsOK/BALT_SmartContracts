// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract BALTFamilyVault {
    using SafeERC20 for IERC20;

    address public immutable factory;

    address public creator;
    address public beneficiary;
    address public commissionWallet;
    address public asset;

    uint256 public releaseTimestamp;
    uint256 public createdAt;
    uint256 public monthlyWithdrawalLimit;

    uint256 public totalGrossContributed;
    uint256 public totalNetContributed;
    uint256 public totalWithdrawn;
    uint256 public totalFeesPaid;

    // Current net balance recognized by the vault accounting.
    uint256 public accountedBalance;

    // Direct transfers cannot be attributed to a specific contributor.
    uint256 public totalUnattributedNetContributed;

    mapping(address => uint256) public contributions;

    enum WithdrawalMode {
        FreeAfterDate,
        MonthlyLimit
    }

    WithdrawalMode public withdrawalMode;

    uint256 public constant WITHDRAWAL_PERIOD = 30 days;
    uint16 public constant FAMILY_FEE_BPS = 20; // 0.20%
    uint16 public constant BPS_DENOMINATOR = 10_000;

    uint256 private withdrawalPeriodMarker;
    uint256 private _withdrawnInCurrentPeriod;

    bool private initialized;
    bool private reentrancyLocked;

    event FamilyVaultInitialized(
        address indexed creator,
        address indexed beneficiary,
        address indexed asset,
        uint256 releaseTimestamp,
        WithdrawalMode withdrawalMode,
        uint256 monthlyWithdrawalLimit
    );

    event ContributionReceived(
        address indexed contributor,
        address indexed asset,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 netAmount
    );

    event UnaccountedFundsSynced(
        address indexed syncCaller,
        address indexed asset,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 netAmount
    );

    event FundsWithdrawn(
        address indexed beneficiary,
        address indexed asset,
        uint256 amount,
        WithdrawalMode withdrawalMode,
        uint256 periodIndex
    );

    event FeeApplied(
        address indexed contributor,
        address indexed asset,
        uint16 bpsApplied,
        uint256 feeAmount,
        uint256 grossAmount
    );

    constructor() {
        // The implementation is deployed directly by the Factory.
        // The immutable value is embedded in the implementation bytecode
        // and is therefore shared by all clones.
        factory = msg.sender;

        // Locks the implementation contract.
        // Clones keep their own storage and can still call initialize().
        initialized = true;
    }

    modifier onlyInitialized() {
        require(
            initialized && creator != address(0),
            "Vault is not initialized"
        );
        _;
    }

    modifier onlyBeneficiary() {
        require(
            msg.sender == beneficiary,
            "Only beneficiary can withdraw"
        );
        _;
    }

    modifier nonReentrant() {
        require(!reentrancyLocked, "Reentrant call");
        reentrancyLocked = true;
        _;
        reentrancyLocked = false;
    }

    function initialize(
        address _creator,
        address _beneficiary,
        address _asset,
        uint256 _releaseTimestamp,
        uint8 _withdrawalMode,
        uint256 _monthlyWithdrawalLimit,
        address _commissionWallet
    ) external {
        require(
            msg.sender == factory,
            "Only factory can initialize"
        );
        require(
            !initialized,
            "Vault already initialized"
        );
        require(
            _creator != address(0),
            "Invalid creator"
        );
        require(
            _beneficiary != address(0),
            "Invalid beneficiary"
        );
        require(
            _commissionWallet != address(0),
            "Invalid commission wallet"
        );
        require(
            _releaseTimestamp > block.timestamp,
            "Invalid release timestamp"
        );
        require(
            _withdrawalMode <= uint8(WithdrawalMode.MonthlyLimit),
            "Invalid withdrawal mode"
        );

        WithdrawalMode selectedMode =
            WithdrawalMode(_withdrawalMode);

        if (selectedMode == WithdrawalMode.FreeAfterDate) {
            require(
                _monthlyWithdrawalLimit == 0,
                "Monthly limit must be zero"
            );
        }

        if (selectedMode == WithdrawalMode.MonthlyLimit) {
            require(
                _monthlyWithdrawalLimit > 0,
                "Invalid monthly limit"
            );
        }

        if (_asset != address(0)) {
            require(
                _asset.code.length > 0,
                "Invalid token address"
            );
        }

        initialized = true;

        creator = _creator;
        beneficiary = _beneficiary;
        commissionWallet = _commissionWallet;
        asset = _asset;

        releaseTimestamp = _releaseTimestamp;
        createdAt = block.timestamp;
        withdrawalMode = selectedMode;
        monthlyWithdrawalLimit = _monthlyWithdrawalLimit;

        emit FamilyVaultInitialized(
            creator,
            beneficiary,
            asset,
            releaseTimestamp,
            withdrawalMode,
            monthlyWithdrawalLimit
        );
    }

    function contribute(
        uint256 amount
    ) external payable onlyInitialized nonReentrant {
        require(
            amount > 0,
            "Contribution must be greater than zero"
        );

        uint256 grossAmount;

        if (asset == address(0)) {
            require(
                msg.value == amount,
                "Native contribution amount mismatch"
            );

            // msg.value is already included in address(this).balance.
            // It must be excluded while synchronizing older direct funds.
            uint256 balanceBeforeContribution =
                address(this).balance - msg.value;

            _syncUnaccountedFundsFromBalance(
                balanceBeforeContribution
            );

            grossAmount = msg.value;
        } else {
            require(
                msg.value == 0,
                "Do not send native funds"
            );

            // Synchronize direct token transfers received before
            // processing the current contribution.
            _syncUnaccountedFunds();

            IERC20 token = IERC20(asset);

            uint256 balanceBefore =
                token.balanceOf(address(this));

            token.safeTransferFrom(
                msg.sender,
                address(this),
                amount
            );

            uint256 balanceAfter =
                token.balanceOf(address(this));

            grossAmount = balanceAfter - balanceBefore;

            require(
                grossAmount == amount,
                "Fee-on-transfer tokens are not supported"
            );
        }

        uint256 feeAmount =
            _computeContributionFee(grossAmount);

        uint256 netAmount =
            grossAmount - feeAmount;

        require(
            netAmount > 0,
            "Contribution amount too small"
        );

        totalGrossContributed += grossAmount;
        totalNetContributed += netAmount;
        totalFeesPaid += feeAmount;

        contributions[msg.sender] += netAmount;
        accountedBalance += netAmount;

        if (feeAmount > 0) {
            _transferAsset(
                commissionWallet,
                feeAmount
            );
        }

        emit ContributionReceived(
            msg.sender,
            asset,
            grossAmount,
            feeAmount,
            netAmount
        );

        emit FeeApplied(
            msg.sender,
            asset,
            FAMILY_FEE_BPS,
            feeAmount,
            grossAmount
        );
    }

    function syncUnaccountedFunds()
        external
        onlyInitialized
        nonReentrant
        returns (
            uint256 grossAmount,
            uint256 feeAmount,
            uint256 netAmount
        )
    {
        return _syncUnaccountedFunds();
    }

    function withdraw(
        uint256 amount
    )
        external
        onlyInitialized
        onlyBeneficiary
        nonReentrant
    {
        require(
            block.timestamp >= releaseTimestamp,
            "Withdrawals are not available yet"
        );
        require(
            amount > 0,
            "Withdrawal must be greater than zero"
        );

        // Applies the fee and recognizes any funds that were sent
        // directly to the vault before calculating the withdrawal.
        _syncUnaccountedFunds();

        uint256 availableAmount =
            availableToWithdraw();

        require(
            amount <= availableAmount,
            "Amount exceeds available withdrawal"
        );

        uint256 periodIndex;

        if (withdrawalMode == WithdrawalMode.MonthlyLimit) {
            periodIndex = _currentWithdrawalPeriod();

            uint256 currentMarker =
                periodIndex + 1;

            if (withdrawalPeriodMarker != currentMarker) {
                withdrawalPeriodMarker = currentMarker;
                _withdrawnInCurrentPeriod = 0;
            }

            _withdrawnInCurrentPeriod += amount;
        }

        totalWithdrawn += amount;
        accountedBalance -= amount;

        _transferAsset(
            beneficiary,
            amount
        );

        emit FundsWithdrawn(
            beneficiary,
            asset,
            amount,
            withdrawalMode,
            periodIndex
        );
    }

    function availableToWithdraw()
        public
        view
        onlyInitialized
        returns (uint256)
    {
        if (block.timestamp < releaseTimestamp) {
            return 0;
        }

        uint256 currentBalance =
            _effectiveAccountedBalance();

        if (currentBalance == 0) {
            return 0;
        }

        if (
            withdrawalMode ==
            WithdrawalMode.FreeAfterDate
        ) {
            return currentBalance;
        }

        uint256 alreadyWithdrawn =
            withdrawnInCurrentPeriod();

        if (
            alreadyWithdrawn >=
            monthlyWithdrawalLimit
        ) {
            return 0;
        }

        uint256 remainingPeriodicAmount =
            monthlyWithdrawalLimit -
            alreadyWithdrawn;

        if (
            currentBalance <
            remainingPeriodicAmount
        ) {
            return currentBalance;
        }

        return remainingPeriodicAmount;
    }

    function withdrawnInCurrentPeriod()
        public
        view
        onlyInitialized
        returns (uint256)
    {
        if (
            block.timestamp < releaseTimestamp ||
            withdrawalMode != WithdrawalMode.MonthlyLimit
        ) {
            return 0;
        }

        uint256 currentMarker =
            _currentWithdrawalPeriod() + 1;

        if (
            withdrawalPeriodMarker !=
            currentMarker
        ) {
            return 0;
        }

        return _withdrawnInCurrentPeriod;
    }

    function getVaultBalance()
        public
        view
        onlyInitialized
        returns (uint256)
    {
        return _rawVaultBalance();
    }

    function getPendingUnaccountedFunds()
        external
        view
        onlyInitialized
        returns (
            uint256 grossAmount,
            uint256 feeAmount,
            uint256 netAmount
        )
    {
        uint256 actualBalance =
            _rawVaultBalance();

        require(
            actualBalance >= accountedBalance,
            "Vault balance below accounting"
        );

        grossAmount =
            actualBalance - accountedBalance;

        if (grossAmount == 0) {
            return (0, 0, 0);
        }

        feeAmount =
            _computeContributionFee(grossAmount);

        netAmount =
            grossAmount - feeAmount;
    }

    function getCurrentWithdrawalPeriod()
        external
        view
        onlyInitialized
        returns (uint256)
    {
        if (block.timestamp < releaseTimestamp) {
            return 0;
        }

        return _currentWithdrawalPeriod();
    }

    function getContribution(
        address contributor
    )
        external
        view
        onlyInitialized
        returns (uint256)
    {
        return contributions[contributor];
    }

    function getFamilyVaultDetails()
        external
        view
        onlyInitialized
        returns (
            address vaultCreator,
            address vaultBeneficiary,
            address vaultAsset,
            uint256 vaultReleaseTimestamp,
            uint256 vaultCreatedAt,
            WithdrawalMode vaultWithdrawalMode,
            uint256 vaultMonthlyWithdrawalLimit,
            uint256 vaultBalance,
            uint256 vaultTotalContributed,
            uint256 vaultTotalWithdrawn
        )
    {
        return (
            creator,
            beneficiary,
            asset,
            releaseTimestamp,
            createdAt,
            withdrawalMode,
            monthlyWithdrawalLimit,
            getVaultBalance(),
            totalNetContributed,
            totalWithdrawn
        );
    }

    function _syncUnaccountedFunds()
        internal
        returns (
            uint256 grossAmount,
            uint256 feeAmount,
            uint256 netAmount
        )
    {
        return _syncUnaccountedFundsFromBalance(
            _rawVaultBalance()
        );
    }

    function _syncUnaccountedFundsFromBalance(
        uint256 actualBalance
    )
        internal
        returns (
            uint256 grossAmount,
            uint256 feeAmount,
            uint256 netAmount
        )
    {
        require(
            actualBalance >= accountedBalance,
            "Vault balance below accounting"
        );

        grossAmount =
            actualBalance - accountedBalance;

        if (grossAmount == 0) {
            return (0, 0, 0);
        }

        feeAmount =
            _computeContributionFee(grossAmount);

        netAmount =
            grossAmount - feeAmount;

        require(
            netAmount > 0,
            "Unaccounted contribution too small"
        );

        totalGrossContributed += grossAmount;
        totalNetContributed += netAmount;
        totalFeesPaid += feeAmount;
        totalUnattributedNetContributed += netAmount;

        accountedBalance += netAmount;

        if (feeAmount > 0) {
            _transferAsset(
                commissionWallet,
                feeAmount
            );
        }

        emit UnaccountedFundsSynced(
            msg.sender,
            asset,
            grossAmount,
            feeAmount,
            netAmount
        );

        return (
            grossAmount,
            feeAmount,
            netAmount
        );
    }

    function _effectiveAccountedBalance()
        internal
        view
        returns (uint256)
    {
        uint256 actualBalance =
            _rawVaultBalance();

        require(
            actualBalance >= accountedBalance,
            "Vault balance below accounting"
        );

        uint256 unaccountedGross =
            actualBalance - accountedBalance;

        if (unaccountedGross == 0) {
            return accountedBalance;
        }

        uint256 pendingFee =
            _computeContributionFee(
                unaccountedGross
            );

        uint256 unaccountedNet =
            unaccountedGross - pendingFee;

        return
            accountedBalance +
            unaccountedNet;
    }

    function _rawVaultBalance()
        internal
        view
        returns (uint256)
    {
        if (asset == address(0)) {
            return address(this).balance;
        }

        return IERC20(asset).balanceOf(
            address(this)
        );
    }

    function _computeContributionFee(uint256 amount) internal pure returns (uint256) {
        return (amount * FAMILY_FEE_BPS) / BPS_DENOMINATOR;
    }

    function _currentWithdrawalPeriod()
        internal
        view
        returns (uint256)
    {
        return (
            block.timestamp - releaseTimestamp
        ) / WITHDRAWAL_PERIOD;
    }

    function _transferAsset(
        address recipient,
        uint256 amount
    ) internal {
        if (asset == address(0)) {
            (bool success, ) = payable(recipient).call{
                value: amount
            }("");

            require(
                success,
                "Native transfer failed"
            );
        } else {
            IERC20(asset).safeTransfer(
                recipient,
                amount
            );
        }
    }

    receive() external payable {
        revert("Use contribute function");
    }

    fallback() external payable {
        revert("Unsupported call");
    }
}