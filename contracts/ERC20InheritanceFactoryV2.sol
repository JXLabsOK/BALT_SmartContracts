// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ERC20InheritanceVaultV2.sol";

contract ERC20InheritanceFactoryV2 {
    address public immutable commissionWallet;
    address public immutable token;        // ERC-20 token used by this factory
    uint16  public immutable feeBps;       // e.g. 50 (0.5%)
    uint256 public immutable minDeposit;   // minimum deposit in token units

    address[] public allVaults;
    mapping(address => address[]) public vaultsByTestator;

    event VaultCreated(address indexed testator, address vaultAddress);

    function _isContract(address a) private view returns (bool) {
        uint256 size;
        assembly { size := extcodesize(a) }
        return size > 0;
    }

    constructor(address _commissionWallet, address _token, uint16  _feeBps, uint256 _minDeposit
    ) {
        require(_commissionWallet != address(0), "Invalid commission wallet");
        require(_token != address(0), "Invalid token");
        require(_feeBps < 10_000, "fee too high");
        require(_isContract(_token), "Token not a contract");
        
        commissionWallet = _commissionWallet;
        token = _token;
        feeBps = _feeBps;
        minDeposit = _minDeposit;
    }

    function createInheritanceVault(uint inactivityPeriod) external returns (address) {
        require(inactivityPeriod > 0, "Invalid inactivity");

        ERC20InheritanceVaultV2 vault = new ERC20InheritanceVaultV2(
            msg.sender,
            inactivityPeriod,
            commissionWallet,
            token,
            feeBps,
            minDeposit
        );
        address v = address(vault);
        allVaults.push(v);
        vaultsByTestator[msg.sender].push(v);

        emit VaultCreated(msg.sender, v);
        return v;
    }
    
    function getVaultsByTestator(address testator) external view returns (address[] memory) {
        return vaultsByTestator[testator];
    }

    function getAllVaults() external view returns (address[] memory) {
        return allVaults;
    }
    
    function factoryStaticParams()
        external
        view
        returns (address _token, uint16 _feeBps, uint256 _minDeposit)
    {
        return (token, feeBps, minDeposit);
    }
}
