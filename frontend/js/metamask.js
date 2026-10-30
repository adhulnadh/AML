// frontend/js/metamask.js
//
// Shared MetaMask / ethers.js wallet helper for the AML system frontend.
// Exposes a single global `window.Wallet` object used by every page's own
// script (page1-login.js, page2-request.js, etc.) so wallet connection,
// contract access, and UI feedback (toast/modal/loading) all go through one
// consistent implementation instead of being duplicated per page.
//
// DEPENDENCIES (must be loaded, in this order, BEFORE this script):
//   1. ethers.js v5 UMD build:
//      <script src="https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js"></script>
//   2. config.js (defines window.CONFIG -- addresses, ABIs, network, routes)
//
// Example page wiring:
//   <script src="https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js"></script>
//   <script src="js/config.js"></script>
//   <script src="js/metamask.js"></script>
//   <script src="js/page1-login.js"></script>

(function (window) {
  "use strict";

  // ==========================================================================
  // 0. GUARDS & INTERNAL STATE
  // ==========================================================================

  if (typeof window.ethers === "undefined") {
    console.error(
      "[Wallet] ethers.js was not found on window. Make sure the ethers v5 " +
        "CDN script is loaded BEFORE metamask.js."
    );
  }

  if (typeof window.CONFIG === "undefined") {
    console.error(
      "[Wallet] window.CONFIG was not found. Make sure config.js is loaded " +
        "BEFORE metamask.js."
    );
  }

  // Internal, module-scoped connection state. Not exposed directly -- use
  // the getProvider()/getSigner()/getAddress() accessors below, which also
  // lazily initialize the provider if MetaMask is present but connect()
  // hasn't been explicitly called yet (e.g. on page reload).
  const state = {
    provider: null,
    signer: null,
    address: null,
    chainId: null,
  };

  // localStorage keys, namespaced to avoid collisions with anything else
  // that might use the same origin.
  const STORAGE_KEYS = {
    user: "aml_system:user", // { address, role, name }
  };

  // ==========================================================================
  // 1. isMetaMaskInstalled()
  // ==========================================================================

  /**
   * Checks whether a MetaMask-compatible provider is available in this
   * browser.
   * @returns {boolean}
   */
  function isMetaMaskInstalled() {
    return typeof window.ethereum !== "undefined" && !!window.ethereum.isMetaMask;
  }

  // ==========================================================================
  // 2. checkNetwork()
  // ==========================================================================

  /**
   * Checks whether MetaMask is currently on the network configured in
   * CONFIG.NETWORK_CONFIG. If it is not, prompts the user to switch via
   * switchNetwork().
   * @returns {Promise<boolean>} True if already on (or successfully switched
   *   to) the correct network; false otherwise.
   */
  async function checkNetwork() {
    if (!isMetaMaskInstalled()) {
      showToast("MetaMask is not installed.", "error");
      return false;
    }

    try {
      const currentChainId = await window.ethereum.request({ method: "eth_chainId" });
      state.chainId = currentChainId;

      const expectedChainId = window.CONFIG.NETWORK_CONFIG.chainId;

      if (currentChainId.toLowerCase() === expectedChainId.toLowerCase()) {
        return true;
      }

      showToast(
        `Wrong network detected. Switching to ${window.CONFIG.NETWORK_CONFIG.chainName}...`,
        "warning"
      );
      return await switchNetwork();
    } catch (error) {
      handleError("checkNetwork", error);
      return false;
    }
  }

  // ==========================================================================
  // 3. switchNetwork()
  // ==========================================================================

  /**
   * Requests that MetaMask switch to the network configured in
   * CONFIG.NETWORK_CONFIG. If the network has never been added to the
   * user's MetaMask, falls back to requesting that it be added.
   * @returns {Promise<boolean>} True on success, false on failure/rejection.
   */
  async function switchNetwork() {
    if (!isMetaMaskInstalled()) {
      showToast("MetaMask is not installed.", "error");
      return false;
    }

    const network = window.CONFIG.NETWORK_CONFIG;

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: network.chainId }],
      });
      state.chainId = network.chainId;
      return true;
    } catch (switchError) {
      // Error code 4902 = the chain has not been added to MetaMask yet.
      if (switchError && switchError.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: network.chainId,
                chainName: network.chainName,
                rpcUrls: [network.rpcUrl],
                blockExplorerUrls: [network.blockExplorer],
                nativeCurrency: network.nativeCurrency,
              },
            ],
          });
          state.chainId = network.chainId;
          return true;
        } catch (addError) {
          handleError("switchNetwork (add chain)", addError);
          return false;
        }
      }

      handleError("switchNetwork", switchError);
      return false;
    }
  }

  // ==========================================================================
  // 4. connect()
  // ==========================================================================

  /**
   * Requests account access from MetaMask, initializes the ethers provider
   * and signer, and verifies the connected network. This is the main entry
   * point pages should call from a "Connect MetaMask" button handler.
   * @returns {Promise<{address: string, signer: object, provider: object} | null>}
   *   Null if connection failed or was rejected.
   */
  async function connect() {
    if (!isMetaMaskInstalled()) {
      showToast("Please install MetaMask to continue.", "error");
      return null;
    }

    try {
      showLoading("Connecting to MetaMask...");

      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (!accounts || accounts.length === 0) {
        throw new Error("No accounts returned by MetaMask.");
      }

      state.provider = new window.ethers.providers.Web3Provider(window.ethereum, "any");
      state.signer = state.provider.getSigner();
      state.address = accounts[0];

      const networkOk = await checkNetwork();
      if (!networkOk) {
        hideLoading();
        showToast("Please switch to the correct network to continue.", "error");
        return null;
      }

      hideLoading();
      showToast("Wallet connected.", "success");

      return { address: state.address, signer: state.signer, provider: state.provider };
    } catch (error) {
      hideLoading();
      handleError("connect", error);
      return null;
    }
  }

  // ==========================================================================
  // 5. getProvider()
  // ==========================================================================

  /**
   * Returns the current ethers Web3Provider, lazily creating one from
   * window.ethereum if connect() hasn't been called yet in this page's
   * lifetime (e.g. MetaMask is already authorized from a previous visit).
   * @returns {object|null} An ethers.providers.Web3Provider, or null if
   *   MetaMask is unavailable.
   */
  function getProvider() {
    if (state.provider) {
      return state.provider;
    }

    if (isMetaMaskInstalled()) {
      state.provider = new window.ethers.providers.Web3Provider(window.ethereum, "any");
      return state.provider;
    }

    return null;
  }

  // ==========================================================================
  // 6. getSigner()
  // ==========================================================================

  /**
   * Returns the current ethers Signer, lazily deriving it from getProvider()
   * if necessary.
   * @returns {object|null} An ethers.Signer, or null if unavailable.
   */
  function getSigner() {
    if (state.signer) {
      return state.signer;
    }

    const provider = getProvider();
    if (provider) {
      state.signer = provider.getSigner();
      return state.signer;
    }

    return null;
  }

  // ==========================================================================
  // 7. getAddress()
  // ==========================================================================

  /**
   * Returns the currently connected wallet address, if known.
   * @returns {string|null}
   */
  function getAddress() {
    return state.address;
  }

  // ==========================================================================
  // 8. disconnect()
  // ==========================================================================

  /**
   * Clears local connection state and any stored user profile.
   * NOTE: MetaMask itself has no programmatic "disconnect" API -- this only
   * clears this app's own notion of the connected session. The user may
   * still be able to silently reconnect via eth_accounts unless they also
   * revoke the site's permission from within MetaMask.
   */
  function disconnect() {
    state.provider = null;
    state.signer = null;
    state.address = null;
    state.chainId = null;
    clearUser();
    showToast("Wallet disconnected.", "info");
  }

  // ==========================================================================
  // 9. onAccountChange(callback)
  // ==========================================================================

  /**
   * Registers a callback fired whenever the user switches accounts in
   * MetaMask. Also updates internal state.address automatically before
   * invoking the callback.
   * @param {(accounts: string[]) => void} callback
   */
  function onAccountChange(callback) {
    if (!isMetaMaskInstalled()) return;

    window.ethereum.on("accountsChanged", (accounts) => {
      state.address = accounts.length > 0 ? accounts[0] : null;
      if (!state.address) {
        clearUser();
      }
      if (typeof callback === "function") {
        callback(accounts);
      }
    });
  }

  // ==========================================================================
  // 10. onChainChange(callback)
  // ==========================================================================

  /**
   * Registers a callback fired whenever the user switches networks in
   * MetaMask. Per MetaMask's own guidance, most dApps should simply reload
   * the page on chain change -- the provided callback can do that, or
   * handle it more gracefully.
   * @param {(chainId: string) => void} callback
   */
  function onChainChange(callback) {
    if (!isMetaMaskInstalled()) return;

    window.ethereum.on("chainChanged", (chainId) => {
      state.chainId = chainId;
      if (typeof callback === "function") {
        callback(chainId);
      }
    });
  }

  // ==========================================================================
  // 11. getBalance(address)
  // ==========================================================================

  /**
   * Fetches the native ETH balance of an address, formatted as a string.
   * @param {string} address
   * @returns {Promise<string|null>} Balance in ETH (e.g. "1.5"), or null on error.
   */
  async function getBalance(address) {
    try {
      const provider = getProvider();
      if (!provider) {
        throw new Error("No provider available.");
      }
      const balanceWei = await provider.getBalance(address);
      return window.ethers.utils.formatEther(balanceWei);
    } catch (error) {
      handleError("getBalance", error);
      return null;
    }
  }

  // ==========================================================================
  // 12. formatAddress(addr)
  // ==========================================================================

  /**
   * Shortens a full address for display, e.g. "0x1234...5678".
   * @param {string} addr
   * @returns {string}
   */
  function formatAddress(addr) {
    if (!addr || typeof addr !== "string" || addr.length < 10) {
      return addr || "";
    }
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  // ==========================================================================
  // 13. formatETH(wei)
  // ==========================================================================

  /**
   * Formats a wei value (BigNumber, string, or number) as a human-readable
   * ETH string, e.g. "1.5 ETH".
   * @param {*} wei
   * @returns {string}
   */
  function formatETH(wei) {
    try {
      const formatted = window.ethers.utils.formatEther(wei);
      // Trim trailing zeros beyond 4 decimal places for readability, without
      // rounding away meaningful precision for very small amounts.
      const trimmed = parseFloat(formatted).toFixed(4).replace(/\.?0+$/, "");
      return `${trimmed === "" ? "0" : trimmed} ETH`;
    } catch (error) {
      handleError("formatETH", error);
      return "0 ETH";
    }
  }

  // ==========================================================================
  // 14. parseETH(amount)
  // ==========================================================================

  /**
   * Parses a human-entered ETH amount (string or number) into a wei
   * BigNumber suitable for passing to a contract call.
   * @param {string|number} amount
   * @returns {object|null} An ethers.BigNumber, or null if parsing failed.
   */
  function parseETH(amount) {
    try {
      return window.ethers.utils.parseEther(amount.toString());
    } catch (error) {
      handleError("parseETH", error);
      showToast("Invalid ETH amount entered.", "error");
      return null;
    }
  }

  // ==========================================================================
  // 15. getContract(name, signerOrProvider)
  // ==========================================================================

  /**
   * Builds an ethers.Contract instance for one of the four system contracts,
   * using the address and ABI registered in CONFIG.
   * @param {"userRegistry"|"fundRequest"|"paymentProcessor"|"amlSystem"} name
   * @param {object} [signerOrProvider] Defaults to getSigner() if omitted --
   *   pass getProvider() explicitly for read-only calls that shouldn't
   *   prompt a wallet connection.
   * @returns {object|null} An ethers.Contract, or null if config/signer is missing.
   */
  function getContract(name, signerOrProvider) {
    const address = window.CONFIG.CONTRACT_ADDRESSES[name];
    const abi = window.CONFIG.ABIS[name];

    if (!address || address === "0x0000000000000000000000000000000000000000") {
      showToast(`Contract address for "${name}" is not configured yet.`, "error");
      return null;
    }

    if (!abi || abi.length === 0) {
      showToast(`ABI for "${name}" is not configured yet.`, "error");
      return null;
    }

    const runner = signerOrProvider || getSigner() || getProvider();
    if (!runner) {
      showToast("No wallet connection available to build contract instance.", "error");
      return null;
    }

    try {
      return new window.ethers.Contract(address, abi, runner);
    } catch (error) {
      handleError("getContract", error);
      return null;
    }
  }

  // ==========================================================================
  // 16. showToast(message, type)
  // ==========================================================================

  /**
   * Displays a toast notification. Lazily creates the .toast-container if
   * one does not already exist on the page. Styling comes from common.css's
   * .toast / .toast-success / .toast-error / .toast-warning / .toast-info
   * classes.
   * @param {string} message
   * @param {"success"|"error"|"warning"|"info"} [type="info"]
   */
  function showToast(message, type) {
    type = type || "info";

    let container = document.querySelector(".toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "toast-container";
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    const iconMap = { success: "✓", error: "✕", warning: "!", info: "i" };

    toast.innerHTML = `
      <span class="toast-icon">${iconMap[type] || iconMap.info}</span>
      <span class="toast-message"></span>
      <button class="toast-close" aria-label="Dismiss">&times;</button>
    `;
    // Set message via textContent (not innerHTML) to avoid injecting
    // unescaped user-controlled strings into the DOM.
    toast.querySelector(".toast-message").textContent = message;

    const duration =
      (window.CONFIG && window.CONFIG.APP_CONFIG && window.CONFIG.APP_CONFIG.toastDuration) ||
      4000;

    const removeToast = () => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 200);
    };

    toast.querySelector(".toast-close").addEventListener("click", removeToast);
    const timer = setTimeout(removeToast, duration);
    toast.addEventListener("mouseenter", () => clearTimeout(timer));

    container.appendChild(toast);
  }

  // ==========================================================================
  // 17. showLoading(text) / hideLoading()
  // ==========================================================================

  /**
   * Shows a full-page loading overlay with a spinner. Styling comes from
   * common.css's .spinner-overlay / .spinner classes.
   * @param {string} [text="Loading..."]
   */
  function showLoading(text) {
    hideLoading(); // avoid stacking multiple overlays

    const overlay = document.createElement("div");
    overlay.className = "spinner-overlay";
    overlay.id = "wallet-loading-overlay";
    overlay.innerHTML = `
      <div class="flex flex-col items-center gap-3">
        <div class="spinner spinner-lg"></div>
        <span class="text-muted"></span>
      </div>
    `;
    overlay.querySelector("span").textContent = text || "Loading...";

    document.body.appendChild(overlay);
  }

  /**
   * Removes the loading overlay created by showLoading(), if present.
   */
  function hideLoading() {
    const overlay = document.getElementById("wallet-loading-overlay");
    if (overlay) {
      overlay.remove();
    }
  }

  // ==========================================================================
  // 18. showModal(title, content) / hideModal()
  // ==========================================================================

  /**
   * Shows a generic modal dialog. Styling comes from common.css's
   * .modal-overlay / .modal / .modal-header / .modal-body classes.
   * @param {string} title
   * @param {string|Node} content Either an HTML string or a DOM node to
   *   insert into the modal body. String content is inserted as HTML, so
   *   only pass trusted/static markup -- never raw user input.
   */
  function showModal(title, content) {
    hideModal(); // only one modal at a time

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "wallet-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal";

    const header = document.createElement("div");
    header.className = "modal-header";
    header.innerHTML = `<h3></h3><button class="modal-close" aria-label="Close">&times;</button>`;
    header.querySelector("h3").textContent = title;
    header.querySelector(".modal-close").addEventListener("click", hideModal);

    const body = document.createElement("div");
    body.className = "modal-body";
    if (typeof content === "string") {
      body.innerHTML = content;
    } else if (content instanceof Node) {
      body.appendChild(content);
    }

    modal.appendChild(header);
    modal.appendChild(body);
    overlay.appendChild(modal);

    // Clicking the overlay itself (not the modal content) closes it.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) hideModal();
    });

    document.body.appendChild(overlay);
  }

  /**
   * Removes the modal created by showModal(), if present.
   */
  function hideModal() {
    const overlay = document.getElementById("wallet-modal-overlay");
    if (overlay) {
      overlay.remove();
    }
  }

  // ==========================================================================
  // 19. requireConnection()
  // ==========================================================================

  /**
   * Guards a page that requires an active wallet connection + stored user
   * profile. Redirects to the login page if either is missing. Intended to
   * be called at the top of every protected page's own script.
   * @returns {boolean} True if the connection requirement is satisfied
   *   (page can proceed); false if a redirect was triggered.
   */
  function requireConnection() {
    const user = getStoredUser();

    if (!user || !user.address) {
      showToast("Please connect your wallet to continue.", "warning");
      window.location.href = window.CONFIG.ROUTES.login;
      return false;
    }

    return true;
  }

  // ==========================================================================
  // 20. getStoredUser()
  // ==========================================================================

  /**
   * Reads the locally stored user profile.
   * @returns {{address: string, role: number, name: string}|null}
   */
  function getStoredUser() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.user);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      handleError("getStoredUser", error);
      return null;
    }
  }

  // ==========================================================================
  // 21. storeUser(data)
  // ==========================================================================

  /**
   * Persists a user profile to localStorage.
   * @param {{address: string, role: number, name: string}} data
   */
  function storeUser(data) {
    try {
      localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(data));
    } catch (error) {
      handleError("storeUser", error);
    }
  }

  // ==========================================================================
  // 22. clearUser()
  // ==========================================================================

  /**
   * Removes the stored user profile from localStorage.
   */
  function clearUser() {
    try {
      localStorage.removeItem(STORAGE_KEYS.user);
    } catch (error) {
      handleError("clearUser", error);
    }
  }

  // ==========================================================================
  // INTERNAL: centralized error handling
  // Every public function above routes unexpected errors through here so
  // every failure surfaces consistently as both a console entry (for
  // debugging) and a toast (for the user), per the requirement that every
  // error shows a toast.
  // ==========================================================================

  function handleError(context, error) {
    const message = (error && (error.message || error.reason)) || "An unexpected error occurred.";

    // MetaMask's standard user-rejection error code -- worth a friendlier
    // message than the raw provider error text.
    if (error && (error.code === 4001 || error.code === "ACTION_REJECTED")) {
      console.warn(`[Wallet:${context}] User rejected the request.`);
      showToast("Request was rejected.", "warning");
      return;
    }

    console.error(`[Wallet:${context}]`, error);
    showToast(message, "error");
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  window.Wallet = {
    isMetaMaskInstalled,
    checkNetwork,
    switchNetwork,
    connect,
    getProvider,
    getSigner,
    getAddress,
    disconnect,
    onAccountChange,
    onChainChange,
    getBalance,
    formatAddress,
    formatETH,
    parseETH,
    getContract,
    showToast,
    showLoading,
    hideLoading,
    showModal,
    hideModal,
    requireConnection,
    getStoredUser,
    storeUser,
    clearUser,
  };
})(window);
