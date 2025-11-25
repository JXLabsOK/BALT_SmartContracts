// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal ERC-20 interface
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract BPROInheritanceVaultV2 {
    // Immutable roles / parameters
    address public immutable testator;
    address public immutable commissionWallet;
    address public immutable token;        // ERC-20 token (BPRO)
    uint16  public immutable feeBps;       // base fee in bps (e.g. 80 = 0.8%)
    uint256 public immutable minDeposit;   // minimum net inheritance in token units

    // Inheritance state
    address public heir;
    uint256 public inheritanceAmount;      // net amount assigned to the heir (after fee)
    uint256 public lastCheckIn;
    uint256 public immutable inactivityPeriod;
    uint256 public createdAt;

    enum Status { Active, Released, Cancelled }
    Status public inheritanceStatus;

    // ---- Commission model (BTC-like, calibrated for BPRO, 18 decimals) ----
    uint16  public constant BPS_DENOM = 10_000;
    uint256 private constant ONE_BPRO = 1e18;

    // Free tier: <= 0.01 BPRO
    uint256 private constant FREE_TIER_MAX = ONE_BPRO / 100; // 0.01

    // Dynamic fee tiers by deposit amount (BPRO):
    // <=   5 BPRO   → feeBps        (80 bps)
    // <=  30 BPRO   → feeBps - 10   (70 bps)
    // <= 100 BPRO   → feeBps - 20   (60 bps)
    //  > 100 BPRO   → feeBps - 30   (50 bps)
    uint256 private constant TIER1_MAX =  5  * ONE_BPRO;
    uint256 private constant TIER2_MAX = 30  * ONE_BPRO;
    uint256 private constant TIER3_MAX = 100 * ONE_BPRO;

    // Commission caps by deposit size (BPRO):
    // ≤  50 BPRO   → 0.20 BPRO
    // ≤ 250 BPRO   → 0.30 BPRO
    // ≤ 500 BPRO   → 0.40 BPRO
    // ≤1000 BPRO   → 0.50 BPRO
    // >1000 BPRO   → 0.60 BPRO
    uint256 private constant CAP1_MAX =   50  * ONE_BPRO;
    uint256 private constant CAP2_MAX =  250  * ONE_BPRO;
    uint256 private constant CAP3_MAX =  500  * ONE_BPRO;
    uint256 private constant CAP4_MAX = 1000  * ONE_BPRO;

    uint256 private constant CAP1_VALUE = 2  * 10**17; // 0.20 BPRO
    uint256 private constant CAP2_VALUE = 3  * 10**17; // 0.30 BPRO
    uint256 private constant CAP3_VALUE = 4  * 10**17; // 0.40 BPRO
    uint256 private constant CAP4_VALUE = 5  * 10**17; // 0.50 BPRO
    uint256 private constant CAP5_VALUE = 6  * 10**17; // 0.60 BPRO

    // Events (aligned with native RBTC vault / DoC vault)
    event InheritanceRegistered(address indexed testator, address indexed heir, uint256 amount, uint256 inactivityPeriod);
    event CheckInPerformed(address indexed testator, uint256 timestamp);
    event InheritanceReleased(address indexed heir, uint256 amount);
    event InheritanceCancelled(address indexed testator, uint256 refundedAmount);
    event FeeApplied(address indexed testator, uint16 bpsApplied, uint256 capApplied, uint256 feeAmount, uint256 grossDeposit);

    constructor(address _testator, uint256 _inactivityPeriod, address _commissionWallet, address _token, uint16 _feeBps, uint256 _minDeposit) {
        require(_testator != address(0), "Invalid testator");
        require(_commissionWallet != address(0), "Invalid commission wallet");
        require(_token != address(0), "Invalid token");
        require(_feeBps < 10_000, "fee too high"); // < 100%
        require(_inactivityPeriod > 0, "Invalid inactivity");
        require(_minDeposit > 0, "Invalid minDeposit");

        testator = _testator;
        commissionWallet = _commissionWallet;
        token = _token;
        feeBps = _feeBps;          // para BPRO usaremos 80 en el factory
        minDeposit = _minDeposit;  // p.ej. 0.00001000 BPRO (1,000 sats eq.)

        inactivityPeriod = _inactivityPeriod;
        lastCheckIn = block.timestamp;
        createdAt = block.timestamp;
        inheritanceStatus = Status.Active;
    }

    // --- Internal commission helpers (BTC-like) ---
    function _effectiveFeeBps(uint256 amount) internal view returns (uint16) {
        if (amount <= TIER1_MAX) {
            return feeBps;              // 80 bps
        } else if (amount <= TIER2_MAX) {
            return uint16(feeBps - 10); // 70 bps
        } else if (amount <= TIER3_MAX) {
            return uint16(feeBps - 20); // 60 bps
        } else {
            // Prevent underflow in case feeBps < 30 (no deberia pasar en config)
            return feeBps > 30 ? uint16(feeBps - 30) : 0; // 50 bps
        }
    }

    function _capAmount(uint256 amount) internal pure returns (uint256) {
        if (amount <= CAP1_MAX) return CAP1_VALUE;
        if (amount <= CAP2_MAX) return CAP2_VALUE;
        if (amount <= CAP3_MAX) return CAP3_VALUE;
        if (amount <= CAP4_MAX) return CAP4_VALUE;
        return CAP5_VALUE;
    }

    function _computeUpfrontFee(uint256 grossAmount) internal view returns (uint256 fee, uint16 bpsApplied, uint256 capApplied) {
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
        require(IERC20(token).transferFrom(testator, address(this), depositAmount), "Deposit transfer failed");

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
            require(IERC20(token).transfer(commissionWallet, fee), "Commission transfer failed");
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

    function getInheritanceDetails() public view returns (address, uint256, uint256, uint256, Status) {
        return (heir, inheritanceAmount, lastCheckIn, createdAt, inheritanceStatus);
    }
}