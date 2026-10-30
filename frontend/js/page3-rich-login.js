// frontend/js/page3-rich-login.js
//
// Page script for page3-rich-login.html (FUNDER dashboard: pending requests
// from all requesters + this funder's own review stats). Depends on
// config.js and metamask.js being loaded first.
//
// STYLESHEET NOTE: no dedicated "rich-login.css" was ever produced for this
// page -- the original file tree named css/login.css, request.css,
// approve.css, monitor.css for the five pages, leaving page3 without its
// own stylesheet. This script therefore reuses class names already defined
// elsewhere rather than inventing new ones: .stats-row / .stat-box from
// approve.css (it already covers exactly "Pending / Approved / Rejected /
// Total Paid"), and .requests-list / .request-item / .urgency-badge /
// .request-status-badge from request.css for the pending-request cards. If
// you want this page visually distinct, it'll need its own stylesheet --
// happy to build one.
//
// EXPECTED HTML STRUCTURE (none generated yet for this page):
//
//   <div class="request-page"> <!-- reusing request.css's page background -->
//     <div class="request-container" style="grid-template-columns: 1fr;">
//       <div class="request-page-header">
//         <h1>Funder Dashboard</h1>
//         <p id="funderNameDisplay"></p>
//         <span id="funderBalanceDisplay"></span>
//       </div>
//
//       <div class="stats-row" id="statsRow"> <!-- from approve.css -->
//         <div class="stat-box stat-pending"><div class="stat-box-value" id="statPending">0</div><div class="stat-box-label">Pending</div></div>
//         <div class="stat-box stat-approved"><div class="stat-box-value" id="statApproved">0</div><div class="stat-box-label">Approved</div></div>
//         <div class="stat-box stat-rejected"><div class="stat-box-value" id="statRejected">0</div><div class="stat-box-label">Rejected</div></div>
//         <div class="stat-box stat-total-paid"><div class="stat-box-value" id="statTotalPaid">0 ETH</div><div class="stat-box-label">Total Paid</div></div>
//       </div>
//
//       <div class="my-requests-header">
//         <h2>Pending Requests</h2>
//         <div class="my-requests-filter" id="urgencyFilter">
//           <button data-urgency="all" class="active">All</button>
//           <button data-urgency="2">High</button>
//           <button data-urgency="1">Medium</button>
//           <button data-urgency="0">Low</button>
//         </div>
//         <select id="sortSelect">
//           <option value="date-desc">Newest first</option>
//           <option value="date-asc">Oldest first</option>
//           <option value="amount-desc">Amount: high to low</option>
//           <option value="amount-asc">Amount: low to high</option>
//           <option value="urgency-desc">Urgency: high to low</option>
//         </select>
//         <button id="refreshBtn" class="btn btn-outline btn-sm">Refresh</button>
//       </div>
//
//       <div class="requests-list" id="pendingRequestsList"></div>
//       <div class="empty-state hidden" id="emptyState">
//         <div class="empty-illustration">📭</div>
//         <h3>No pending requests</h3>
//         <p>New requests from requesters will appear here.</p>
//       </div>
//     </div>
//   </div>

(function () {
  "use strict";

  // ==========================================================================
  // Module state
  // ==========================================================================

  let funderAddress = null;
  let fundRequestContract = null; // signer-backed, for future write calls from this page
  let fundRequestEventsContract = null; // provider-backed, for .on() listeners
  let userRegistryContract = null;

  // Cache of pending requests actually shown (post-blacklist-filter),
  // enriched with requester info. Keyed by request ID (string).
  let pendingRequests = new Map();

  let urgencyFilter = "all"; // "all" | 0 | 1 | 2
  let sortMode = "date-desc";

  // ==========================================================================
  // DOM references
  // ==========================================================================

  const el = {
    funderNameDisplay: document.getElementById("funderNameDisplay"),
    funderBalanceDisplay: document.getElementById("funderBalanceDisplay"),
    statPending: document.getElementById("statPending"),
    statApproved: document.getElementById("statApproved"),
    statRejected: document.getElementById("statRejected"),
    statTotalPaid: document.getElementById("statTotalPaid"),
    urgencyFilter: document.getElementById("urgencyFilter"),
    sortSelect: document.getElementById("sortSelect"),
    refreshBtn: document.getElementById("refreshBtn"),
    pendingRequestsList: document.getElementById("pendingRequestsList"),
    emptyState: document.getElementById("emptyState"),
  };

  // ==========================================================================
  // 1. init()
  // ==========================================================================

  async function init() {
    if (!window.Wallet || !window.CONFIG) {
      console.error("[page3-rich-login] Wallet/CONFIG not available -- check script load order.");
      return;
    }

    if (!window.Wallet.requireConnection()) {
      return;
    }

    const storedUser = window.Wallet.getStoredUser();
    funderAddress = storedUser.address;

    try {
      window.Wallet.showLoading("Loading dashboard...");

      userRegistryContract = window.Wallet.getContract("userRegistry", window.Wallet.getProvider());
      if (!userRegistryContract) {
        window.Wallet.hideLoading();
        return;
      }

      // Verify FUNDER role on-chain, not just from localStorage -- see the
      // same reasoning noted in page2-request.js. localStorage is a UX
      // convenience, not the security boundary (every contract call is
      // enforced on-chain regardless of what this page lets through).
      const onChainRole = Number(await userRegistryContract.getUserRole(funderAddress));

      if (onChainRole !== window.CONFIG.ROLES.FUNDER) {
        window.Wallet.hideLoading();
        window.Wallet.showToast("This page is only available to Funders.", "error");
        redirectToCorrectPage(onChainRole);
        return;
      }

      fundRequestContract = window.Wallet.getContract("fundRequest", window.Wallet.getSigner());
      fundRequestEventsContract = window.Wallet.getContract(
        "fundRequest",
        window.Wallet.getProvider()
      );

      await loadFunderInfo();
      await Promise.all([loadFunderStats(), loadPendingRequests()]);
      setupEventListeners();

      if (el.urgencyFilter) {
        el.urgencyFilter.addEventListener("click", handleUrgencyFilterClick);
      }
      if (el.sortSelect) {
        el.sortSelect.addEventListener("change", handleSortChange);
      }
      if (el.refreshBtn) {
        el.refreshBtn.addEventListener("click", handleRefreshClick);
      }
      if (el.pendingRequestsList) {
        el.pendingRequestsList.addEventListener("click", handlePendingListClick);
      }

      window.Wallet.hideLoading();
    } catch (error) {
      window.Wallet.hideLoading();
      console.error("[page3-rich-login] init failed:", error);
      window.Wallet.showToast("Failed to load the dashboard.", "error");
    }
  }

  function redirectToCorrectPage(role) {
    const ROLES = window.CONFIG.ROLES;
    const ROUTES = window.CONFIG.ROUTES;
    if (role === ROLES.REQUESTER) {
      window.location.href = ROUTES.request;
    } else if (role === ROLES.ADMIN) {
      window.location.href = ROUTES.monitor;
    } else {
      window.location.href = ROUTES.login;
    }
  }

  async function loadFunderInfo() {
    try {
      const userInfo = await userRegistryContract.getUserInfo(funderAddress);
      if (el.funderNameDisplay) {
        el.funderNameDisplay.textContent = `Welcome, ${userInfo.name}`;
      }

      const balance = await window.Wallet.getBalance(funderAddress);
      if (el.funderBalanceDisplay && balance !== null) {
        el.funderBalanceDisplay.textContent = `Balance: ${parseFloat(balance).toFixed(4)} ETH`;
      }
    } catch (error) {
      console.error("[page3-rich-login] loadFunderInfo failed:", error);
      window.Wallet.showToast("Could not load your profile.", "error");
    }
  }

  // ==========================================================================
  // 2. loadFunderStats()
  //
  // NOTE ON DATA SOURCES: neither FundRequest.sol nor PaymentProcessor.sol
  // exposes a "get requests reviewed by this funder" query -- requests only
  // store a single `funder` field once approved/rejected, with no reverse
  // index by funder address. So:
  //   - Approved/Completed count + Total Paid come from
  //     PaymentProcessor.getPaymentsByUser(funderAddress), which DOES index
  //     by both funder and requester, filtered here to entries where
  //     payment.funder === this address.
  //   - Rejected count has no equivalent index at all, so it requires a
  //     full scan of every request ID (1..getRequestsCount()) checking
  //     request.funder === address && status === REJECTED. This is O(n) in
  //     total requests across the whole system, not just this funder's --
  //     fine for a demo, but would need a proper indexer/subgraph (or a
  //     getRequestsByFunder() added to the contract) at real scale.
  //   - "Approved" here really means "approved AND paid": PaymentProcessor's
  //     approveAndPay() moves a request from PENDING straight through
  //     APPROVED to COMPLETED within a single transaction, so the APPROVED
  //     status is never actually observed at rest on-chain. Treating
  //     "Approved" and "Completed" as the same count reflects that.
  // ==========================================================================

  async function loadFunderStats() {
    try {
      const paymentProcessor = window.Wallet.getContract(
        "paymentProcessor",
        window.Wallet.getProvider()
      );
      const fundRequestReadOnly = window.Wallet.getContract(
        "fundRequest",
        window.Wallet.getProvider()
      );

      // --- Approved/paid count + total paid, via PaymentProcessor ---
      const paymentIds = await paymentProcessor.getPaymentsByUser(funderAddress);
      let approvedCount = 0;
      let totalPaidWei = window.ethers.BigNumber.from(0);

      for (const paymentIdBn of paymentIds) {
        const payment = await paymentProcessor.getPayment(paymentIdBn);
        if (payment.funder.toLowerCase() === funderAddress.toLowerCase()) {
          approvedCount += 1;
          totalPaidWei = totalPaidWei.add(payment.amount);
        }
      }

      // --- Rejected count, via full request scan (see note above) ---
      const totalRequestCount = Number(await fundRequestReadOnly.getRequestsCount());
      let rejectedCount = 0;

      for (let id = 1; id <= totalRequestCount; id++) {
        const request = await fundRequestReadOnly.getRequest(id);
        if (
          request.funder.toLowerCase() === funderAddress.toLowerCase() &&
          Number(request.status) === window.CONFIG.REQUEST_STATUS.REJECTED
        ) {
          rejectedCount += 1;
        }
      }

      if (el.statApproved) el.statApproved.textContent = approvedCount;
      if (el.statRejected) el.statRejected.textContent = rejectedCount;
      if (el.statTotalPaid) el.statTotalPaid.textContent = window.Wallet.formatETH(totalPaidWei);
      // statPending is set separately by loadPendingRequests(), since it
      // reflects system-wide pending requests, not something specific to
      // this funder's history.
    } catch (error) {
      console.error("[page3-rich-login] loadFunderStats failed:", error);
      window.Wallet.showToast("Could not load your stats.", "error");
    }
  }

  // ==========================================================================
  // 3. loadPendingRequests()
  // ==========================================================================

  async function loadPendingRequests() {
    try {
      const pendingIds = await fundRequestContract.getPendingRequests();

      pendingRequests = new Map();

      for (const idBn of pendingIds) {
        const id = idBn.toString();
        const request = await fundRequestContract.getRequest(idBn);
        const requesterInfo = await userRegistryContract.getUserInfo(request.requester);

        // Skip blacklisted requesters entirely, per spec -- a funder should
        // never even see (let alone be able to approve) a request from a
        // blacklisted address here. PaymentProcessor also enforces this
        // on-chain independently; this is a UX-level pre-filter.
        if (requesterInfo.isBlacklisted) {
          continue;
        }

        pendingRequests.set(id, {
          request,
          requester: requesterInfo,
        });
      }

      if (el.statPending) el.statPending.textContent = pendingRequests.size;

      filterRequests({ urgency: urgencyFilter, sort: sortMode });
    } catch (error) {
      console.error("[page3-rich-login] loadPendingRequests failed:", error);
      window.Wallet.showToast("Could not load pending requests.", "error");
    }
  }

  // ==========================================================================
  // 4. renderPendingRequests(requests)
  // requests: array of { request, requester } entries, already
  // filtered/sorted by filterRequests().
  // ==========================================================================

  const URGENCY_KEY = ["low", "medium", "high"];
  const URGENCY_LABEL = ["Low", "Medium", "High"];

  function renderPendingRequests(entries) {
    if (!el.pendingRequestsList) return;

    if (entries.length === 0) {
      el.pendingRequestsList.innerHTML = "";
      if (el.emptyState) el.emptyState.classList.remove("hidden");
      return;
    }

    if (el.emptyState) el.emptyState.classList.add("hidden");

    el.pendingRequestsList.innerHTML = entries.map(pendingCardHtml).join("");
  }

  function pendingCardHtml({ request, requester }) {
    const id = request.id.toString();
    const urgencyNum = Number(request.urgency);
    const urgencyKey = URGENCY_KEY[urgencyNum] || "medium";
    const amountEth = window.Wallet.formatETH(request.amount);
    const createdDate = new Date(Number(request.createdAt) * 1000).toLocaleDateString();
    const suspiciousClass = request.isSuspicious ? " is-suspicious" : "";

    return `
      <div class="request-item${suspiciousClass}" data-request-id="${id}">
        <div class="request-item-header">
          <div>
            <div class="request-item-amount">${escapeHtml(amountEth.replace(" ETH", ""))}<span class="unit">ETH</span></div>
          </div>
          <div class="request-item-badges">
            <span class="urgency-badge urgency-${urgencyKey}">${escapeHtml(URGENCY_LABEL[urgencyNum] || "Medium")}</span>
            ${request.isSuspicious ? '<span class="badge badge-warning">Flagged</span>' : ""}
          </div>
        </div>
        <div class="request-item-purpose">${escapeHtml(request.purpose)}</div>
        <div class="request-item-meta">
          <span>${escapeHtml(requester.name)}</span>
          <span class="meta-dot"></span>
          <span>${escapeHtml(requester.totalRequests.toString())} past requests</span>
          <span class="meta-dot"></span>
          <span>${escapeHtml(createdDate)}</span>
        </div>
        <div class="request-item-footer">
          <span class="mono text-muted">${escapeHtml(window.Wallet.formatAddress(request.requester))}</span>
          <button class="btn btn-primary btn-sm review-request-btn" data-request-id="${id}">Review &amp; Approve</button>
        </div>
      </div>
    `;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function handlePendingListClick(event) {
    const reviewBtn = event.target.closest(".review-request-btn");
    if (reviewBtn) {
      viewRequestDetails(reviewBtn.dataset.requestId);
    }
  }

  // ==========================================================================
  // 5. filterRequests(criteria)
  // criteria: { urgency: "all"|0|1|2, sort: "date-desc"|"date-asc"|
  //             "amount-desc"|"amount-asc"|"urgency-desc" }
  // Filters and sorts the cached pendingRequests map, then re-renders.
  // ==========================================================================

  function filterRequests(criteria) {
    urgencyFilter = criteria.urgency !== undefined ? criteria.urgency : urgencyFilter;
    sortMode = criteria.sort !== undefined ? criteria.sort : sortMode;

    let entries = Array.from(pendingRequests.values());

    if (urgencyFilter !== "all") {
      entries = entries.filter((e) => Number(e.request.urgency) === Number(urgencyFilter));
    }

    entries.sort((a, b) => {
      switch (sortMode) {
        case "date-asc":
          return Number(a.request.createdAt) - Number(b.request.createdAt);
        case "amount-desc":
          return b.request.amount.sub(a.request.amount).isNegative() ? -1 : 1;
        case "amount-asc":
          return a.request.amount.sub(b.request.amount).isNegative() ? -1 : 1;
        case "urgency-desc":
          return Number(b.request.urgency) - Number(a.request.urgency);
        case "date-desc":
        default:
          return Number(b.request.createdAt) - Number(a.request.createdAt);
      }
    });

    renderPendingRequests(entries);
  }

  function handleUrgencyFilterClick(event) {
    const button = event.target.closest("button[data-urgency]");
    if (!button) return;

    const value = button.dataset.urgency === "all" ? "all" : Number(button.dataset.urgency);

    el.urgencyFilter.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn === button);
    });

    filterRequests({ urgency: value });
  }

  function handleSortChange(event) {
    filterRequests({ sort: event.target.value });
  }

  async function handleRefreshClick() {
    try {
      window.Wallet.showLoading("Refreshing...");
      await Promise.all([loadFunderStats(), loadPendingRequests()]);
      window.Wallet.hideLoading();
    } catch (error) {
      window.Wallet.hideLoading();
      console.error("[page3-rich-login] handleRefreshClick failed:", error);
      window.Wallet.showToast("Refresh failed.", "error");
    }
  }

  // ==========================================================================
  // 6. viewRequestDetails(requestId)
  // ==========================================================================

  function viewRequestDetails(requestId) {
    try {
      localStorage.setItem("aml_system:selected_request", requestId);
    } catch (error) {
      console.error("[page3-rich-login] Could not persist selected request:", error);
    }
    window.location.href = window.CONFIG.ROUTES.approve;
  }

  // ==========================================================================
  // 7. setupEventListeners()
  // ==========================================================================

  function setupEventListeners() {
    if (!fundRequestEventsContract) return;

    // RequestCreated is indexed by both id and requester, but we still need
    // to fetch the requester's UserRegistry info (name, blacklist status)
    // before deciding whether/how to show it, so there's no way to filter
    // out blacklisted requesters at the event-subscription level itself.
    fundRequestEventsContract.on("RequestCreated", async (id, requester, amount, purpose) => {
      try {
        const requesterInfo = await userRegistryContract.getUserInfo(requester);
        if (requesterInfo.isBlacklisted) {
          return; // silently skip, consistent with loadPendingRequests()
        }

        const request = await fundRequestContract.getRequest(id);
        pendingRequests.set(id.toString(), { request, requester: requesterInfo });

        if (el.statPending) el.statPending.textContent = pendingRequests.size;

        window.Wallet.showToast(
          `New request: ${window.Wallet.formatETH(amount)} from ${requesterInfo.name}`,
          "info"
        );

        filterRequests({}); // re-apply current filter/sort and re-render
      } catch (error) {
        console.error("[page3-rich-login] RequestCreated handler failed:", error);
      }
    });
  }

  // ==========================================================================
  // Entry point
  // ==========================================================================

  document.addEventListener("DOMContentLoaded", init);
})();
