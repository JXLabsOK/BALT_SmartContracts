// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IBALTRequestTest {
    function createRequests(uint256 _amount, uint64 _expiresAt, uint8 _quantity, string calldata _description) external returns (uint256 batchId, uint256 firstRequestId);
    function payRequest(uint256 _requestId) external payable;
}

contract MockRequestERC20 is ERC20 {
    uint8 private immutable _tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockERC20NoReturn {
    string public name = "Mock No Return";
    string public symbol = "MNRT";
    uint8 public immutable decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 _decimals) {
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "Insufficient balance");

        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "Insufficient allowance");

        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }

        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        emit Transfer(from, to, amount);
    }
}

contract MockERC20FalseReturn {
    mapping(address => mapping(address => uint256)) public allowance;

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract RejectNativeReceiver {
    IBALTRequestTest public immutable baltRequest;

    constructor(address _baltRequest) {
        baltRequest = IBALTRequestTest(_baltRequest);
    }

    function createRequest(uint256 amount, uint64 expiresAt, uint8 quantity, string calldata description) external returns (uint256 batchId, uint256 firstRequestId) {
        return baltRequest.createRequests(amount, expiresAt, quantity, description);
    }

    receive() external payable {
        revert("Native payment rejected");
    }
}

contract ReentrantMerchant {
    IBALTRequestTest public immutable baltRequest;

    uint256 public attackRequestId;
    uint256 public attackAmount;
    bool public attackAttempted;
    bool public attackSucceeded;

    constructor(address _baltRequest) {
        baltRequest = IBALTRequestTest(_baltRequest);
    }

    function createRequest(uint256 amount, uint64 expiresAt, uint8 quantity, string calldata description) external returns (uint256 batchId, uint256 firstRequestId) {
        return baltRequest.createRequests(amount, expiresAt, quantity, description);
    }

    function armAttack(uint256 requestId, uint256 amount) external {
        attackRequestId = requestId;
        attackAmount = amount;
    }

    receive() external payable {
        if (attackRequestId != 0 && !attackAttempted) {
            attackAttempted = true;

            (attackSucceeded, ) = address(baltRequest).call{value: attackAmount}(
                abi.encodeWithSelector(IBALTRequestTest.payRequest.selector, attackRequestId)
            );
        }
    }
}