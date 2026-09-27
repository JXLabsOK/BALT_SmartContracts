// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BALTRequest {
    address public immutable commissionWallet;
    address public immutable requestAsset;

    uint16 public constant REQUEST_FEE_BPS = 50; // 0.50%
    uint16 public constant BPS_DENOM = 10_000;
    uint8 public constant MAX_BATCH_SIZE = 10;
    uint16 public constant MAX_DESCRIPTION_LENGTH = 160;

    bytes4 private constant TRANSFER_FROM_SELECTOR = 0x23b872dd; // keccak256("transferFrom(address,address,uint256)")

    enum Status { Open, Paid, Cancelled }

    // Public view structure. Kept compatible with the previous ABI.
    struct RequestBatch {
        address merchant;
        uint256 amount;
        uint256 firstRequestId;
        uint64 expiresAt;
        uint8 quantity;
        string description;
    }

    // Public view structure. Kept compatible with the previous ABI.
    struct PaymentRequest {
        uint256 batchId;
        address payer;
        uint64 paidAt;
        Status status;
    }

    // Optimized storage structure.
    // merchant + expiresAt + quantity + cancelledBitmap fit in one storage slot.
    struct RequestBatchData {
        address merchant;
        uint64 expiresAt;
        uint8 quantity;
        uint16 cancelledBitmap;
        uint128 amount;
        string description;
    }

    // payer + paidAt fit in one storage slot.
    // Status is derived from payer + cancelledBitmap.
    struct PaymentRequestData {
        address payer;
        uint64 paidAt;
    }

    // Both counters share one storage slot.
    uint128 private _nextBatchId = 1;
    uint128 private _totalRequests;

    mapping(uint256 => RequestBatchData) private batches;
    mapping(uint256 => PaymentRequestData) private requests;
    mapping(address => uint256[]) private batchIdsByMerchant;

    event RequestBatchCreated(
        uint256 indexed batchId,
        address indexed merchant,
        uint256 indexed firstRequestId,
        uint256 amount,
        uint8 quantity,
        uint64 expiresAt,
        string description
    );

    event RequestPaid(
        uint256 indexed requestId,
        uint256 indexed batchId,
        address indexed payer,
        address merchant,
        uint256 grossAmount,
        uint256 merchantAmount,
        uint256 feeAmount
    );

    event RequestCancelled(
        uint256 indexed requestId,
        uint256 indexed batchId,
        address indexed merchant
    );

    event RequestBatchCancelled(
        uint256 indexed batchId,
        address indexed merchant,
        uint8 cancelledCount
    );

    constructor(address _commissionWallet, address _requestAsset) {
        require(_commissionWallet != address(0), "Invalid commission wallet");

        if (_requestAsset != address(0)) {
            require(_requestAsset.code.length > 0, "Request asset must be contract");
        }

        commissionWallet = _commissionWallet;
        requestAsset = _requestAsset;
    }

    receive() external payable {
        revert("Direct payments not accepted");
    }

    function createRequests(uint256 _amount, uint64 _expiresAt, uint8 _quantity, string calldata _description) external returns (uint256 batchId, uint256 firstRequestId) {
        require(_amount > 0, "Invalid amount");
        require(_amount <= type(uint128).max, "Amount too large");
        require(_quantity > 0 && _quantity <= MAX_BATCH_SIZE, "Invalid quantity");
        require(_expiresAt == 0 || _expiresAt > block.timestamp, "Invalid expiration");
        require(bytes(_description).length <= MAX_DESCRIPTION_LENGTH, "Description too long");

        batchId = uint256(_nextBatchId);
        firstRequestId = _firstRequestId(batchId);

        batches[batchId] = RequestBatchData({
            merchant: msg.sender,
            expiresAt: _expiresAt,
            quantity: _quantity,
            cancelledBitmap: 0,
            amount: uint128(_amount),
            description: _description
        });

        batchIdsByMerchant[msg.sender].push(batchId);

        unchecked {
            _nextBatchId++;
            _totalRequests += uint128(_quantity);
        }

        emit RequestBatchCreated(
            batchId,
            msg.sender,
            firstRequestId,
            _amount,
            _quantity,
            _expiresAt,
            _description
        );
    }

    function payRequest(uint256 _requestId) external payable {
        (uint256 batchId, uint16 requestMask) = _resolveRequest(_requestId);

        RequestBatchData storage batch = batches[batchId];
        PaymentRequestData storage paymentRequest = requests[_requestId];

        require(paymentRequest.payer == address(0) && (batch.cancelledBitmap & requestMask) == 0, "Request is not open");
        require(batch.expiresAt == 0 || block.timestamp <= batch.expiresAt, "Request expired");

        uint256 grossAmount = uint256(batch.amount);

        if (requestAsset == address(0)) {
            require(msg.value == grossAmount, "Incorrect payment amount");
        } else {
            require(msg.value == 0, "Native value not accepted");
        }

        uint256 feeAmount = calculateFee(grossAmount);
        uint256 merchantAmount = grossAmount - feeAmount;

        requests[_requestId] = PaymentRequestData({
            payer: msg.sender,
            paidAt: uint64(block.timestamp)
        });

        if (requestAsset == address(0)) {
            _safeNativeTransfer(batch.merchant, merchantAmount);

            if (feeAmount > 0) {
                _safeNativeTransfer(commissionWallet, feeAmount);
            }
        } else {
            _safeTransferFrom(requestAsset, msg.sender, batch.merchant, merchantAmount);

            if (feeAmount > 0) {
                _safeTransferFrom(requestAsset, msg.sender, commissionWallet, feeAmount);
            }
        }

        emit RequestPaid(
            _requestId,
            batchId,
            msg.sender,
            batch.merchant,
            grossAmount,
            merchantAmount,
            feeAmount
        );
    }

    function cancelRequest(uint256 _requestId) external {
        (uint256 batchId, uint16 requestMask) = _resolveRequest(_requestId);

        RequestBatchData storage batch = batches[batchId];
        PaymentRequestData storage paymentRequest = requests[_requestId];

        require(msg.sender == batch.merchant, "Only merchant");
        require(paymentRequest.payer == address(0) && (batch.cancelledBitmap & requestMask) == 0, "Request is not open");

        batch.cancelledBitmap |= requestMask;

        emit RequestCancelled(_requestId, batchId, msg.sender);
    }

    function cancelBatch(uint256 _batchId) external {
        RequestBatchData storage batch = batches[_batchId];

        require(batch.merchant != address(0), "Batch not found");
        require(msg.sender == batch.merchant, "Only merchant");

        uint16 newBitmap = batch.cancelledBitmap;
        uint256 firstRequestId = _firstRequestId(_batchId);
        uint8 cancelledCount = 0;

        for (uint8 i = 0; i < batch.quantity; ) {
            uint16 requestMask = uint16(uint256(1) << i);
            uint256 requestId = firstRequestId + uint256(i);

            if ((newBitmap & requestMask) == 0 && requests[requestId].payer == address(0)) {
                newBitmap |= requestMask;

                unchecked {
                    cancelledCount++;
                }
            }

            unchecked {
                i++;
            }
        }

        require(cancelledCount > 0, "No open requests");

        batch.cancelledBitmap = newBitmap;

        emit RequestBatchCancelled(_batchId, msg.sender, cancelledCount);
    }

    function calculateFee(uint256 _amount) public pure returns (uint256) {
        return (_amount * REQUEST_FEE_BPS) / BPS_DENOM;
    }

    function getRequest(uint256 _requestId) external view returns (PaymentRequest memory paymentRequest, RequestBatch memory batch) {
        (uint256 batchId, uint16 requestMask) = _resolveRequest(_requestId);

        RequestBatchData storage batchData = batches[batchId];
        PaymentRequestData storage paymentData = requests[_requestId];

        Status status = Status.Open;

        if (paymentData.payer != address(0)) {
            status = Status.Paid;
        } else if ((batchData.cancelledBitmap & requestMask) != 0) {
            status = Status.Cancelled;
        }

        paymentRequest = PaymentRequest({
            batchId: batchId,
            payer: paymentData.payer,
            paidAt: paymentData.paidAt,
            status: status
        });

        batch = _buildBatch(batchId, batchData);
    }

    function getBatch(uint256 _batchId) external view returns (RequestBatch memory) {
        RequestBatchData storage batch = batches[_batchId];

        require(batch.merchant != address(0), "Batch not found");

        return _buildBatch(_batchId, batch);
    }

    function isExpired(uint256 _requestId) external view returns (bool) {
        (uint256 batchId, ) = _resolveRequest(_requestId);

        uint64 expiresAt = batches[batchId].expiresAt;

        return expiresAt != 0 && block.timestamp > expiresAt;
    }

    function nextBatchId() external view returns (uint256) {
        return uint256(_nextBatchId);
    }

    function nextRequestId() external view returns (uint256) {
        return _firstRequestId(uint256(_nextBatchId));
    }

    function batchIdsByMerchantCount(address _merchant) external view returns (uint256) {
        return batchIdsByMerchant[_merchant].length;
    }

    function getBatchIdsByMerchantSlice(address _merchant, uint256 _offset, uint256 _limit) external view returns (uint256[] memory out) {
        uint256[] storage merchantBatches = batchIdsByMerchant[_merchant];
        uint256 count = merchantBatches.length;

        if (_offset >= count) {
            return new uint256[](0);
        }

        uint256 remaining = count - _offset;
        uint256 resultCount = _limit > remaining ? remaining : _limit;

        out = new uint256[](resultCount);

        for (uint256 i = 0; i < resultCount; ) {
            out[i] = merchantBatches[_offset + i];

            unchecked {
                i++;
            }
        }
    }

    function totalBatches() external view returns (uint256) {
        return uint256(_nextBatchId) - 1;
    }

    function totalRequests() external view returns (uint256) {
        return uint256(_totalRequests);
    }

    function _firstRequestId(uint256 _batchId) internal pure returns (uint256) {
        return ((_batchId - 1) * uint256(MAX_BATCH_SIZE)) + 1;
    }

    function _resolveRequest(uint256 _requestId) internal view returns (uint256 batchId, uint16 requestMask) {
        require(_requestId > 0, "Request not found");

        uint256 zeroBasedRequestId = _requestId - 1;
        batchId = (zeroBasedRequestId / uint256(MAX_BATCH_SIZE)) + 1;

        RequestBatchData storage batch = batches[batchId];

        require(batch.merchant != address(0), "Request not found");

        uint256 requestIndex = zeroBasedRequestId % uint256(MAX_BATCH_SIZE);

        require(requestIndex < batch.quantity, "Request not found");

        requestMask = uint16(uint256(1) << requestIndex);
    }

    function _buildBatch(uint256 _batchId, RequestBatchData storage _batch) internal view returns (RequestBatch memory) {
        return RequestBatch({
            merchant: _batch.merchant,
            amount: uint256(_batch.amount),
            firstRequestId: _firstRequestId(_batchId),
            expiresAt: _batch.expiresAt,
            quantity: _batch.quantity,
            description: _batch.description
        });
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