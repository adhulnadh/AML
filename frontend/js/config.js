// frontend/js/config.js
//
// Central configuration for the AML system frontend. Every other frontend
// script should read contract addresses, ABIs, routes, and constants from
// here rather than hardcoding them, so there is exactly one place to update
// when contracts are redeployed or the network changes.
//
// Addresses, network, and ABIs come from frontend/js/deployed.js, which
// scripts/deploy.js regenerates on every deploy (it exposes window.DEPLOYED).
// This file is hand-written and is NEVER overwritten by deploy.js. Every
// page must load deployed.js BEFORE this file.

// ============================================================================
// 1. CONTRACT ADDRESSES
// Auto-filled after deployment. Placeholder zero-addresses until then.
// ============================================================================

const DEPLOYED = (typeof window !== "undefined" && window.DEPLOYED) || null;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const CONTRACT_ADDRESSES = (DEPLOYED && DEPLOYED.addresses) || {
  userRegistry: ZERO_ADDRESS,
  fundRequest: ZERO_ADDRESS,
  paymentProcessor: ZERO_ADDRESS,
  amlSystem: ZERO_ADDRESS,
};

// ============================================================================
// 2. NETWORK CONFIG
// Sepolia testnet by default. Swap these values (and re-point MetaMask) to
// target a different network.
// ============================================================================

const KNOWN_NETWORKS = {
  "0x539": {
    chainId: "0x539", // 1337 -- local Hardhat node (see hardhat.config.js)
    chainName: "Hardhat Localhost",
    rpcUrl: "http://127.0.0.1:8545",
    blockExplorer: "",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },
  "0x7a69": {
    chainId: "0x7a69", // 31337 -- Hardhat's stock default (only if you change hardhat.config.js back)
    chainName: "Hardhat Localhost",
    rpcUrl: "http://127.0.0.1:8545",
    blockExplorer: "",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },
  "0xaa36a7": {
    chainId: "0xaa36a7", // 11155111 -- Sepolia
    chainName: "Sepolia Test Network",
    rpcUrl: "https://sepolia.infura.io/v3/YOUR_KEY", // replace YOUR_KEY
    blockExplorer: "https://sepolia.etherscan.io",
    nativeCurrency: { name: "SepoliaETH", symbol: "ETH", decimals: 18 },
  },
};

// Follows whichever network the last deploy targeted (deployed.js records
// it); falls back to Sepolia if nothing has been deployed yet.
const NETWORK_CONFIG =
  (DEPLOYED && DEPLOYED.network && KNOWN_NETWORKS[DEPLOYED.network.chainIdHex]) ||
  KNOWN_NETWORKS["0xaa36a7"];

// ============================================================================
// 3. CONTRACT ABIs
// Paste the compiled ABI array for each contract below. These are generated
// by Hardhat at:
//   artifacts/contracts/UserRegistry.sol/UserRegistry.json       (.abi field)
//   artifacts/contracts/FundRequest.sol/FundRequest.json         (.abi field)
//   artifacts/contracts/PaymentProcessor.sol/PaymentProcessor.json (.abi field)
//   artifacts/contracts/AMLSystem.sol/AMLSystem.json              (.abi field)
// Re-paste after any change to the corresponding .sol file and recompile.
// ============================================================================

// Filled automatically from deployed.js (compiled artifacts) on every deploy.
const ABIS = (DEPLOYED && DEPLOYED.abis) || {
  userRegistry: [],
  fundRequest: [],
  paymentProcessor: [],
  amlSystem: [],
};

// ============================================================================
// 4. APP CONFIG
// General frontend behavior settings, independent of any one contract.
// ============================================================================

const APP_CONFIG = {
  amlThreshold: 5, // ETH -- display-only mirror of PaymentProcessor.amlThreshold; the on-chain value is the source of truth, fetch it via getThreshold() rather than trusting this number for logic
  pageSize: 10, // rows per page in paginated tables (e.g. monitor.js transaction log)
  refreshInterval: 30000, // ms between polling refreshes (e.g. live feed, stats)
  toastDuration: 4000, // ms a toast notification stays visible before auto-dismissing
};

// ============================================================================
// 5. ROUTES
// Relative paths to each page, for use in nav links and JS redirects
// (e.g. `window.location.href = ROUTES.login`).
// ============================================================================

// Built from the folder the CURRENT page lives in, so redirects always land
// on a sibling page no matter where the site is served from (frontend/ or
// the project root). All five pages sit together in frontend/pages/.
const PAGES_DIR =
  typeof window !== "undefined" ? window.location.pathname.replace(/[^\/]*$/, "") : "";

const ROUTES = {
  login: PAGES_DIR + "page1-login.html",
  request: PAGES_DIR + "page2-user-request.html",
  richLogin: PAGES_DIR + "page3-rich-login.html",
  approve: PAGES_DIR + "page4-approve-payment.html",
  monitor: PAGES_DIR + "page5-monitor.html",
};

// ============================================================================
// 6. ROLES ENUM
// Must match UserRegistry.sol's `enum UserRole { NONE, REQUESTER, FUNDER, ADMIN }`
// ============================================================================

const ROLES = {
  NONE: 0,
  REQUESTER: 1,
  FUNDER: 2,
  ADMIN: 3,
};

// ============================================================================
// 7. REQUEST STATUS ENUM
// Must match FundRequest.sol's
// `enum RequestStatus { PENDING, APPROVED, REJECTED, COMPLETED, CANCELLED }`
// ============================================================================

const REQUEST_STATUS = {
  PENDING: 0,
  APPROVED: 1,
  REJECTED: 2,
  COMPLETED: 3,
  CANCELLED: 4,
};

// ============================================================================
// 8. URGENCY ENUM
// Must match FundRequest.sol's `enum Urgency { LOW, MEDIUM, HIGH }`
// ============================================================================

const URGENCY = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
};

// ============================================================================
// 9. HELPER CONSTANTS
// Display metadata (colors, labels, icons) keyed by the enum values above,
// so pages don't hardcode "if status === 0 -> orange" logic all over the
// place. Colors reference the same hex values as common.css's CSS
// variables -- keep the two in sync if the palette ever changes.
// ============================================================================

const STATUS_LABELS = {
  [REQUEST_STATUS.PENDING]: "Pending",
  [REQUEST_STATUS.APPROVED]: "Approved",
  [REQUEST_STATUS.REJECTED]: "Rejected",
  [REQUEST_STATUS.COMPLETED]: "Completed",
  [REQUEST_STATUS.CANCELLED]: "Cancelled",
};

const STATUS_COLORS = {
  [REQUEST_STATUS.PENDING]: "#f59e0b",   // --color-warning
  [REQUEST_STATUS.APPROVED]: "#6366f1",  // --color-primary
  [REQUEST_STATUS.REJECTED]: "#ef4444",  // --color-danger
  [REQUEST_STATUS.COMPLETED]: "#10b981", // --color-success
  [REQUEST_STATUS.CANCELLED]: "#9ca3af", // --color-gray-400
};

const STATUS_ICONS = {
  [REQUEST_STATUS.PENDING]: "⏳",
  [REQUEST_STATUS.APPROVED]: "✅",
  [REQUEST_STATUS.REJECTED]: "❌",
  [REQUEST_STATUS.COMPLETED]: "🏁",
  [REQUEST_STATUS.CANCELLED]: "🚫",
};

const URGENCY_LABELS = {
  [URGENCY.LOW]: "Low",
  [URGENCY.MEDIUM]: "Medium",
  [URGENCY.HIGH]: "High",
};

const URGENCY_COLORS = {
  [URGENCY.LOW]: "#10b981",    // --color-success
  [URGENCY.MEDIUM]: "#f59e0b", // --color-warning
  [URGENCY.HIGH]: "#ef4444",   // --color-danger
};

const ROLE_LABELS = {
  [ROLES.NONE]: "None",
  [ROLES.REQUESTER]: "Requester",
  [ROLES.FUNDER]: "Funder",
  [ROLES.ADMIN]: "Admin",
};

// ============================================================================
// 10. EXPORTS
// Exposed both as a single aggregate (window.CONFIG) and as individual
// globals, so pages can use whichever is more convenient
// (`CONFIG.ROLES.FUNDER` or just `ROLES.FUNDER`). Also exported via
// CommonJS module.exports so this file can be `require()`-d from Node
// scripts/tests without a bundler.
// ============================================================================

const CONFIG = {
  CONTRACT_ADDRESSES,
  NETWORK_CONFIG,
  ABIS,
  APP_CONFIG,
  ROUTES,
  ROLES,
  REQUEST_STATUS,
  URGENCY,
  STATUS_LABELS,
  STATUS_COLORS,
  STATUS_ICONS,
  URGENCY_LABELS,
  URGENCY_COLORS,
  ROLE_LABELS,
};

if (typeof window !== "undefined") {
  window.CONFIG = CONFIG;
  window.CONTRACT_ADDRESSES = CONTRACT_ADDRESSES;
  window.NETWORK_CONFIG = NETWORK_CONFIG;
  window.ABIS = ABIS;
  window.APP_CONFIG = APP_CONFIG;
  window.ROUTES = ROUTES;
  window.ROLES = ROLES;
  window.REQUEST_STATUS = REQUEST_STATUS;
  window.URGENCY = URGENCY;
  window.STATUS_LABELS = STATUS_LABELS;
  window.STATUS_COLORS = STATUS_COLORS;
  window.STATUS_ICONS = STATUS_ICONS;
  window.URGENCY_LABELS = URGENCY_LABELS;
  window.URGENCY_COLORS = URGENCY_COLORS;
  window.ROLE_LABELS = ROLE_LABELS;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CONFIG,
    CONTRACT_ADDRESSES,
    NETWORK_CONFIG,
    ABIS,
    APP_CONFIG,
    ROUTES,
    ROLES,
    REQUEST_STATUS,
    URGENCY,
    STATUS_LABELS,
    STATUS_COLORS,
    STATUS_ICONS,
    URGENCY_LABELS,
    URGENCY_COLORS,
    ROLE_LABELS,
  };
}
