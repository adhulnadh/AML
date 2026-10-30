// frontend/js/page1-login.js
//
// Page script for page1-login.html. Depends on config.js and metamask.js
// being loaded first (see metamask.js's header comment for full load order,
// including the ethers.js CDN script).
//
// EXPECTED HTML STRUCTURE
// This script queries the DOM by ID/class rather than building markup from
// scratch, so page1-login.html is expected to contain elements matching the
// login.css classes from the earlier spec. No HTML file has been generated
// yet, so wire up page1-login.html with (at minimum) these IDs:
//
//   <div class="login-container">
//     <div class="login-card">
//       <div class="login-logo"> ... </div>
//
//       <!-- Shown only if window.ethereum is not detected -->
//       <div id="metamaskWarning" class="login-error hidden">
//         MetaMask not detected. <a id="installMetamaskLink" target="_blank">Install it here</a>.
//       </div>
//
//       <!-- Step 1: connect -->
//       <button id="connectWalletBtn" class="btn-connect-wallet">Connect MetaMask</button>
//
//       <!-- Shown after a successful connect() -->
//       <div id="walletInfoCard" class="wallet-info-card hidden">
//         <div class="wallet-avatar"></div>
//         <div class="wallet-details">
//           <div id="walletAddressDisplay" class="wallet-address"></div>
//           <div class="wallet-status"><span class="status-dot"></span>Connected</div>
//         </div>
//         <button id="walletDisconnectBtn" class="wallet-disconnect">Disconnect</button>
//       </div>
//
//       <!-- Shown if getUserInfo() says the address is already registered -->
//       <button id="continueBtn" class="btn-continue hidden">Continue</button>
//
//       <!-- Shown if NOT registered -->
//       <form id="registrationForm" class="hidden">
//         <div class="form-group">
//           <label class="form-label" for="nameInput">Full name</label>
//           <input id="nameInput" class="form-input" type="text" required />
//         </div>
//
//         <div class="role-selector" id="roleSelector">
//           <div class="role-selector-label">Select your role</div>
//           <label class="role-option" data-role="1">
//             <input type="radio" name="role" value="1" />
//             <span class="role-icon">🙋</span>
//             <span class="role-text">
//               <span class="role-name">Requester</span>
//               <span class="role-desc">Request funds</span>
//             </span>
//             <span class="role-check"></span>
//           </label>
//           <label class="role-option" data-role="2">
//             <input type="radio" name="role" value="2" />
//             <span class="role-icon">💰</span>
//             <span class="role-text">
//               <span class="role-name">Funder</span>
//               <span class="role-desc">Approve and pay requests</span>
//             </span>
//             <span class="role-check"></span>
//           </label>
//           <label class="role-option" data-role="3">
//             <input type="radio" name="role" value="3" />
//             <span class="role-icon">🛡️</span>
//             <span class="role-text">
//               <span class="role-name">Admin</span>
//               <span class="role-desc">Monitor the system</span>
//             </span>
//             <span class="role-check"></span>
//           </label>
//         </div>
//
//         <!-- Only shown/required when role === FUNDER -->
//         <div class="form-group hidden" id="incomeGroup">
//           <label class="form-label" for="incomeInput">Annual income (ETH)</label>
//           <input id="incomeInput" class="form-input" type="number" min="0" step="0.01" />
//         </div>
//
//         <button type="submit" id="registerBtn" class="btn-continue">Register</button>
//       </form>
//     </div>
//   </div>

(function () {
  "use strict";

  // ==========================================================================
  // Module state
  // ==========================================================================

  let connectedAddress = null;
  let selectedRole = null; // one of CONFIG.ROLES values, set via role-option click

  // ==========================================================================
  // DOM references (queried once; re-query defensively if the page's actual
  // markup uses different IDs than the structure documented above)
  // ==========================================================================

  const el = {
    metamaskWarning: document.getElementById("metamaskWarning"),
    connectBtn: document.getElementById("connectWalletBtn"),
    walletInfoCard: document.getElementById("walletInfoCard"),
    walletAddressDisplay: document.getElementById("walletAddressDisplay"),
    walletDisconnectBtn: document.getElementById("walletDisconnectBtn"),
    continueBtn: document.getElementById("continueBtn"),
    registrationForm: document.getElementById("registrationForm"),
    nameInput: document.getElementById("nameInput"),
    roleSelector: document.getElementById("roleSelector"),
    incomeGroup: document.getElementById("incomeGroup"),
    incomeInput: document.getElementById("incomeInput"),
    registerBtn: document.getElementById("registerBtn"),
  };

  // ==========================================================================
  // init()
  // Runs on page load. Detects MetaMask, silently checks for an already-
  // authorized connection (without prompting), and if the connected address
  // is already registered, redirects immediately per the required flow.
  // ==========================================================================

  async function init() {
    if (!window.Wallet || !window.CONFIG) {
      console.error("[page1-login] Wallet/CONFIG not available -- check script load order.");
      return;
    }

    if (el.connectBtn) {
      el.connectBtn.addEventListener("click", handleConnect);
    }
    if (el.walletDisconnectBtn) {
      el.walletDisconnectBtn.addEventListener("click", handleDisconnectClick);
    }
    if (el.registrationForm) {
      el.registrationForm.addEventListener("submit", handleRegister);
    }
    if (el.roleSelector) {
      el.roleSelector.addEventListener("click", handleRoleOptionClick);
    }

    // 1a. MetaMask not installed -> show warning + install link, stop here.
    if (!window.Wallet.isMetaMaskInstalled()) {
      if (el.metamaskWarning) {
        el.metamaskWarning.classList.remove("hidden");
      }
      if (el.connectBtn) {
        el.connectBtn.disabled = true;
      }
      return;
    }

    // 1b. Check silently (eth_accounts, not eth_requestAccounts) whether the
    // site is already authorized, so we don't pop the MetaMask prompt just
    // for landing on the page.
    try {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (accounts && accounts.length > 0) {
        connectedAddress = accounts[0];
        showUserInfo({ address: connectedAddress });

        const networkOk = await window.Wallet.checkNetwork();
        if (!networkOk) {
          return; // checkNetwork already surfaced a toast/prompt
        }

        // 1c. Already registered? Auto-redirect based on role, no click needed.
        await checkRegistration(connectedAddress);
      }
    } catch (error) {
      console.error("[page1-login] init() silent account check failed:", error);
      // Non-fatal -- just leaves the page in its default "not connected" state.
    }

    // Wire up wallet-level listeners so account/network switches mid-session
    // are handled instead of leaving stale UI state.
    window.Wallet.onAccountChange(async (accounts) => {
      if (!accounts || accounts.length === 0) {
        window.location.reload();
        return;
      }
      connectedAddress = accounts[0];
      showUserInfo({ address: connectedAddress });
      await checkRegistration(connectedAddress);
    });

    window.Wallet.onChainChange(() => {
      window.Wallet.showToast("Network changed. Reloading...", "info");
      window.location.reload();
    });
  }

  // ==========================================================================
  // handleConnect()
  // "Connect MetaMask" button click handler.
  // ==========================================================================

  async function handleConnect() {
    const result = await window.Wallet.connect();
    if (!result) {
      return; // Wallet.connect() already showed an error toast
    }

    connectedAddress = result.address;
    showUserInfo({ address: connectedAddress });
    await checkRegistration(connectedAddress);
  }

  function handleDisconnectClick() {
    window.Wallet.disconnect();
    connectedAddress = null;
    selectedRole = null;

    if (el.walletInfoCard) el.walletInfoCard.classList.add("hidden");
    if (el.continueBtn) el.continueBtn.classList.add("hidden");
    if (el.registrationForm) el.registrationForm.classList.add("hidden");
  }

  // ==========================================================================
  // checkRegistration(address)
  // Looks up the address in UserRegistry. If registered, stores the user
  // profile and shows a "Continue" button; if not, shows the registration
  // form. On page load (not just button click), a registered user is
  // redirected immediately per the required flow.
  // ==========================================================================

  async function checkRegistration(address) {
    try {
      window.Wallet.showLoading("Checking registration status...");

      const userRegistry = window.Wallet.getContract("userRegistry", window.Wallet.getProvider());
      if (!userRegistry) {
        window.Wallet.hideLoading();
        return;
      }

      const userInfo = await userRegistry.getUserInfo(address);
      window.Wallet.hideLoading();

      if (userInfo && userInfo.isRegistered) {
        const roleNumber = Number(userInfo.role);

        window.Wallet.storeUser({
          address,
          role: roleNumber,
          name: userInfo.name,
        });

        if (userInfo.isBlacklisted) {
          window.Wallet.showToast(
            "This address has been blacklisted and cannot continue.",
            "error"
          );
          return;
        }

        // Registered -> skip the form entirely and redirect straight away.
        // (Covers both the page-load auto-check and the post-connect check.)
        redirectBasedOnRole(roleNumber);
        return;
      }

      // Not registered -> show the registration form.
      showRegistrationForm();
    } catch (error) {
      window.Wallet.hideLoading();
      console.error("[page1-login] checkRegistration failed:", error);
      window.Wallet.showToast("Could not check registration status.", "error");
    }
  }

  // ==========================================================================
  // showRegistrationForm()
  // ==========================================================================

  function showRegistrationForm() {
    if (el.continueBtn) el.continueBtn.classList.add("hidden");
    if (el.registrationForm) el.registrationForm.classList.remove("hidden");
  }

  // ==========================================================================
  // Role-option click handling (radio + .selected class, matching login.css)
  // ==========================================================================

  function handleRoleOptionClick(event) {
    const option = event.target.closest(".role-option");
    if (!option) return;

    const role = Number(option.dataset.role);
    selectedRole = role;

    // Update visual selection state across all options.
    el.roleSelector.querySelectorAll(".role-option").forEach((opt) => {
      opt.classList.toggle("selected", Number(opt.dataset.role) === role);
    });

    // Keep the underlying radio input in sync for form semantics/accessibility.
    const radio = option.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;

    // Income is only meaningful for FUNDER.
    if (el.incomeGroup) {
      const isFunder = role === window.CONFIG.ROLES.FUNDER;
      el.incomeGroup.classList.toggle("hidden", !isFunder);
      if (el.incomeInput) {
        el.incomeInput.required = isFunder;
        if (!isFunder) el.incomeInput.value = "";
      }
    }
  }

  // ==========================================================================
  // handleRegister(event)
  // Registration form submit handler -> UserRegistry.registerUser()
  // ==========================================================================

  async function handleRegister(event) {
    event.preventDefault();

    if (!connectedAddress) {
      window.Wallet.showToast("Connect your wallet before registering.", "warning");
      return;
    }

    const name = el.nameInput ? el.nameInput.value.trim() : "";
    if (!name) {
      window.Wallet.showToast("Please enter your name.", "error");
      return;
    }

    if (selectedRole === null || selectedRole === window.CONFIG.ROLES.NONE) {
      window.Wallet.showToast("Please select a role.", "error");
      return;
    }

    let incomeWei = window.ethers.BigNumber.from(0);
    if (selectedRole === window.CONFIG.ROLES.FUNDER) {
      const incomeValue = el.incomeInput ? el.incomeInput.value : "";
      if (!incomeValue || Number(incomeValue) < 0) {
        window.Wallet.showToast("Please enter a valid annual income.", "error");
        return;
      }
      const parsed = window.Wallet.parseETH(incomeValue);
      if (!parsed) return; // parseETH already showed an error toast
      incomeWei = parsed;
    }

    try {
      if (el.registerBtn) el.registerBtn.disabled = true;
      window.Wallet.showLoading("Confirm the transaction in MetaMask...");

      const userRegistry = window.Wallet.getContract("userRegistry", window.Wallet.getSigner());
      if (!userRegistry) {
        window.Wallet.hideLoading();
        if (el.registerBtn) el.registerBtn.disabled = false;
        return;
      }

      const tx = await userRegistry.registerUser(name, selectedRole, incomeWei);

      window.Wallet.showLoading("Waiting for confirmation on-chain...");
      await tx.wait();

      window.Wallet.hideLoading();
      window.Wallet.showToast("Registration successful!", "success");

      window.Wallet.storeUser({
        address: connectedAddress,
        role: selectedRole,
        name,
      });

      redirectBasedOnRole(selectedRole);
    } catch (error) {
      window.Wallet.hideLoading();
      if (el.registerBtn) el.registerBtn.disabled = false;
      console.error("[page1-login] handleRegister failed:", error);

      if (error && (error.code === 4001 || error.code === "ACTION_REJECTED")) {
        window.Wallet.showToast("Registration was cancelled.", "warning");
      } else {
        window.Wallet.showToast(
          (error && error.reason) || "Registration failed. Please try again.",
          "error"
        );
      }
    }
  }

  // ==========================================================================
  // showUserInfo(user)
  // Populates and reveals the wallet-info-card for a connected address.
  // ==========================================================================

  function showUserInfo(user) {
    if (!el.walletInfoCard) return;

    el.walletInfoCard.classList.remove("hidden");
    if (el.walletAddressDisplay) {
      el.walletAddressDisplay.textContent = window.Wallet.formatAddress(user.address);
      el.walletAddressDisplay.title = user.address;
    }
    if (el.connectBtn) {
      el.connectBtn.classList.add("hidden");
    }
  }

  // ==========================================================================
  // redirectBasedOnRole(role)
  // ==========================================================================

  function redirectBasedOnRole(role) {
    const ROLES = window.CONFIG.ROLES;
    const ROUTES = window.CONFIG.ROUTES;

    switch (role) {
      case ROLES.REQUESTER:
        window.location.href = ROUTES.request;
        break;
      case ROLES.FUNDER:
        window.location.href = ROUTES.richLogin;
        break;
      case ROLES.ADMIN:
        window.location.href = ROUTES.monitor;
        break;
      default:
        console.warn("[page1-login] Unknown role, cannot redirect:", role);
        window.Wallet.showToast("Unrecognized role -- cannot continue.", "error");
    }
  }

  // ==========================================================================
  // Entry point
  // ==========================================================================

  document.addEventListener("DOMContentLoaded", init);
})();
