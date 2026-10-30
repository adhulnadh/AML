// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title UserRegistry
 * @dev Manages user registration, roles, and blacklist status for an
 *      Anti-Money Laundering (AML) demo system.
 *
 * Roles:
 *  - REQUESTER: a user who can request funds
 *  - FUNDER:    a user who can approve/send funds
 *  - ADMIN:     privileged role able to blacklist/whitelist users
 *
 * NOTE: This contract is intended as an educational / prototype building
 * block. A production AML system would additionally need off-chain risk
 * scoring, KYC integration, and should never gate compliance decisions on
 * income level alone.
 */
contract UserRegistry {
    // ---------------------------------------------------------------
    // Enums & Structs
    // ---------------------------------------------------------------

    /// @dev Role assigned to a registered user.
    enum UserRole { NONE, REQUESTER, FUNDER, ADMIN }

    /// @dev Full profile of a registered user.
    struct User {
        string name;
        UserRole role;
        address walletAddress;
        uint256 annualIncome;      // stated annual income, in wei
        bool isRegistered;
        bool isBlacklisted;
        uint256 registrationDate;  // block timestamp of registration
        uint256 totalRequests;     // count of fund requests made
        uint256 totalPayments;     // count of payments made/approved
    }

    // ---------------------------------------------------------------
    // State Variables
    // ---------------------------------------------------------------

    /// @notice Address that deployed the contract and administers the registry.
    address public admin;

    /// @notice Running count of all registered users.
    uint256 public totalUsers;

    /// @notice Maps a wallet address to its full User profile.
    mapping(address => User) public users;

    /// @notice Quick lookup of whether an address has ever registered.
    mapping(address => bool) public registeredAddresses;

    /// @notice Address of the deployed FundRequest contract, authorized to
    ///         increment request counters. Set once by admin after deployment.
    address public fundRequestContract;

    /// @notice Address of the deployed PaymentProcessor contract, authorized
    ///         to increment payment counters. Set once by admin after deployment.
    address public paymentProcessorContract;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    /// @notice Emitted when a new user successfully registers.
    event UserRegistered(address indexed user, string name, UserRole role);

    /// @notice Emitted when an existing user updates their profile.
    event UserUpdated(address indexed user, string name);

    /// @notice Emitted when the admin blacklists a user.
    event UserBlacklisted(address indexed user);

    /// @notice Emitted when the admin removes a user from the blacklist.
    event UserWhitelisted(address indexed user);

    /// @notice Emitted when the admin links a companion contract.
    event AuthorizedContractSet(string contractType, address indexed contractAddress);

    // ---------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------

    /// @dev Restricts a function to the contract admin only.
    modifier onlyAdmin() {
        require(msg.sender == admin, "UserRegistry: caller is not the admin");
        _;
    }

    /// @dev Restricts a function to addresses that are already registered.
    modifier onlyRegistered() {
        require(users[msg.sender].isRegistered, "UserRegistry: caller is not registered");
        _;
    }

    /// @dev Blocks any address currently marked as blacklisted.
    modifier notBlacklisted(address _user) {
        require(!users[_user].isBlacklisted, "UserRegistry: user is blacklisted");
        _;
    }

    /// @dev Restricts a function to the linked FundRequest or
    ///      PaymentProcessor contracts, so only trusted companion contracts
    ///      can mutate a user's request/payment counters.
    modifier onlyAuthorizedContract() {
        require(
            msg.sender == fundRequestContract || msg.sender == paymentProcessorContract,
            "UserRegistry: caller is not an authorized contract"
        );
        _;
    }

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    /// @dev Sets the deploying address as the contract admin.
    constructor() {
        admin = msg.sender;
    }

    // ---------------------------------------------------------------
    // External / Public Functions
    // ---------------------------------------------------------------

    /**
     * @notice Registers the caller as a new user in the system.
     * @param _name Display name of the user. Must not be empty.
     * @param _role Role to assign. Must not be UserRole.NONE.
     * @param _annualIncome Stated annual income, in wei.
     */
    function registerUser(
        string memory _name,
        UserRole _role,
        uint256 _annualIncome
    ) external {
        require(!registeredAddresses[msg.sender], "UserRegistry: address already registered");
        require(bytes(_name).length > 0, "UserRegistry: name cannot be empty");
        require(_role != UserRole.NONE, "UserRegistry: role cannot be NONE");

        users[msg.sender] = User({
            name: _name,
            role: _role,
            walletAddress: msg.sender,
            annualIncome: _annualIncome,
            isRegistered: true,
            isBlacklisted: false,
            registrationDate: block.timestamp,
            totalRequests: 0,
            totalPayments: 0
        });

        registeredAddresses[msg.sender] = true;
        totalUsers += 1;

        emit UserRegistered(msg.sender, _name, _role);
    }

    /**
     * @notice Allows an already-registered, non-blacklisted user to update
     *         their own name and stated annual income.
     * @param _name New display name. Must not be empty.
     * @param _annualIncome New stated annual income, in wei.
     */
    function updateUserProfile(
        string memory _name,
        uint256 _annualIncome
    ) external onlyRegistered notBlacklisted(msg.sender) {
        require(bytes(_name).length > 0, "UserRegistry: name cannot be empty");

        User storage user = users[msg.sender];
        user.name = _name;
        user.annualIncome = _annualIncome;

        emit UserUpdated(msg.sender, _name);
    }

    /**
     * @notice Returns the full profile of a given user.
     * @param _user Address to look up.
     * @return The User struct associated with _user.
     */
    function getUserInfo(address _user) external view returns (User memory) {
        return users[_user];
    }

    /**
     * @notice Checks whether an address is registered.
     * @param _user Address to check.
     * @return True if the address has registered, false otherwise.
     */
    function isUserRegistered(address _user) external view returns (bool) {
        return users[_user].isRegistered;
    }

    /**
     * @notice Returns the role assigned to a user.
     * @param _user Address to check.
     * @return The UserRole of _user (UserRole.NONE if never registered).
     */
    function getUserRole(address _user) external view returns (UserRole) {
        return users[_user].role;
    }

    /**
     * @notice Blacklists a registered user, blocking their further
     *         participation in the system. Admin only.
     * @param _user Address to blacklist.
     */
    function blacklistUser(address _user) external onlyAdmin {
        require(users[_user].isRegistered, "UserRegistry: user not registered");
        require(!users[_user].isBlacklisted, "UserRegistry: user already blacklisted");

        users[_user].isBlacklisted = true;

        emit UserBlacklisted(_user);
    }

    /**
     * @notice Removes a user from the blacklist, restoring their ability
     *         to participate in the system. Admin only.
     * @param _user Address to whitelist.
     */
    function whitelistUser(address _user) external onlyAdmin {
        require(users[_user].isRegistered, "UserRegistry: user not registered");
        require(users[_user].isBlacklisted, "UserRegistry: user is not blacklisted");

        users[_user].isBlacklisted = false;

        emit UserWhitelisted(_user);
    }

    /**
     * @notice Returns the total number of registered users.
     * @return Total user count.
     */
    function getTotalUsers() external view returns (uint256) {
        return totalUsers;
    }

    /**
     * @notice Links the deployed FundRequest contract so it can call
     *         incrementUserRequests. Admin only, intended to be called once
     *         during system setup.
     * @param _fundRequestContract Address of the deployed FundRequest contract.
     */
    function setFundRequestContract(address _fundRequestContract) external onlyAdmin {
        require(_fundRequestContract != address(0), "UserRegistry: invalid address");
        fundRequestContract = _fundRequestContract;
        emit AuthorizedContractSet("FundRequest", _fundRequestContract);
    }

    /**
     * @notice Links the deployed PaymentProcessor contract so it can call
     *         incrementUserPayments. Admin only, intended to be called once
     *         during system setup.
     * @param _paymentProcessorContract Address of the deployed PaymentProcessor contract.
     */
    function setPaymentProcessorContract(address _paymentProcessorContract) external onlyAdmin {
        require(_paymentProcessorContract != address(0), "UserRegistry: invalid address");
        paymentProcessorContract = _paymentProcessorContract;
        emit AuthorizedContractSet("PaymentProcessor", _paymentProcessorContract);
    }

    // ---------------------------------------------------------------
    // Cross-Contract Helpers (called by FundRequest / PaymentProcessor)
    // ---------------------------------------------------------------

    /**
     * @notice Increments a user's total fund-request counter. Callable only
     *         by the linked FundRequest contract.
     * @param _user Address whose request count should be incremented.
     */
    function incrementUserRequests(address _user) external onlyAuthorizedContract {
        require(users[_user].isRegistered, "UserRegistry: user not registered");
        users[_user].totalRequests += 1;
    }

    /**
     * @notice Increments a user's total payments counter. Callable only by
     *         the linked PaymentProcessor contract.
     * @param _user Address whose payment count should be incremented.
     */
    function incrementUserPayments(address _user) external onlyAuthorizedContract {
        require(users[_user].isRegistered, "UserRegistry: user not registered");
        users[_user].totalPayments += 1;
    }
}
