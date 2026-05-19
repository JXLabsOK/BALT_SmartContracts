// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract InheritanceVaultPro {
    address immutable public testator;
    address public heir;
    address immutable public commissionWallet;
    uint public inheritanceAmount;
    uint public lastCheckIn;
    uint immutable public inactivityPeriod;
    uint public createdAt;
    uint256 constant MIN_DEPOSIT = 1000 * 1e10; // 1000 satoshis in wei //BΔLT-003
    uint256 constant MAX_BENEFICIARIES = 20;

    enum Status { Active, Released, Cancelled }
    Status public inheritanceStatus;

    // --- Beneficiaries / Splits (optional) ---
    address[] private beneficiaries;
    uint16[]  private beneficiaryBps; // sum to 10_000

    event InheritanceRegistered(address indexed testator, address indexed heir, uint amount, uint inactivityPeriod);
    event CheckInPerformed(address indexed testator, uint timestamp);
    event InheritanceReleased(address indexed heir, uint totalAmount);
    event InheritanceCancelled(address indexed testator, uint refundedAmount);    
    event FeeApplied(address indexed testator, uint16 bpsApplied, uint capAppliedWei, uint feeWei, uint grossDepositWei);

    // Pro events
    event TopUpPerformed(address indexed testator, uint netAddedWei, uint newNetTotalWei, uint timestamp);
    event BeneficiariesSet(bytes32 indexed configHash, uint count);
    event SplitPaid(address indexed recipient, uint amountWei);

    uint constant ONE_BTC_WEI       = 1e18;  // BTC 18 dec
    uint constant FREE_TIER_MAX_WEI = 1e16;  // 0.01 BTC
    uint16  constant BPS_DENOM      = 10_000;

    // Prevent bypassing fee model by plain transfers
    receive() external payable {
        revert("Use registerInheritance/topUp");
    }

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

    // --- Top-ups (MVP Pro) ---
    function topUp() external payable {
        require(msg.sender == testator, "Only testator can top up");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");
        require(heir != address(0), "Inheritance not registered");
        require(msg.value > 0, "Must deposit funds");

        (uint fee, uint16 bps, uint cap) = _computeUpfrontFee(msg.value);
        uint netAmount = msg.value - fee;

        require(netAmount >= MIN_DEPOSIT, "TopUp too small, minimum is 1000 satoshis");

        inheritanceAmount += netAmount;

        // Top-up counts as a heartbeat by default (Treasury-friendly)
        lastCheckIn = block.timestamp;

        if (fee > 0) {
            (bool sent, ) = commissionWallet.call{value: fee}("");
            require(sent, "Commission transfer failed");
        }

        emit TopUpPerformed(testator, netAmount, inheritanceAmount, lastCheckIn);
        emit FeeApplied(testator, bps, cap, fee, msg.value);
    }

    // --- Heartbeat ---
    function performCheckIn() external {
        require(msg.sender == testator, "Only the testator can confirm activity");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");
        lastCheckIn = block.timestamp;
        emit CheckInPerformed(testator, lastCheckIn);
    }

    // --- Beneficiaries / Splits (MVP Pro) ---
    function setBeneficiaries(address[] calldata _beneficiaries, uint16[] calldata _bps) external {
        require(msg.sender == testator, "Only testator can set beneficiaries");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");
        require(heir != address(0), "Inheritance not registered");        

        // Allow empty list => claim goes to heir (recovery-only mode)
        if (_beneficiaries.length == 0) {
            delete beneficiaries;
            delete beneficiaryBps;
            emit BeneficiariesSet(bytes32(0), 0);
            return;
        }

        require(_beneficiaries.length == _bps.length, "Length mismatch");
        require(_beneficiaries.length <= MAX_BENEFICIARIES, "Too many beneficiaries");

        uint sum = 0;
        for (uint i = 0; i < _beneficiaries.length; i++) {
            address r = _beneficiaries[i];
            require(r != address(0), "Invalid beneficiary");
            require(r.code.length == 0, "Beneficiary must be EOA"); //beneficiaries must remain EOAs and must not be contract-deployed later

            uint16 b = _bps[i];
            require(b > 0, "Zero bps not allowed");
            sum += b;

            // Basic uniqueness check (O(n^2), bounded by MAX_BENEFICIARIES)
            for (uint j = 0; j < i; j++) {
                require(_beneficiaries[j] != r, "Duplicate beneficiary");
            }
        }
        require(sum == BPS_DENOM, "Bps must sum 10000");

        beneficiaries = _beneficiaries;
        beneficiaryBps = _bps;

        bytes32 cfgHash = keccak256(abi.encode(_beneficiaries, _bps));
        emit BeneficiariesSet(cfgHash, _beneficiaries.length);
    }

    function getBeneficiaries() external view returns (address[] memory, uint16[] memory) {
        return (beneficiaries, beneficiaryBps);
    }

    // --- Cancellation ---
    function cancelInheritance() external {
        require(msg.sender == testator, "Only testator can cancel");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");
        require(address(this).balance > 0, "No balance to return");

        inheritanceStatus = Status.Cancelled;

        uint refunded = address(this).balance;
        (bool success, ) = testator.call{value: refunded}("");
        require(success, "Refund failed");

        emit InheritanceCancelled(testator, refunded);
    }

    function claimInheritance() public {
        require(block.timestamp >= lastCheckIn + inactivityPeriod, "Testator is still active");
        require(inheritanceStatus == Status.Active, "Inheritance is not active");
        require(msg.sender == heir, "Only the heir can claim the inheritance");

        inheritanceStatus = Status.Released;

        uint total = address(this).balance;

        // If no splits configured => send all to heir (recovery multisig)
        if (beneficiaries.length == 0) {
            (bool success, ) = payable(heir).call{value: total}("");
            require(success, "Transfer failed");
            emit InheritanceReleased(heir, total);
            return;
        }

        // Split distribution (deterministic)
        uint distributed = 0;

        for (uint i = 0; i < beneficiaries.length; i++) {
            uint amt = (total * beneficiaryBps[i]) / BPS_DENOM;
            distributed += amt;

            (bool ok, ) = payable(beneficiaries[i]).call{value: amt}("");
            require(ok, "Split transfer failed");

            emit SplitPaid(beneficiaries[i], amt);
        }

        // Handle rounding remainder deterministically: give remainder to first beneficiary
        uint rem = total - distributed;
        if (rem > 0) {
            (bool ok2, ) = payable(beneficiaries[0]).call{value: rem}("");
            require(ok2, "Remainder transfer failed");
            emit SplitPaid(beneficiaries[0], rem);
        }

        emit InheritanceReleased(heir, total);
    }

    function getInheritanceDetails() public view returns (address, uint, uint, uint, Status) {
        return (heir, inheritanceAmount, lastCheckIn, createdAt, inheritanceStatus);
    }

    function claimableAt() external view returns (uint) {
        return lastCheckIn + inactivityPeriod;
    }

    function isClaimable() external view returns (bool) {
        return inheritanceStatus == Status.Active
            && heir != address(0)
            && block.timestamp >= lastCheckIn + inactivityPeriod;
    }
}