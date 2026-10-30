// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./UserRegistry.sol";

/**
 * @title FundRequest
 * @dev Handles the lifecycle of money requests created by users holding the
 *      REQUESTER role in UserRegistry, from creation through approval,
 *      rejection, completion, or cancellation.
 *
 * NOTE: This contract only manages request *state*. Actual value transfer
 * is handled by a companion PaymentProcessor contract, which is linked via
 * setPaymentProcessor() and is the only address authorized to call
 * updateRequestAsApproved / updateRequestAsCompleted / updateRequestAsRejected.
 */
contract FundRequest {
    // ---------------------------------------------------------------
    // Enums & Structs
    // ---------------------------------------------------------------

    /// @dev Lifecycle status of a fund request.
    enum RequestStatus { PENDING, APPROVED, REJECTED, COMPLETED, CANCELLED }

    /// @dev Requester-declared urgency level of a request.
    enum Urgency { LOW, MEDIUM, HIGH }

    /// @dev Full record of a single fund request.
    struct FundRequestData {
        uint256 id;
        address requester;
        address funder;             // address(0) until a funder is assigned
        uint256 amount;             // requested amount, in wei
        string purpose;
        Urgency urgency;
        RequestStatus status;
        uint256 createdAt;
        uint256 processedAt;        // timestamp of approval/rejection/completion
        string rejectionReason;
        bool isSuspicious;
    }

    // ---------------------------------------------------------------
    // State Variables
    // ---------------------------------------------------------------

    /// @notice Running counter used to assign unique request IDs (1-indexed).
    uint256 public requestCounter;

    /// @notice Maps request ID to its full record.
    mapping(uint256 => FundRequestData) public requests;

    /// @notice Maps a user address to the list of request IDs they created.
    mapping(address => uint256[]) public userRequests;

    /// @notice List of request IDs currently in PENDING status.
    uint256[] public pendingRequestIds;

    /// @notice Reference to the deployed UserRegistry contract.
    UserRegistry public userRegistry;

    /**
     * @dev Simple on-chain heuristic threshold used to auto-flag unusually
     *      large requests as suspicious. This is a placeholder signal only —
     *      a real AML system would rely on off-chain risk scoring rather
     *      than a single static amount threshold.
     */
    uint256 public constant SUSPICIOUS_AMOUNT_THRESHOLD = 100 ether;

    /// @notice Address of the deployed PaymentProcessor contract, the only
    ///         caller authorized to transition a request through
    ///         APPROVED/REJECTED/COMPLETED. Set once by admin after deployment.
    address public paymentProcessor;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event RequestCreated(uint256 indexed id, address indexed requester, uint256 amount, string purpose);
    event RequestApproved(uint256 indexed id, address indexed funder);
    event RequestRejected(uint256 indexed id, address indexed funder, string reason);
    event RequestCompleted(uint256 indexed id, uint256 amount);
    event RequestCancelled(uint256 indexed id);
    event SuspiciousRequestFlagged(uint256 indexed id, uint256 amount);

    /// @notice Emitted when the admin links the PaymentProcessor contract.
    event PaymentProcessorSet(address indexed paymentProcessor);

    // ---------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------

    /// @dev Restricts a function to addresses registered in UserRegistry.
    modifier onlyRegistered() {
        require(userRegistry.isUserRegistered(msg.sender), "FundRequest: caller is not registered");
        _;
    }

    /// @dev Restricts a function to the original requester of _requestId.
    modifier onlyRequester(uint256 _requestId) {
        require(requests[_requestId].requester == msg.sender, "FundRequest: caller is not the requester");
        _;
    }

    /// @dev Restricts a function to requests currently in PENDING status.
    modifier onlyPending(uint256 _requestId) {
        require(requests[_requestId].status == RequestStatus.PENDING, "FundRequest: request is not pending");
        _;
    }

    /// @dev Restricts a function to the linked PaymentProcessor contract.
    modifier onlyPaymentProcessor() {
        require(msg.sender == paymentProcessor, "FundRequest: caller is not the payment processor");
        _;
    }

    /// @dev Restricts a function to the UserRegistry's admin address, since
    ///      FundRequest does not maintain its own separate admin.
    modifier onlyAdmin() {
        require(msg.sender == userRegistry.admin(), "FundRequest: caller is not the admin");
        _;
    }

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    /**
     * @dev Links this contract to a deployed UserRegistry instance.
     * @param _userRegistryAddress Address of the deployed UserRegistry contract.
     */
    constructor(address _userRegistryAddress) {
        require(_userRegistryAddress != address(0), "FundRequest: invalid registry address");
        userRegistry = UserRegistry(_userRegistryAddress);
    }

    // ---------------------------------------------------------------
    // External / Public Functions
    // ---------------------------------------------------------------

    /**
     * @notice Creates a new fund request on behalf of the caller.
     * @param _amount Requested amount, in wei. Must be greater than zero.
     * @param _purpose Human-readable reason for the request. Must not be empty.
     * @param _urgency Requester-declared urgency level.
     * @return requestId The ID assigned to the newly created request.
     */
    function createRequest(
        uint256 _amount,
        string memory _purpose,
        Urgency _urgency
    ) external onlyRegistered returns (uint256 requestId) {
        require(_amount > 0, "FundRequest: amount must be greater than zero");
        require(bytes(_purpose).length > 0, "FundRequest: purpose cannot be empty");

        requestCounter += 1;
        requestId = requestCounter;

        requests[requestId] = FundRequestData({
            id: requestId,
            requester: msg.sender,
            funder: address(0),
            amount: _amount,
            purpose: _purpose,
            urgency: _urgency,
            status: RequestStatus.PENDING,
            createdAt: block.timestamp,
            processedAt: 0,
            rejectionReason: "",
            isSuspicious: false
        });

        userRequests[msg.sender].push(requestId);
        pendingRequestIds.push(requestId);
        userRegistry.incrementUserRequests(msg.sender);

        emit RequestCreated(requestId, msg.sender, _amount, _purpose);

        // Simple heuristic auto-flag: unusually large requests are marked
        // suspicious for later review. See SUSPICIOUS_AMOUNT_THRESHOLD note above.
        if (_amount >= SUSPICIOUS_AMOUNT_THRESHOLD) {
            flagSuspicious(requestId);
        }
    }

    /**
     * @notice Cancels a pending request. Only the original requester may
     *         cancel, and only while the request is still PENDING.
     * @param _requestId ID of the request to cancel.
     */
    function cancelRequest(uint256 _requestId)
        external
        onlyRequester(_requestId)
        onlyPending(_requestId)
    {
        _updateStatus(_requestId, RequestStatus.CANCELLED);
        _removePendingRequest(_requestId);

        emit RequestCancelled(_requestId);
    }

    /**
     * @notice Returns the full record for a given request.
     * @param _requestId ID of the request to look up.
     * @return The FundRequestData struct for _requestId.
     */
    function getRequest(uint256 _requestId) external view returns (FundRequestData memory) {
        return requests[_requestId];
    }

    /**
     * @notice Returns all request IDs created by a given user.
     * @param _user Address to look up.
     * @return Array of request IDs belonging to _user.
     */
    function getRequestsByUser(address _user) external view returns (uint256[] memory) {
        return userRequests[_user];
    }

    /**
     * @notice Returns all request IDs currently in PENDING status.
     * @return Array of pending request IDs.
     */
    function getPendingRequests() external view returns (uint256[] memory) {
        return pendingRequestIds;
    }

    /**
     * @notice Returns the total number of requests ever created.
     * @return Total request count.
     */
    function getRequestsCount() external view returns (uint256) {
        return requestCounter;
    }

    /**
     * @notice Links the deployed PaymentProcessor contract so it can call
     *         updateRequestAsApproved / Completed / Rejected. Admin only
     *         (delegated to UserRegistry's admin), intended to be called
     *         once during system setup.
     * @param _paymentProcessor Address of the deployed PaymentProcessor contract.
     */
    function setPaymentProcessor(address _paymentProcessor) external onlyAdmin {
        require(_paymentProcessor != address(0), "FundRequest: invalid address");
        paymentProcessor = _paymentProcessor;
        emit PaymentProcessorSet(_paymentProcessor);
    }

    // ---------------------------------------------------------------
    // Cross-Contract Helpers (called by PaymentProcessor)
    // ---------------------------------------------------------------

    /**
     * @dev Updates the status field of a request and stamps processedAt
     *      for any terminal status change.
     * @param _requestId ID of the request to update.
     * @param _status New status to set.
     */
    function _updateStatus(uint256 _requestId, RequestStatus _status) internal {
        requests[_requestId].status = _status;

        if (
            _status == RequestStatus.APPROVED ||
            _status == RequestStatus.REJECTED ||
            _status == RequestStatus.COMPLETED
        ) {
            requests[_requestId].processedAt = block.timestamp;
        }
    }

    /**
     * @dev Removes a request ID from the pendingRequestIds array using
     *      swap-and-pop (order is not preserved, but gas cost is O(n) worst
     *      case for the search and O(1) for the removal itself).
     * @param _requestId ID of the request to remove from the pending list.
     */
    function _removePendingRequest(uint256 _requestId) internal {
        uint256 length = pendingRequestIds.length;
        for (uint256 i = 0; i < length; i++) {
            if (pendingRequestIds[i] == _requestId) {
                pendingRequestIds[i] = pendingRequestIds[length - 1];
                pendingRequestIds.pop();
                break;
            }
        }
    }

    /**
     * @notice Marks a request as APPROVED and assigns the funder. Callable
     *         only by the linked PaymentProcessor contract.
     * @param _requestId ID of the request being approved.
     * @param _funder Address of the user approving/funding the request.
     */
    function updateRequestAsApproved(uint256 _requestId, address _funder)
        external
        onlyPaymentProcessor
        onlyPending(_requestId)
    {
        requests[_requestId].funder = _funder;
        _updateStatus(_requestId, RequestStatus.APPROVED);
        _removePendingRequest(_requestId);

        emit RequestApproved(_requestId, _funder);
    }

    /**
     * @notice Marks an approved request as COMPLETED once payment has been
     *         transferred. Callable only by the linked PaymentProcessor
     *         contract.
     * @param _requestId ID of the request being completed.
     */
    function updateRequestAsCompleted(uint256 _requestId) external onlyPaymentProcessor {
        require(requests[_requestId].status == RequestStatus.APPROVED, "FundRequest: request is not approved");

        _updateStatus(_requestId, RequestStatus.COMPLETED);

        emit RequestCompleted(_requestId, requests[_requestId].amount);
    }

    /**
     * @notice Marks a pending request as REJECTED with a reason. Callable
     *         only by the linked PaymentProcessor contract.
     * @param _requestId ID of the request being rejected.
     * @param _funder Address of the user rejecting the request.
     * @param _reason Human-readable rejection reason.
     */
    function updateRequestAsRejected(
        uint256 _requestId,
        address _funder,
        string memory _reason
    ) external onlyPaymentProcessor onlyPending(_requestId) {
        requests[_requestId].funder = _funder;
        requests[_requestId].rejectionReason = _reason;
        _updateStatus(_requestId, RequestStatus.REJECTED);
        _removePendingRequest(_requestId);

        emit RequestRejected(_requestId, _funder, _reason);
    }

    /**
     * @dev Flags a request as suspicious for later compliance review.
     *      Does not change the request's status.
     * @param _requestId ID of the request to flag.
     */
    function flagSuspicious(uint256 _requestId) internal {
        requests[_requestId].isSuspicious = true;

        emit SuspiciousRequestFlagged(_requestId, requests[_requestId].amount);
    }
}
