// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BALTDirectPayment {
    address public immutable commissionWallet;
    address public immutable paymentAsset;

    uint16 public constant DIRECT_PAYMENT_FEE_BPS = 35; // 0.35%
    uint16 public constant BPS_DENOM = 10_000;

    bytes4 private constant TRANSFER_FROM_SELECTOR = 0x23b872dd; // keccak256("transferFrom(address,address,uint256)")

    event PaymentExecuted(
        address indexed payer,
        address indexed recipient,
        uint256 amount,
        uint256 feeAmount
    );

    constructor(address _commissionWallet, address _paymentAsset) {
        require(_commissionWallet != address(0), "Invalid commission wallet");

        if (_paymentAsset != address(0)) {
            require(_paymentAsset.code.length > 0, "Payment asset must be contract");
        }

        commissionWallet = _commissionWallet;
        paymentAsset = _paymentAsset;
    }

    receive() external payable {
        revert("Direct transfer not accepted");
    }

    function pay(address _recipient, uint256 _amount) external payable {
        require(_recipient != address(0) && _recipient != address(this), "Invalid recipient");
        require(_amount > 0, "Invalid amount");

        uint256 feeAmount = calculateFee(_amount);
        uint256 totalAmount = _amount + feeAmount;

        if (paymentAsset == address(0)) {
            require(msg.value == totalAmount, "Incorrect payment amount");

            _safeNativeTransfer(_recipient, _amount);

            if (feeAmount > 0) {
                _safeNativeTransfer(commissionWallet, feeAmount);
            }
        } else {
            require(msg.value == 0, "Native value not accepted");

            _safeTransferFrom(paymentAsset, msg.sender, _recipient, _amount);

            if (feeAmount > 0) {
                _safeTransferFrom(paymentAsset, msg.sender, commissionWallet, feeAmount);
            }
        }

        emit PaymentExecuted(
            msg.sender,
            _recipient,
            _amount,
            feeAmount
        );
    }

    function calculateFee(uint256 _amount) public pure returns (uint256) {
        return (_amount * DIRECT_PAYMENT_FEE_BPS) / BPS_DENOM;
    }

    function _safeNativeTransfer(address _to, uint256 _amount) internal {
        (bool success, ) = payable(_to).call{value: _amount}("");
        require(success, "Native transfer failed");
    }

    function _safeTransferFrom(address _token, address _from, address _to, uint256 _amount) internal {
        (bool success, bytes memory data) = _token.call(
            abi.encodeWithSelector(TRANSFER_FROM_SELECTOR, _from, _to, _amount)
        );

        require(success, "Token transferFrom failed");

        if (data.length > 0) {
            require(abi.decode(data, (bool)), "Token transferFrom returned false");
        }
    }
}