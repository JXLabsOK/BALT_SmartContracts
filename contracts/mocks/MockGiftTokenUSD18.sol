// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockGiftTokenUSD18 is ERC20 {
    constructor() ERC20("Mock USD18", "MUSD18") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockGiftTokenUSD6 is MockGiftTokenUSD18 {
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

// A fee-on-transfer token to exercise the exact received amount validation.
contract MockGiftTokenFeeOnTransfer is MockGiftTokenUSD18 {
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            uint256 fee = value / 100;
            super._update(from, to, value - fee);
            super._update(from, address(0), fee);
        } else {
            super._update(from, to, value);
        }
    }
}

// A non-standard ERC-20 with no return data on transfer/transferFrom.
contract MockGiftTokenNoReturn {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) { return 18; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
