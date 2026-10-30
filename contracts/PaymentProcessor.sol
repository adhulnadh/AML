// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./UserRegistry.sol";
import "./FundRequest.sol";

/**
 * @title PaymentProcessor
 * @dev Handles FUNDER approval/rejection of fund requests and the actual
 *      ETH transfer from FUNDER to REQUESTER. Applies a simple on-chain
 *      AML amount threshold to flag large payments for review.
 *
 * Setup: after deploying UserRegistry, FundRequest, and this contract, the
 * admin must call:
 *   - UserRegistry.setPaymentProcessorContract(address(this))
 *   - FundRequest.setPaymentProcessor(address(this))
 * so this contract is authorized to update registry stats and request state.
 *
 * NOTE: The AML threshold here is a simple static amount check for
 * demonstration purposes. A production AML system would use off-chain risk
 * scoring, behavioral pattern analysis, and sanctions-list checks rather
 * than a single fixed ETH amount, and would not gate compliance on the
 * "wealth" of either party.
 */
contract PaymentProcessor {
    // ---------------------------------------------------------------
    // Structs
    // ---------------------------------------------------------------

    /// @dev Record of a completed or flagged payment.
    struct Payment {
        uint256 paymentId;
        uint256 requestId;
        address funder;
        address requester;
        uint256 amount;
        uint256 timestamp;
        bytes32 txHash;
        bool isSuspicious;
    }

    // ---------------------------------------------------------------
    // State Variables
    // ---------------------------------------------------------------

    /// @notice Running counter used to assign unique payment IDs (1-indexed).
    uint256 public paymentCounter;

    /// @notice Payments strictly above this amount (in wei) are flagged as
    ///         suspicious for compliance review. Defaults to 5 ether.
    uint256 public amlThreshold = 5 ether;

    /// @notice Maps payment ID to its full record.
    mapping(uint256 => Payment) public payments;

    /// @notice Maps a user address (funder or requester) to the payment IDs
    ///         they were involved in.
    mapping(address => uint256[]) public userPayments;

    /// @notice Reference to the deployed UserRegistry contract.
    UserRegistry public userRegistry;

    /// @notice Reference to the deployed FundRequest contract.
    FundRequest public fundRequest;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event PaymentCompleted(
        uint256 indexed paymentId,
        uint256 indexed requestId,
        address funder,
        address requester,
        uint256 amount
    );
    event PaymentFlagged(uint256 indexed paymentId, uint256 amount);
    event ThresholdUpdated(uint256 newThreshold);
    event ApprovalRequiresAdmin(uint256 indexed requestId, uint256 amount);

    /// @notice Emitted when a FUNDER rejects a pending request.
    event RequestRejectedByFunder(uint256 indexed requestId, address indexed funder, string reason);

    // ---------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------

    /// @dev Restricts a function to addresses registered in UserRegistry.
    modifier onlyRegistered() {
        require(userRegistry.isUserRegistered(msg.sender), "PaymentProcessor: caller is not registered");
        _;
    }

    /// @dev Restricts a function to addresses holding the FUNDER role.
    modifier onlyFunder() {
        require(
            userRegistry.getUserRole(msg.sender) == UserRegistry.UserRole.FUNDER,
            "PaymentProcessor: caller is not a funder"
        );
        _;
    }

    /// @dev Blocks any address currently marked as blacklisted in UserRegistry.
    modifier notBlacklisted(address _user) {
        require(!userRegistry.getUserInfo(_user).isBlacklisted, "PaymentProcessor: user is blacklisted");
        _;
    }

    /// @dev Restricts a function to the UserRegistry's admin address, since
    ///      PaymentProcessor does not maintain its own separate admin.
    modifier onlyAdmin() {
        require(msg.sender == userRegistry.admin(), "PaymentProcessor: caller is not the admin");
        _;
    }

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    /**
     * @dev Links this contract to the deployed UserRegistry and FundRequest
     *      instances.
     * @param _userRegistry Address of the deployed UserRegistry contract.
     * @param _fundRequest Address of the deployed FundRequest contract.
     */
    constructor(address _userRegistry, address _fundRequest) {
        require(_userRegistry != address(0), "PaymentProcessor: invalid registry address");
        require(_fundRequest != address(0), "PaymentProcessor: invalid fund request address");
        userRegistry = UserRegistry(_userRegistry);
        fundRequest = FundRequest(_fundRequest);
    }

    // ---------------------------------------------------------------
    // External / Public Functions
    // ---------------------------------------------------------------

    /**
     * @notice Approves a pending fund request and immediately transfers the
     *         attached ETH to the requester. Caller must be a registered,
     *         non-blacklisted FUNDER and must send exactly the requested
     *         amount as msg.value.
     * @param _requestId ID of the request to approve and pay.
     */
    function approveAndPay(uint256 _requestId)
        external
        payable
        onlyRegistered
        onlyFunder
        notBlacklisted(msg.sender)
    {
        FundRequest.FundRequestData memory reqData = fundRequest.getRequest(_requestId);

        require(reqData.status == FundRequest.RequestStatus.PENDING, "PaymentProcessor: request is not pending");
        require(!userRegistry.getUserInfo(reqData.requester).isBlacklisted, "PaymentProcessor: requester is blacklisted");
        require(msg.value == reqData.amount, "PaymentProcessor: sent value does not match requested amount");
        require(address(this).balance >= msg.value, "PaymentProcessor: insufficient contract balance");

        // Mark the request APPROVED, then COMPLETED once funds have moved.
        fundRequest.updateRequestAsApproved(_requestId, msg.sender);

        _processPayment(_requestId, msg.sender, reqData.requester, msg.value);
    }

    /**
     * @notice Rejects a pending fund request. Caller must be a registered,
     *         non-blacklisted FUNDER. No funds are transferred.
     * @param _requestId ID of the request to reject.
     * @param _reason Human-readable reason for the rejection.
     */
    function rejectRequest(uint256 _requestId, string memory _reason)
        external
        onlyRegistered
        onlyFunder
        notBlacklisted(msg.sender)
    {
        fundRequest.updateRequestAsRejected(_requestId, msg.sender, _reason);

        emit RequestRejectedByFunder(_requestId, msg.sender, _reason);
    }

    /**
     * @notice Returns the full record for a given payment.
     * @param _paymentId ID of the payment to look up.
     * @return The Payment struct for _paymentId.
     */
    function getPayment(uint256 _paymentId) external view returns (Payment memory) {
        return payments[_paymentId];
    }

    /**
     * @notice Returns all payment IDs a given user was involved in, either
     *         as funder or requester.
     * @param _user Address to look up.
     * @return Array of payment IDs involving _user.
     */
    function getPaymentsByUser(address _user) external view returns (uint256[] memory) {
        return userPayments[_user];
    }

    /**
     * @notice Returns the total number of payments ever processed.
     * @return Total payment count.
     */
    function getPaymentCount() external view returns (uint256) {
        return paymentCounter;
    }

    /**
     * @notice Updates the AML flagging threshold. Admin only.
     * @param _newThreshold New threshold amount, in wei.
     */
    function setThreshold(uint256 _newThreshold) external onlyAdmin {
        amlThreshold = _newThreshold;
        emit ThresholdUpdated(_newThreshold);
    }

    /**
     * @notice Returns the current AML flagging threshold.
     * @return Current threshold amount, in wei.
     */
    function getThreshold() external view returns (uint256) {
        return amlThreshold;
    }

    // ---------------------------------------------------------------
    // Internal Helpers
    // ---------------------------------------------------------------

    /**
     * @dev Executes the actual ETH transfer, records the Payment, updates
     *      UserRegistry stats, and marks the underlying request COMPLETED.
     *      Assumes the request has already been validated and moved to
     *      APPROVED status by the caller.
     * @param _requestId ID of the request being paid.
     * @param _funder Address sending the funds.
     * @param _requester Address receiving the funds.
     * @param _amount Amount being transferred, in wei.
     */
    function _processPayment(
        uint256 _requestId,
        address _funder,
        address _requester,
        uint256 _amount
    ) internal {
        paymentCounter += 1;
        uint256 paymentId = paymentCounter;
        bool suspicious = _isSuspicious(_amount);

        // Safely forward the ETH to the requester. Using a low-level call
        // (rather than transfer/send) avoids issues with recipients that
        // have gas-sensitive fallback functions, and the return value is
        // checked to ensure the transfer actually succeeded.
        (bool success, ) = payable(_requester).call{value: _amount}("");
        require(success, "PaymentProcessor: ETH transfer to requester failed");

        payments[paymentId] = Payment({
            paymentId: paymentId,
            requestId: _requestId,
            funder: _funder,
            requester: _requester,
            amount: _amount,
            timestamp: block.timestamp,
            txHash: blockhash(block.number - 1),
            isSuspicious: suspicious
        });

        userPayments[_funder].push(paymentId);
        userPayments[_requester].push(paymentId);

        // Update registry-level counters for both parties.
        userRegistry.incrementUserPayments(_funder);
        userRegistry.incrementUserPayments(_requester);

        // Mark the underlying request as fully completed.
        fundRequest.updateRequestAsCompleted(_requestId);

        emit PaymentCompleted(paymentId, _requestId, _funder, _requester, _amount);

        if (suspicious) {
            emit PaymentFlagged(paymentId, _amount);
            emit ApprovalRequiresAdmin(_requestId, _amount);
        }
    }

    /**
     * @dev Determines whether a payment amount exceeds the AML threshold.
     * @param _amount Amount to check, in wei.
     * @return True if the amount is strictly greater than amlThreshold.
     */
    function _isSuspicious(uint256 _amount) internal view returns (bool) {
        return _amount > amlThreshold;
    }
}
