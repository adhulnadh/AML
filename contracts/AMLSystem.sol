// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./UserRegistry.sol";
import "./FundRequest.sol";
import "./PaymentProcessor.sol";

/**
 * @title AMLSystem
 * @dev Central admin contract for the AML demo system. Owns the global
 *      suspicious-amount threshold, maintains an independent blacklist
 *      registry, keeps a running transaction log, and exposes aggregate
 *      system statistics pulled from UserRegistry, FundRequest, and
 *      PaymentProcessor.
 *
 * NOTE: This contract maintains its OWN blacklist (`blacklist` /
 * `blacklistReasons`), separate from UserRegistry's per-user
 * `isBlacklisted` flag. The two are independent by design of the given
 * spec — see the integration note at the bottom of this file for the
 * implications of that split.
 */
contract AMLSystem {
    // ---------------------------------------------------------------
    // Structs
    // ---------------------------------------------------------------

    /// @dev A single logged transaction/event for compliance monitoring.
    struct TransactionLog {
        uint256 id;
        address from;
        address to;
        uint256 amount;
        uint256 timestamp;
        string txType;        // "REQUEST", "PAYMENT", "BLOCK"
        bool isSuspicious;
        string flagReason;
    }

    // ---------------------------------------------------------------
    // State Variables
    // ---------------------------------------------------------------

    /// @notice Address administering this contract.
    address public admin;

    /// @notice Running counter used to assign unique transaction log IDs (1-indexed).
    uint256 public transactionLogCounter;

    /// @notice Amount above which a logged transaction is auto-flagged as
    ///         suspicious. Defaults to 5 ether.
    uint256 public suspiciousThreshold = 5 ether;

    /// @notice Maps transaction log ID to its full record.
    mapping(uint256 => TransactionLog) public transactionLogs;

    /// @notice This contract's own blacklist, independent of UserRegistry's.
    mapping(address => bool) public blacklist;

    /// @notice Reason recorded for each blacklisted address.
    mapping(address => string) public blacklistReasons;

    /// @notice List of all addresses ever blacklisted through this contract.
    address[] public blacklistedAddresses;

    /// @notice Reference to the deployed UserRegistry contract.
    UserRegistry public userRegistry;

    /// @notice Reference to the deployed FundRequest contract.
    FundRequest public fundRequest;

    /// @notice Reference to the deployed PaymentProcessor contract.
    PaymentProcessor public paymentProcessor;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event TransactionLogged(uint256 indexed id, address from, address to, uint256 amount, bool suspicious);
    event AddressBlacklisted(address indexed user, string reason);
    event AddressWhitelisted(address indexed user);
    event ThresholdUpdated(uint256 newThreshold);
    event SuspiciousActivityDetected(uint256 indexed txId, address indexed user, uint256 amount);

    /// @notice Emitted when admin control is transferred to a new address.
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ---------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------

    /// @dev Restricts a function to the contract admin only.
    modifier onlyAdmin() {
        require(msg.sender == admin, "AMLSystem: caller is not the admin");
        _;
    }

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    /**
     * @dev Sets the deploying address as admin and links the three
     *      companion contracts that make up the rest of the system.
     * @param _userRegistry Address of the deployed UserRegistry contract.
     * @param _fundRequest Address of the deployed FundRequest contract.
     * @param _paymentProcessor Address of the deployed PaymentProcessor contract.
     */
    constructor(address _userRegistry, address _fundRequest, address _paymentProcessor) {
        require(_userRegistry != address(0), "AMLSystem: invalid registry address");
        require(_fundRequest != address(0), "AMLSystem: invalid fund request address");
        require(_paymentProcessor != address(0), "AMLSystem: invalid payment processor address");

        admin = msg.sender;
        userRegistry = UserRegistry(_userRegistry);
        fundRequest = FundRequest(_fundRequest);
        paymentProcessor = PaymentProcessor(_paymentProcessor);
    }

    // ---------------------------------------------------------------
    // Threshold Management
    // ---------------------------------------------------------------

    /**
     * @notice Updates the suspicious-amount threshold used when logging
     *         transactions. Admin only.
     * @param _newThreshold New threshold amount, in wei.
     */
    function setThreshold(uint256 _newThreshold) external onlyAdmin {
        suspiciousThreshold = _newThreshold;
        emit ThresholdUpdated(_newThreshold);
    }

    /**
     * @notice Returns the current suspicious-amount threshold.
     * @return Current threshold amount, in wei.
     */
    function getThreshold() external view returns (uint256) {
        return suspiciousThreshold;
    }

    // ---------------------------------------------------------------
    // Blacklist Management
    // ---------------------------------------------------------------

    /**
     * @notice Blacklists an address in this contract's own registry, with
     *         a recorded reason. Admin only. Admin cannot blacklist itself.
     * @param _user Address to blacklist.
     * @param _reason Human-readable reason for the blacklist action.
     */
    function blacklistAddress(address _user, string memory _reason) external onlyAdmin {
        require(_user != admin, "AMLSystem: admin cannot blacklist itself");
        require(_user != address(0), "AMLSystem: invalid address");
        require(!blacklist[_user], "AMLSystem: address already blacklisted");
        require(bytes(_reason).length > 0, "AMLSystem: reason cannot be empty");

        blacklist[_user] = true;
        blacklistReasons[_user] = _reason;
        blacklistedAddresses.push(_user);

        emit AddressBlacklisted(_user, _reason);
    }

    /**
     * @notice Removes an address from this contract's blacklist. Admin only.
     * @param _user Address to whitelist.
     */
    function whitelistAddress(address _user) external onlyAdmin {
        require(blacklist[_user], "AMLSystem: address is not blacklisted");

        blacklist[_user] = false;
        delete blacklistReasons[_user];

        emit AddressWhitelisted(_user);
    }

    /**
     * @notice Checks whether an address is blacklisted in this contract.
     * @param _user Address to check.
     * @return True if blacklisted, false otherwise.
     */
    function isBlacklisted(address _user) external view returns (bool) {
        return blacklist[_user];
    }

    /**
     * @notice Returns the recorded reason for an address's blacklisting.
     * @param _user Address to look up.
     * @return The reason string (empty if never blacklisted or since whitelisted).
     */
    function getBlacklistReason(address _user) external view returns (string memory) {
        return blacklistReasons[_user];
    }

    /**
     * @notice Returns the total number of addresses ever blacklisted
     *         through this contract (including any since whitelisted).
     * @return Count of entries in blacklistedAddresses.
     */
    function getBlacklistCount() external view returns (uint256) {
        return blacklistedAddresses.length;
    }

    /**
     * @notice Returns the full list of addresses ever blacklisted through
     *         this contract.
     * @return Array of addresses.
     */
    function getBlacklistedAddresses() external view returns (address[] memory) {
        return blacklistedAddresses;
    }

    // ---------------------------------------------------------------
    // Transaction Monitoring
    // ---------------------------------------------------------------

    /**
     * @dev Records a transaction/event in the compliance log. Auto-flags
     *      the entry as suspicious if the amount exceeds suspiciousThreshold.
     * @param _from Originating address of the transaction.
     * @param _to Destination address of the transaction.
     * @param _amount Amount involved, in wei.
     * @param _txType Category label: "REQUEST", "PAYMENT", or "BLOCK".
     */
    function logTransaction(
        address _from,
        address _to,
        uint256 _amount,
        string memory _txType
    ) internal {
        transactionLogCounter += 1;
        uint256 logId = transactionLogCounter;
        bool suspicious = _amount > suspiciousThreshold;

        transactionLogs[logId] = TransactionLog({
            id: logId,
            from: _from,
            to: _to,
            amount: _amount,
            timestamp: block.timestamp,
            txType: _txType,
            isSuspicious: suspicious,
            flagReason: suspicious ? "Amount exceeds suspicious threshold" : ""
        });

        emit TransactionLogged(logId, _from, _to, _amount, suspicious);

        if (suspicious) {
            emit SuspiciousActivityDetected(logId, _from, _amount);
        }
    }

    /**
     * @notice Returns the full record for a given transaction log entry.
     * @param _id ID of the log entry to look up.
     * @return The TransactionLog struct for _id.
     */
    function getTransactionLog(uint256 _id) external view returns (TransactionLog memory) {
        return transactionLogs[_id];
    }

    /**
     * @notice Returns every transaction log entry recorded so far.
     * @dev Unbounded loop over transactionLogCounter — fine for a demo /
     *      moderate log size, but on a live system with heavy transaction
     *      volume this should be paginated off-chain instead.
     * @return Array of all TransactionLog entries, oldest first.
     */
    function getAllTransactionLogs() external view returns (TransactionLog[] memory) {
        TransactionLog[] memory allLogs = new TransactionLog[](transactionLogCounter);
        for (uint256 i = 0; i < transactionLogCounter; i++) {
            allLogs[i] = transactionLogs[i + 1];
        }
        return allLogs;
    }

    /**
     * @notice Returns only the transaction log entries flagged as suspicious.
     * @dev Two-pass approach: first counts matches to size the array
     *      correctly, then fills it. Same on-chain-cost caveat as
     *      getAllTransactionLogs applies here.
     * @return Array of suspicious TransactionLog entries, oldest first.
     */
    function getSuspiciousTransactions() external view returns (TransactionLog[] memory) {
        uint256 count = 0;
        for (uint256 i = 1; i <= transactionLogCounter; i++) {
            if (transactionLogs[i].isSuspicious) {
                count++;
            }
        }

        TransactionLog[] memory suspiciousLogs = new TransactionLog[](count);
        uint256 j = 0;
        for (uint256 i = 1; i <= transactionLogCounter; i++) {
            if (transactionLogs[i].isSuspicious) {
                suspiciousLogs[j] = transactionLogs[i];
                j++;
            }
        }
        return suspiciousLogs;
    }

    // ---------------------------------------------------------------
    // System Statistics
    // ---------------------------------------------------------------

    /**
     * @notice Returns a snapshot of aggregate system statistics pulled from
     *         across the whole AML system.
     * @return totalUsers Total registered users (from UserRegistry).
     * @return totalRequests Total fund requests ever created (from FundRequest).
     * @return totalPayments Total payments ever processed (from PaymentProcessor).
     * @return totalSuspicious Total suspicious entries in this contract's transaction log.
     * @return totalBlacklisted Total addresses ever blacklisted through this contract.
     */
    function getSystemStats()
        external
        view
        returns (
            uint256 totalUsers,
            uint256 totalRequests,
            uint256 totalPayments,
            uint256 totalSuspicious,
            uint256 totalBlacklisted
        )
    {
        totalUsers = userRegistry.getTotalUsers();
        totalRequests = fundRequest.getRequestsCount();
        totalPayments = paymentProcessor.getPaymentCount();
        totalBlacklisted = blacklistedAddresses.length;

        for (uint256 i = 1; i <= transactionLogCounter; i++) {
            if (transactionLogs[i].isSuspicious) {
                totalSuspicious++;
            }
        }
    }

    // ---------------------------------------------------------------
    // Admin Management
    // ---------------------------------------------------------------

    /**
     * @notice Transfers admin control of this contract to a new address.
     * @param _newAdmin Address of the new admin. Cannot be the zero address
     *        or the current admin.
     */
    function transferAdmin(address _newAdmin) external onlyAdmin {
        require(_newAdmin != address(0), "AMLSystem: invalid new admin address");
        require(_newAdmin != admin, "AMLSystem: new admin must differ from current admin");

        address previousAdmin = admin;
        admin = _newAdmin;

        emit AdminTransferred(previousAdmin, _newAdmin);
    }
}
