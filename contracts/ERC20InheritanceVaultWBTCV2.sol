// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal ERC-20 interface
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract ERC20InheritanceVaultWBTCV2 {
    // Immutable roles / parameters
    address public immutable testator;
    address public immutable commissionWallet;
    address public immutable token;        // ERC-20 token (WBTC)
    uint16  public immutable feeBps;       // base fee in bps (e.g. 50 = 0.5%)
    uint256 public immutable minDeposit;   // minimum net inheritance in token units

    // Inheritance state
    address public heir;
    uint256 public inheritanceAmount;      // net amount assigned to the heir (after fee)
    uint256 public lastCheckIn;
    uint256 public immutable inactivityPeriod;
    uint256 public createdAt;

    enum Status { Active, Released, Cancelled }
    Status public inheritanceStatus;

    // ---- Commission model calibrated for WBTC (8 decimals) ----
    // All thresholds are expressed directly in WBTC units (1 WBTC = 1e8).
    uint16  public constant BPS_DENOM = 10_000;
    uint256 private constant UNIT = 1e8;   // 1 WBTC (8 decimals)

    // Free tier: <= 0.01 WBTC
    uint256 private constant FREE_TIER_MAX = 1_000_000; // 0.01 * 1e8

    // Dynamic fee tiers by deposit amount (WBTC):
    // <=   5 WBTC   → base fee (feeBps)
    // <=  30 WBTC   → feeBps - 10 bps
    // <= 100 WBTC   → feeBps - 20 bps
    //  > 100 WBTC   → feeBps - 30 bps
    uint256 private constant TIER1_MAX = 5   * UNIT;   //   5 WBTC
    uint256 private constant TIER2_MAX = 30  * UNIT;   //  30 WBTC
    uint256 private constant TIER3_MAX = 100 * UNIT;   // 100 WBTC

    // Commission caps by deposit size (WBTC):
    // ≤  50 WBTC   → 0.20 WBTC
    // ≤ 250 WBTC   → 0.30 WBTC
    // ≤ 500 WBTC   → 0.40 WBTC
    // ≤1000 WBTC   → 0.50 WBTC
    //  >1000 WBTC  → 0.60 WBTC
    uint256 private constant CAP1_MAX = 50    * UNIT;  //  50 WBTC
    uint256 private constant CAP2_MAX = 250   * UNIT;  // 250 WBTC
    uint256 private constant CAP3_MAX = 500   * UNIT;  // 500 WBTC
    uint256 private constant CAP4_MAX = 1000  * UNIT;  //1000 WBTC

    uint256 private constant CAP1_VALUE = 20_000_000; // 0.20 WBTC
    uint256 private constant CAP2_VALUE = 30_000_000; // 0.30 WBTC
    uint256 private constant CAP3_VALUE = 40_000_000; // 0.40 WBTC
    uint256 private constant CAP4_VALUE = 50_000_000; // 0.50 WBTC
    uint256 private constant CAP5_VALUE = 60_000_000; // 0.60 WBTC

    // Events (aligned with native RBTC vault)
    event InheritanceRegistered(address indexed testator, address indexed heir, uint256 amount, uint256 inactivityPeriod);
    event CheckInPerformed(address indexed testator, uint256 timestamp);
    event InheritanceReleased(address indexed heir, uint256 amount);
    event InheritanceCancelled(address indexed testator, uint256 refundedAmount);
    event FeeApplied(address indexed testator, uint16  bpsApplied, uint256 capApplied, uint256 feeAmount, uint256 grossDeposit);

    constructor(
        address _testator,
        uint256 _inactivityPeriod,
        address _commissionWallet,
        address _token,
        uint16  _feeBps,
        uint256 _minDeposit
    ) {
        require(_testator != address(0), "Invalid testator");
        require(_commissionWallet != address(0), "Invalid commission wallet");
        require(_token != address(0), "Invalid token");
        require(_feeBps < 10_000, "fee too high"); // < 100%
        require(_inactivityPeriod > 0, "Invalid inactivity");

        // Ensure this vault is used only with WBTC-like tokens (8 decimals)
        uint8 tokenDecimals = IERC20(_token).decimals();
        require(tokenDecimals == 8, "Token must have 8 decimals");

        testator = _testator;
        commissionWallet = _commissionWallet;
        token = _token;
        feeBps = _feeBps;
        minDeposit = _minDeposit;

        inactivityPeriod = _inactivityPeriod;
        lastCheckIn = block.timestamp;
        createdAt = block.timestamp;
        inheritanceStatus = Status.Active;
    }

    // --- Internal commission helpers ---
    function _effectiveFeeBps(uint256 amount) internal view returns (uint16) {
        // Assumes feeBps is the highest tier (e.g. 50 = 0.5%).
        if (amount <= TIER1_MAX) {
            return feeBps;
        } else if (amount <= TIER2_MAX) {
            return feeBps - 10;
        } else if (amount <= TIER3_MAX) {
            return feeBps - 20;
        } else {
            // Prevent underflow in case feeBps < 30 (should not happen in our configs)
            return feeBps > 30 ? uint16(feeBps - 30) : 0;
        }
    }

    function _capAmount(uint256 amount) internal pure returns (uint256) {
        if (amount <= CAP1_MAX) return CAP1_VALUE;
        if (amount <= CAP2_MAX) return CAP2_VALUE;
        if (amount <= CAP3_MAX) return CAP3_VALUE;
        if (amount <= CAP4_MAX) return CAP4_VALUE;
        return CAP5_VALUE;
    }

    function _computeUpfrontFee(uint256 grossAmount)
        internal
        view
        returns (uint256 fee, uint16 bpsApplied, uint256 capApplied)
    {
        if (grossAmount <= FREE_TIER_MAX) {
            return (0, 0, 0);
        }

        uint16 bps = _effectiveFeeBps(grossAmount);
        uint256 raw = (grossAmount * bps) / BPS_DENOM;
        uint256 cap = _capAmount(grossAmount);
        uint256 finalFee = raw > cap ? cap : raw;

        return (finalFee, bps, cap);
    }

    // --- Core logic ---
    function registerInheritance(address _heir, uint256 depositAmount) external {
        require(msg.sender == testator, "Only the testator can register");
        require(_heir != address(0), "Invalid heir address");
        require(heir == address(0), "Inheritance already registered");
        require(inheritanceStatus == Status.Active, "Inheritance not active");
        require(depositAmount > 0, "Must deposit funds");

        // Pull full deposit into the vault first
        require(
            IERC20(token).transferFrom(testator, address(this), depositAmount),
            "Deposit transfer failed"
        );

        // Compute fee and net inheritance
        (uint256 fee, uint16 bps, uint256 cap) = _computeUpfrontFee(depositAmount);
        uint256 netAmount = depositAmount - fee;
        require(netAmount >= minDeposit, "Deposit too small");

        // Update state before external commission transfer
        heir = _heir;
        inheritanceAmount = netAmount;
        lastCheckIn = block.timestamp;

        // Send commission out from the vault, if any
        if (fee > 0) {
            require(
                IERC20(token).transfer(commissionWallet, fee),
                "Commission transfer failed"
            );
        }

        emit InheritanceRegistered(testator, heir, netAmount, inactivityPeriod);
        emit FeeApplied(testator, bps, cap, fee, depositAmount);
    }

    function performCheckIn() public {
        require(msg.sender == testator, "Only the testator");
        require(inheritanceStatus == Status.Active, "Not active");
        lastCheckIn = block.timestamp;
        emit CheckInPerformed(testator, lastCheckIn);
    }

    function cancelInheritance() public {
        require(msg.sender == testator, "Only testator");
        require(inheritanceStatus == Status.Active, "Not active");

        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "No balance");

        inheritanceStatus = Status.Cancelled;
        require(IERC20(token).transfer(testator, bal), "Refund failed");

        emit InheritanceCancelled(testator, bal);
    }

    function claimInheritance() public {
        require(block.timestamp >= lastCheckIn + inactivityPeriod, "Testator active");
        require(inheritanceStatus == Status.Active, "Not active");
        require(msg.sender == heir, "Only heir");

        inheritanceStatus = Status.Released;

        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "No balance to claim");
        require(IERC20(token).transfer(heir, bal), "Transfer failed");

        emit InheritanceReleased(heir, bal);
    }

    function getInheritanceDetails()
        public
        view
        returns (address, uint256, uint256, uint256, Status)
    {
        return (heir, inheritanceAmount, lastCheckIn, createdAt, inheritanceStatus);
    }
}