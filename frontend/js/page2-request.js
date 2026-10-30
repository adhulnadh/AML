// frontend/js/page2-request.js
//
// Page script for page2-user-request.html (REQUESTER dashboard). Depends on
// config.js and metamask.js being loaded first.
//
// EXPECTED HTML STRUCTURE
// No HTML file has been generated for this page yet. This script queries
// the DOM by ID/class matching request.css's classes from the earlier spec.
// At minimum, wire up page2-user-request.html with:
//
//   <div class="request-page">
//     <!-- navbar with #navWalletAddress, #navWalletBalance somewhere -->
//
//     <div class="request-container">
//       <div class="request-page-header">
//         <h1>My Fund Requests</h1>
//         <p id="userNameDisplay"></p>
//       </div>
//
//       <!-- Stats row (uses common.css's .stat-card) -->
//       <div class="grid-4" id="statsRow">
//         <div class="stat-card"><div class="stat-value" id="statTotalRequests">0</div><div class="stat-label">Total Requests</div></div>
//         <div class="stat-card"><div class="stat-value" id="statPending">0</div><div class="stat-label">Pending</div></div>
//         <div class="stat-card"><div class="stat-value" id="statApproved">0</div><div class="stat-label">Approved</div></div>
//         <div class="stat-card"><div class="stat-value" id="statTotalReceived">0 ETH</div><div class="stat-label">Total Received</div></div>
//       </div>
//
//       <div class="create-request-card">
//         <h2>New Request</h2>
//         <form id="createRequestForm">
//           <div class="form-group">
//             <label class="form-label" for="amountInput">Amount</label>
//             <div class="amount-input-wrapper">
//               <input id="amountInput" class="form-input" type="number" min="0" step="0.0001" required />
//               <span class="amount-unit">ETH</span>
//             </div>
//           </div>
//           <div class="form-group">
//             <label class="form-label" for="purposeInput">Purpose</label>
//             <textarea id="purposeInput" class="form-textarea" required></textarea>
//           </div>
//           <div class="form-group">
//             <label class="form-label">Urgency</label>
//             <div class="urgency-select" id="urgencySelect">
//               <div class="urgency-select-option" data-urgency="0">Low</div>
//               <div class="urgency-select-option" data-urgency="1">Medium</div>
//               <div class="urgency-select-option" data-urgency="2">High</div>
//             </div>
//           </div>
//           <button type="submit" id="createRequestBtn" class="btn btn-primary btn-block">Submit Request</button>
//         </form>
//       </div>
//
//       <div class="my-requests-section">
//         <div class="my-requests-header">
//           <h2>My Requests</h2>
//           <div class="my-requests-filter" id="requestsFilter">
//             <button data-filter="all" class="active">All</button>
//             <button data-filter="0">Pending</button>
//             <button data-filter="1">Approved</button>
//             <button data-filter="3">Completed</button>
//           </div>
//         </div>
//         <div class="requests-list" id="requestsList"></div>
//         <div class="empty-state hidden" id="emptyState">
//           <div class="empty-illustration">📭</div>
//           <h3>No requests yet</h3>
//           <p>Create your first fund request using the form above.</p>
//         </div>
//       </div>
//     </div>
//   </div>

(function () {
  "use strict";

  // ==========================================================================
  // Module state
  // ==========================================================================

  let userAddress = null;
  let selectedUrgency = window.CONFIG ? window.CONFIG.URGENCY.MEDIUM : 1;
  let activeFilter = "all";

  // Cache of the user's own requests, keyed by request ID (string), kept in
  // sync by loadMyRequests() and by the live event listeners in
  // setupEventListeners(). Used both for rendering and for filtering which
  // incoming contract events are actually relevant to this user (see note
  // in setupEventListeners()).
  let myRequests = new Map();

  let fundRequestContract = null; // read/write instance (signer), for calls
  let fundRequestEventsContract = null; // separate instance for .on() listeners

  // ==========================================================================
  // DOM references
  // ==========================================================================

  const el = {
    userNameDisplay: document.getElementById("userNameDisplay"),
    statTotalRequests: document.getElementById("statTotalRequests"),
    statPending: document.getElementById("statPending"),
    statApproved: document.getElementById("statApproved"),
    statTotalReceived: document.getElementById("statTotalReceived"),
    createRequestForm: document.getElementById("createRequestForm"),
    amountInput: document.getElementById("amountInput"),
    purposeInput: document.getElementById("purposeInput"),
    urgencySelect: document.getElementById("urgencySelect"),
    createRequestBtn: document.getElementById("createRequestBtn"),
    requestsList: document.getElementById("requestsList"),
    emptyState: document.getElementById("emptyState"),
    requestsFilter: document.getElementById("requestsFilter"),
  };

  // ==========================================================================
  // 1. init()
  // ==========================================================================

  async function init() {
    if (!window.Wallet || !window.CONFIG) {
      console.error("[page2-request] Wallet/CONFIG not available -- check script load order.");
      return;
    }

    // Require a stored session at all; requireConnection() redirects to
    // login if there's no stored user.
    if (!window.Wallet.requireConnection()) {
      return;
    }

    const storedUser = window.Wallet.getStoredUser();
    userAddress = storedUser.address;

    try {
      window.Wallet.showLoading("Loading your dashboard...");

      // Verify the REQUESTER role against the chain, not just localStorage --
      // localStorage could be stale (e.g. role changed) or tampered with
      // client-side, and every contract call is enforced on-chain regardless,
      // so this is a UX guard rather than the actual security boundary.
      const userRegistry = window.Wallet.getContract("userRegistry", window.Wallet.getProvider());
      if (!userRegistry) {
        window.Wallet.hideLoading();
        return;
      }

      const onChainRole = Number(await userRegistry.getUserRole(userAddress));

      if (onChainRole !== window.CONFIG.ROLES.REQUESTER) {
        window.Wallet.hideLoading();
        window.Wallet.showToast("This page is only available to Requesters.", "error");
        redirectToCorrectPage(onChainRole);
        return;
      }

      fundRequestContract = window.Wallet.getContract("fundRequest", window.Wallet.getSigner());
      fundRequestEventsContract = window.Wallet.getContract(
        "fundRequest",
        window.Wallet.getProvider()
      );

      await loadUserInfo();
      await loadMyRequests();
      setupEventListeners();

      if (el.createRequestForm) {
        el.createRequestForm.addEventListener("submit", handleCreateRequest);
      }
      if (el.urgencySelect) {
        el.urgencySelect.addEventListener("click", handleUrgencySelect);
        // Default the UI to reflect selectedUrgency's initial value.
        highlightSelectedUrgency();
      }
      if (el.requestsFilter) {
        el.requestsFilter.addEventListener("click", handleFilterClick);
      }
      if (el.requestsList) {
        // Event delegation for per-card cancel buttons, since cards are
        // re-rendered on every reload.
        el.requestsList.addEventListener("click", handleRequestsListClick);
      }

      window.Wallet.hideLoading();
    } catch (error) {
      window.Wallet.hideLoading();
      console.error("[page2-request] init failed:", error);
      window.Wallet.showToast("Failed to load your dashboard.", "error");
    }
  }

  function redirectToCorrectPage(role) {
    const ROLES = window.CONFIG.ROLES;
    const ROUTES = window.CONFIG.ROUTES;
    if (role === ROLES.FUNDER) {
      window.location.href = ROUTES.richLogin;
    } else if (role === ROLES.ADMIN) {
      window.location.href = ROUTES.monitor;
    } else {
      window.location.href = ROUTES.login;
    }
  }

  // ==========================================================================
  // 2. loadUserInfo()
  // ==========================================================================

  async function loadUserInfo() {
    try {
      const userRegistry = window.Wallet.getContract("userRegistry", window.Wallet.getProvider());
      const userInfo = await userRegistry.getUserInfo(userAddress);

      if (el.userNameDisplay) {
        el.userNameDisplay.textContent = `Welcome back, ${userInfo.name}`;
      }

      // totalRequests here is UserRegistry's own counter (incremented by
      // FundRequest.createRequest via incrementUserRequests). Kept separate
      // from the stats computed by updateStats(), which are derived from
      // the actual fetched request list and so can also break down by
      // status -- UserRegistry's counter alone can't distinguish pending
      // vs. approved vs. completed.
      return userInfo;
    } catch (error) {
      console.error("[page2-request] loadUserInfo failed:", error);
      window.Wallet.showToast("Could not load your profile.", "error");
      return null;
    }
  }

  // ==========================================================================
  // 3. loadMyRequests()
  // ==========================================================================

  async function loadMyRequests() {
    try {
      const requestIds = await fundRequestContract.getRequestsByUser(userAddress);

      myRequests = new Map();

      // Fetch full details for each ID. Sequential await keeps this simple
      // and safe for a demo-scale request list; for a very large history
      // this should be batched (e.g. Promise.all in chunks) instead.
      for (const idBn of requestIds) {
        const id = idBn.toString();
        const requestData = await fundRequestContract.getRequest(idBn);
        myRequests.set(id, requestData);
      }

      renderRequests(Array.from(myRequests.values()));
      updateStats();
    } catch (error) {
      console.error("[page2-request] loadMyRequests failed:", error);
      window.Wallet.showToast("Could not load your requests.", "error");
    }
  }

  // ==========================================================================
  // 4. renderRequests(requests)
  // ==========================================================================

  const STATUS_KEY = ["pending", "approved", "rejected", "completed", "cancelled"];
  const URGENCY_KEY = ["low", "medium", "high"];

  function renderRequests(requests) {
    if (!el.requestsList) return;

    const filtered =
      activeFilter === "all"
        ? requests
        : requests.filter((r) => Number(r.status) === Number(activeFilter));

    // Most recent first.
    const sorted = [...filtered].sort((a, b) => Number(b.createdAt) - Number(a.createdAt));

    if (sorted.length === 0) {
      el.requestsList.innerHTML = "";
      if (el.emptyState) el.emptyState.classList.remove("hidden");
      return;
    }

    if (el.emptyState) el.emptyState.classList.add("hidden");

    el.requestsList.innerHTML = sorted.map(requestCardHtml).join("");
  }

  function requestCardHtml(request) {
    const id = request.id.toString();
    const statusNum = Number(request.status);
    const urgencyNum = Number(request.urgency);
    const statusKey = STATUS_KEY[statusNum] || "pending";
    const urgencyKey = URGENCY_KEY[urgencyNum] || "medium";

    const amountEth = window.Wallet.formatETH(request.amount);
    const createdDate = new Date(Number(request.createdAt) * 1000).toLocaleDateString();

    const hasFunder =
      request.funder && request.funder !== "0x0000000000000000000000000000000000000000";
    const funderHtml = hasFunder
      ? `<div class="funder-tag">Funder: ${window.Wallet.formatAddress(request.funder)}</div>`
      : "";

    const cancelButtonHtml =
      statusNum === window.CONFIG.REQUEST_STATUS.PENDING
        ? `<button class="btn btn-outline btn-sm cancel-request-btn" data-request-id="${id}">Cancel</button>`
        : "";

    const suspiciousClass = request.isSuspicious ? " is-suspicious" : "";

    return `
      <div class="request-item${suspiciousClass}" data-request-id="${id}">
        <div class="request-item-header">
          <div>
            <div class="request-item-amount">${escapeHtml(amountEth.replace(" ETH", ""))}<span class="unit">ETH</span></div>
          </div>
          <div class="request-item-badges">
            <span class="urgency-badge urgency-${urgencyKey}">${escapeHtml(URGENCY_KEY[urgencyNum] || "Medium")}</span>
            <span class="request-status-badge status-${statusKey}">${escapeHtml(STATUS_KEY[statusNum] || "Pending")}</span>
          </div>
        </div>
        <div class="request-item-purpose">${escapeHtml(request.purpose)}</div>
        <div class="request-item-meta">
          <span>#${escapeHtml(id)}</span>
          <span class="meta-dot"></span>
          <span>${escapeHtml(createdDate)}</span>
        </div>
        <div class="request-item-footer">
          ${funderHtml}
          ${cancelButtonHtml}
        </div>
      </div>
    `;
  }

  // Minimal HTML-escaping for any on-chain string data (purpose, name, etc.)
  // rendered via innerHTML above, since those strings are user-controlled
  // and must never be interpreted as markup.
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function handleFilterClick(event) {
    const button = event.target.closest("button[data-filter]");
    if (!button) return;

    activeFilter = button.dataset.filter;

    el.requestsFilter.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn === button);
    });

    renderRequests(Array.from(myRequests.values()));
  }

  function handleRequestsListClick(event) {
    const cancelBtn = event.target.closest(".cancel-request-btn");
    if (cancelBtn) {
      handleCancelRequest(cancelBtn.dataset.requestId);
    }
  }

  function handleUrgencySelect(event) {
    const option = event.target.closest(".urgency-select-option");
    if (!option) return;
    selectedUrgency = Number(option.dataset.urgency);
    highlightSelectedUrgency();
  }

  function highlightSelectedUrgency() {
    if (!el.urgencySelect) return;
    el.urgencySelect.querySelectorAll(".urgency-select-option").forEach((opt) => {
      opt.classList.toggle("selected", Number(opt.dataset.urgency) === selectedUrgency);
    });
  }

  // ==========================================================================
  // 5. handleCreateRequest(event)
  // ==========================================================================

  async function handleCreateRequest(event) {
    event.preventDefault();

    const amountValue = el.amountInput ? el.amountInput.value : "";
    const purpose = el.purposeInput ? el.purposeInput.value.trim() : "";

    if (!amountValue || Number(amountValue) <= 0) {
      window.Wallet.showToast("Please enter an amount greater than 0.", "error");
      return;
    }

    if (!purpose) {
      window.Wallet.showToast("Please describe the purpose of your request.", "error");
      return;
    }

    const amountWei = window.Wallet.parseETH(amountValue);
    if (!amountWei) return; // parseETH already showed an error toast

    try {
      if (el.createRequestBtn) el.createRequestBtn.disabled = true;
      window.Wallet.showLoading("Confirm the transaction in MetaMask...");

      const tx = await fundRequestContract.createRequest(amountWei, purpose, selectedUrgency);

      window.Wallet.showLoading("Waiting for confirmation on-chain...");
      await tx.wait();

      window.Wallet.hideLoading();
      window.Wallet.showToast("Request created! Waiting for a funder.", "success");

      if (el.createRequestForm) el.createRequestForm.reset();
      selectedUrgency = window.CONFIG.URGENCY.MEDIUM;
      highlightSelectedUrgency();

      await loadMyRequests();
    } catch (error) {
      window.Wallet.hideLoading();
      console.error("[page2-request] handleCreateRequest failed:", error);

      if (error && (error.code === 4001 || error.code === "ACTION_REJECTED")) {
        window.Wallet.showToast("Request creation cancelled.", "warning");
      } else {
        window.Wallet.showToast((error && error.reason) || "Failed to create request.", "error");
      }
    } finally {
      if (el.createRequestBtn) el.createRequestBtn.disabled = false;
    }
  }

  // ==========================================================================
  // 6. handleCancelRequest(requestId)
  // ==========================================================================

  async function handleCancelRequest(requestId) {
    const confirmed = window.confirm("Cancel this request? This cannot be undone.");
    if (!confirmed) return;

    try {
      window.Wallet.showLoading("Confirm the cancellation in MetaMask...");

      const tx = await fundRequestContract.cancelRequest(requestId);

      window.Wallet.showLoading("Waiting for confirmation on-chain...");
      await tx.wait();

      window.Wallet.hideLoading();
      window.Wallet.showToast("Request cancelled.", "info");

      await loadMyRequests();
    } catch (error) {
      window.Wallet.hideLoading();
      console.error("[page2-request] handleCancelRequest failed:", error);

      if (error && (error.code === 4001 || error.code === "ACTION_REJECTED")) {
        window.Wallet.showToast("Cancellation aborted.", "warning");
      } else {
        window.Wallet.showToast((error && error.reason) || "Failed to cancel request.", "error");
      }
    }
  }

  // ==========================================================================
  // 7. setupEventListeners()
  //
  // FundRequest's events are indexed by request ID, not by requester address
  // (only RequestCreated is indexed by requester -- RequestApproved,
  // RequestRejected, and RequestCompleted are not). That means we can't ask
  // ethers to filter these events server-side to "only this user's
  // requests" -- instead we listen globally and check each event's request
  // ID against the myRequests map built by loadMyRequests(), ignoring
  // anything that isn't one of this user's own requests. This is fine at
  // demo scale; a production system would want a subgraph or backend
  // indexer rather than raw client-side event listening.
  // ==========================================================================

  function setupEventListeners() {
    if (!fundRequestEventsContract) return;

    fundRequestEventsContract.on("RequestApproved", async (id, funder) => {
      if (!myRequests.has(id.toString())) return;

      window.Wallet.showToast("Your request was approved!", "success");
      await loadMyRequests();
    });

    fundRequestEventsContract.on("RequestRejected", async (id, funder, reason) => {
      if (!myRequests.has(id.toString())) return;

      window.Wallet.showToast(`Your request was rejected: ${reason}`, "error");
      await loadMyRequests();
    });

    fundRequestEventsContract.on("RequestCompleted", async (id, amount) => {
      if (!myRequests.has(id.toString())) return;

      window.Wallet.showToast(
        `Payment received! ${window.Wallet.formatETH(amount)} has been sent to your wallet.`,
        "success"
      );
      await loadMyRequests();
    });
  }

  // ==========================================================================
  // 8. updateStats()
  // ==========================================================================

  function updateStats() {
    const requests = Array.from(myRequests.values());
    const STATUS = window.CONFIG.REQUEST_STATUS;

    const total = requests.length;
    const pending = requests.filter((r) => Number(r.status) === STATUS.PENDING).length;
    const approved = requests.filter((r) => Number(r.status) === STATUS.APPROVED).length;

    const totalReceivedWei = requests
      .filter((r) => Number(r.status) === STATUS.COMPLETED)
      .reduce((sum, r) => sum.add(r.amount), window.ethers.BigNumber.from(0));

    if (el.statTotalRequests) el.statTotalRequests.textContent = total;
    if (el.statPending) el.statPending.textContent = pending;
    if (el.statApproved) el.statApproved.textContent = approved;
    if (el.statTotalReceived) el.statTotalReceived.textContent = window.Wallet.formatETH(totalReceivedWei);
  }

  // ==========================================================================
  // Entry point
  // ==========================================================================

  document.addEventListener("DOMContentLoaded", init);
})();
