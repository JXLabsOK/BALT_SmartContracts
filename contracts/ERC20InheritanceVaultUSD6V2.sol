// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal ERC-20 interface
interface IERC20_USD6 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract ERC20InheritanceVaultUSD6V2 {    
    address public immutable testator;
    address public immutable commissionWallet;
    address public immutable token;        // ERC-20 token (USDT, USDC, etc.)
    uint16  public immutable feeBps;       // base fee in bps (e.g. 50 = 0.5%)
    uint256 public immutable minDeposit;   // minimum net inheritance in token units
    uint8   public immutable tokenDecimals;
    
    address public heir;
    uint256 public inheritanceAmount;      // net amount assigned to the heir (after fee)
    uint256 public lastCheckIn;
    uint256 public immutable inactivityPeriod;
    uint256 public createdAt;

    enum Status { Active, Released, Cancelled }
    Status public inheritanceStatus;

    // ---- Commission model (calibrated for 6-dec stables, 1 token = 1 USD) ----
    uint16  public constant BPS_DENOM = 10_000;
    uint256 private constant UNIT = 1e6;   // 6 decimals → 1 token = 1 * 10^6

    // Free tier: <= 0.01 BTC equivalent = 1,000 USD → 1,000 tokens
    uint256 private constant FREE_TIER_MAX = 1_000 * UNIT;

    // Dynamic fee tiers by deposit amount (tokens):
    // <=   500,000  → base fee (feeBps)
    // <= 3,000,000  → feeBps - 10 bps
    // <=10,000,000  → feeBps - 20 bps
    //  >10,000,000  → feeBps - 30 bps
    uint256 private constant TIER1_MAX =    500_000 * UNIT;   //   5 BTC eq.
    uint256 private constant TIER2_MAX =  3_000_000 * UNIT;   //  30 BTC eq.
    uint256 private constant TIER3_MAX = 10_000_000 * UNIT;   // 100 BTC eq.

    // Commission caps by deposit size (tokens):
    // ≤  50 BTC   → 0.20 BTC  = 20,000 USD → 20,000 tokens
    // ≤ 250 BTC   → 0.30 BTC  = 30,000 USD → 30,000 tokens
    // ≤ 500 BTC   → 0.40 BTC  = 40,000 USD → 40,000 tokens
    // ≤1000 BTC   → 0.50 BTC  = 50,000 USD → 50,000 tokens
    //  >1000 BTC  → 0.60 BTC  = 60,000 USD → 60,000 tokens
    uint256 private constant CAP1_MAX =   5_000_000 * UNIT;   //  50 BTC eq.
    uint256 private constant CAP2_MAX =  25_000_000 * UNIT;   // 250 BTC eq.
    uint256 private constant CAP3_MAX =  50_000_000 * UNIT;   // 500 BTC eq.
    uint256 private constant CAP4_MAX = 100_000_000 * UNIT;   //1000 BTC eq.

    uint256 private constant CAP1_VALUE = 20_000 * UNIT;
    uint256 private constant CAP2_VALUE = 30_000 * UNIT;
    uint256 private constant CAP3_VALUE = 40_000 * UNIT;
    uint256 private constant CAP4_VALUE = 50_000 * UNIT;
    uint256 private constant CAP5_VALUE = 60_000 * UNIT;
    
    event InheritanceRegistered(address indexed testator, address indexed heir, uint256 amount, uint256 inactivityPeriod);
    event CheckInPerformed(address indexed testator, uint256 timestamp);
    event InheritanceReleased(address indexed heir, uint256 amount);
    event InheritanceCancelled(address indexed testator, uint256 refundedAmount);
    event FeeApplied(address indexed testator, uint16  bpsApplied, uint256 capApplied, uint256 feeAmount, uint256 grossDeposit);

    constructor(address _testator, uint256 _inactivityPeriod, address _commissionWallet, address _token, uint16  _feeBps, uint256 _minDeposit) {
        require(_testator != address(0), "Invalid testator");
        require(_commissionWallet != address(0), "Invalid commission wallet");
        require(_token != address(0), "Invalid token");
        require(_feeBps < 10_000, "fee too high"); // < 100%
        require(_inactivityPeriod > 0, "Invalid inactivity");
        
        uint8 decs = IERC20_USD6(_token).decimals();
        require(decs == 6, "Token must have 6 decimals");

        testator = _testator;
        commissionWallet = _commissionWallet;
        token = _token;
        feeBps = _feeBps;
        minDeposit = _minDeposit;
        tokenDecimals = decs;

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
            // Prevent underflow for weird configs (feeBps < 30)
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
        // Free tier: depósitos ≤ 1,000 tokens no commission
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
            IERC20_USD6(token).transferFrom(testator, address(this), depositAmount),
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
                IERC20_USD6(token).transfer(commissionWallet, fee),
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

        uint256 bal = IERC20_USD6(token).balanceOf(address(this));
        require(bal > 0, "No balance");

        inheritanceStatus = Status.Cancelled;
        require(IERC20_USD6(token).transfer(testator, bal), "Refund failed");

        emit InheritanceCancelled(testator, bal);        
    }

    function claimInheritance() public {
        require(block.timestamp >= lastCheckIn + inactivityPeriod, "Testator active");
        require(inheritanceStatus == Status.Active, "Not active");
        require(msg.sender == heir, "Only heir");

        inheritanceStatus = Status.Released;

        uint256 bal = IERC20_USD6(token).balanceOf(address(this));
        require(bal > 0, "No balance to claim");
        require(IERC20_USD6(token).transfer(heir, bal), "Transfer failed");

        emit InheritanceReleased(heir, bal);
    }

    function getInheritanceDetails() public view returns (address, uint256, uint256, uint256, Status) {    
        return (heir, inheritanceAmount, lastCheckIn, createdAt, inheritanceStatus);
    }
}