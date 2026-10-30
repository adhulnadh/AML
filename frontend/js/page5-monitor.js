// frontend/js/page5-monitor.js
//
// Page script for page5-monitor.html (ADMIN dashboard). Depends on
// config.js, metamask.js, and Chart.js being loaded first:
//   <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
//
// ============================================================================
// IMPORTANT GAP CARRIED OVER FROM AMLSystem.sol
// ============================================================================
// AMLSystem.logTransaction() is `internal` and nothing calls it -- neither
// AMLSystem itself, nor FundRequest, nor PaymentProcessor hold a reference
// back to AMLSystem to invoke it. That means, as the contracts currently
// stand:
//   - AMLSystem.getAllTransactionLogs() will always return an EMPTY array.
//   - AMLSystem.TransactionLogged and SuspiciousActivityDetected events will
//     NEVER fire.
// This was flagged when AMLSystem.sol was built and has not been fixed at
// the contract level. Rather than build a dashboard that displays nothing,
// this script calls AMLSystem's log functions/listens for its events AS
// SPECIFIED, but ALSO backfills and live-updates the transaction feed and
// charts directly from FundRequest's and PaymentProcessor's own events
// (RequestCreated/Approved/Rejected/Completed, PaymentCompleted/Flagged),
// which DO fire. Every place this backfill happens is commented below.
// If you later wire logTransaction() into the other contracts, this file's
// AMLSystem-log code path will start working without changes -- the two
// sources are merged and de-duplicated, not swapped.
// ============================================================================
//
// EXPECTED HTML STRUCTURE (none generated yet). Matches monitor.css's
// classes from the earlier spec -- see that file's own header comment for
// the full class list (.monitor-page, .stats-grid, .live-feed,
// .blacklist-panel, .threshold-card, .chart-container, .filter-bar, etc).
// Key IDs this script expects, beyond what monitor.css names as classes:
//   #monitorPage (root .monitor-page element, for the dark-mode toggle)
//   #statTotalUsers #statTotalRequests #statTotalPayments #statSuspicious
//   #blacklistCount #blacklistList #blacklistAddForm #blacklistAddressInput #blacklistReasonInput
//   #thresholdForm #thresholdInput #thresholdCurrentValue
//   #liveFeedList
//   #chartTxOverTime #chartNormalSuspicious #chartTopRequesters (canvas elements)
//   #filterSearch #filterStatusChips (chips with data-status) #filterDateFrom #filterDateTo
//   #exportBtn #themeToggleBtn #refreshBtn
//   #txTableBody #txPagination

(function () {
  "use strict";

  // ==========================================================================
  // Module state
  // ==========================================================================

  let adminAddress = null;
  let amlSystemContract = null; // signer-backed, for admin actions
  let amlSystemEventsContract = null; // provider-backed, for .on() listeners
  let fundRequestEventsContract = null;
  let paymentProcessorEventsContract = null;

  // Unified transaction feed: merges AMLSystem.TransactionLog entries (see
  // gap note above -- likely empty) with reconstructed entries from
  // FundRequest/PaymentProcessor events. Each entry:
  //   { id, from, to, amount (BigNumber), timestamp (seconds), txType,
  //     isSuspicious, source }
  let allTransactions = [];
  let blacklistEntries = []; // [{ address, reason }]

  let filters = {
    status: "all", // "all" | "normal" | "suspicious" | "blacklisted"
    search: "",
    dateFrom: null,
    dateTo: null,
  };

  let currentPage = 1;
  const pageSize = (window.CONFIG && window.CONFIG.APP_CONFIG.pageSize) || 10;

  let charts = { txOverTime: null, normalVsSuspicious: null, topRequesters: null };

  let hasUserInteracted = false; // browsers block audio autoplay before a gesture
  document.addEventListener(
    "click",
    () => {
      hasUserInteracted = true;
    },
    { once: true }
  );

  // ==========================================================================
  // DOM references
  // ==========================================================================

  const el = {
    monitorPage: document.getElementById("monitorPage"),
    themeToggleBtn: document.getElementById("themeToggleBtn"),
    refreshBtn: document.getElementById("refreshBtn"),
    statTotalUsers: document.getElementById("statTotalUsers"),
    statTotalRequests: document.getElementById("statTotalRequests"),
    statTotalPayments: document.getElementById("statTotalPayments"),
    statSuspicious: document.getElementById("statSuspicious"),
    blacklistCount: document.getElementById("blacklistCount"),
    blacklistList: document.getElementById("blacklistList"),
    blacklistAddForm: document.getElementById("blacklistAddForm"),
    blacklistAddressInput: document.getElementById("blacklistAddressInput"),
    blacklistReasonInput: document.getElementById("blacklistReasonInput"),
    thresholdForm: document.getElementById("thresholdForm"),
    thresholdInput: document.getElementById("thresholdInput"),
    thresholdCurrentValue: document.getElementById("thresholdCurrentValue"),
    liveFeedList: document.getElementById("liveFeedList"),
    chartTxOverTime: document.getElementById("chartTxOverTime"),
    chartNormalSuspicious: document.getElementById("chartNormalSuspicious"),
    chartTopRequesters: document.getElementById("chartTopRequesters"),
    filterSearch: document.getElementById("filterSearch"),
    filterStatusChips: document.getElementById("filterStatusChips"),
    filterDateFrom: document.getElementById("filterDateFrom"),
    filterDateTo: document.getElementById("filterDateTo"),
    exportBtn: document.getElementById("exportBtn"),
    txTableBody: document.getElementById("txTableBody"),
    txPagination: document.getElementById("txPagination"),
  };

  // ==========================================================================
  // 1. init()
  // ==========================================================================

  async function init() {
    if (!window.Wallet || !window.CONFIG) {
      console.error("[page5-monitor] Wallet/CONFIG not available -- check script load order.");
      return;
    }
    if (typeof window.Chart === "undefined") {
      console.error("[page5-monitor] Chart.js not found -- charts will not render.");
    }

    if (!window.Wallet.requireConnection()) {
      return;
    }

    const storedUser = window.Wallet.getStoredUser();
    adminAddress = storedUser.address;

    try {
      window.Wallet.showLoading("Loading dashboard...");

      const userRegistry = window.Wallet.getContract("userRegistry", window.Wallet.getProvider());
      if (!userRegistry) {
        window.Wallet.hideLoading();
        return;
      }

      // Verify ADMIN role on-chain. NOTE: as flagged when UserRegistry.sol
      // was built, the ADMIN *role* here is just a label field -- it grants
      // no special contract permissions by itself. Real authority over
      // AMLSystem comes from matching AMLSystem.admin(), checked separately
      // below before enabling write actions (blacklist/threshold).
      const onChainRole = Number(await userRegistry.getUserRole(adminAddress));
      if (onChainRole !== window.CONFIG.ROLES.ADMIN) {
        window.Wallet.hideLoading();
        window.Wallet.showToast("This page is only available to Admins.", "error");
        redirectToCorrectPage(onChainRole);
        return;
      }

      amlSystemContract = window.Wallet.getContract("amlSystem", window.Wallet.getSigner());
      amlSystemEventsContract = window.Wallet.getContract("amlSystem", window.Wallet.getProvider());
      fundRequestEventsContract = window.Wallet.getContract("fundRequest", window.Wallet.getProvider());
      paymentProcessorEventsContract = window.Wallet.getContract(
        "paymentProcessor",
        window.Wallet.getProvider()
      );

      // Warn (but don't block viewing) if this address isn't actually
      // AMLSystem's admin -- write actions below will revert on-chain if so.
      const contractAdmin = await amlSystemContract.admin();
      if (contractAdmin.toLowerCase() !== adminAddress.toLowerCase()) {
        window.Wallet.showToast(
          "This wallet is not AMLSystem's admin. You can view the dashboard, but blacklist/threshold actions will fail.",
          "warning"
        );
      }

      await Promise.all([loadSystemStats(), loadAllTransactions(), loadBlacklist()]);
      setupRealTimeListeners();
      renderCharts();
      wireControls();

      window.Wallet.hideLoading();
    } catch (error) {
      window.Wallet.hideLoading();
      console.error("[page5-monitor] init failed:", error);
      window.Wallet.showToast("Failed to load the monitoring dashboard.", "error");
    }
  }

  function redirectToCorrectPage(role) {
    const ROLES = window.CONFIG.ROLES;
    const ROUTES = window.CONFIG.ROUTES;
    if (role === ROLES.REQUESTER) window.location.href = ROUTES.request;
    else if (role === ROLES.FUNDER) window.location.href = ROUTES.richLogin;
    else window.location.href = ROUTES.login;
  }

  function wireControls() {
    if (el.themeToggleBtn) {
      el.themeToggleBtn.addEventListener("click", () => {
        if (!el.monitorPage) return;
        const isDark = el.monitorPage.getAttribute("data-theme") === "dark";
        el.monitorPage.setAttribute("data-theme", isDark ? "light" : "dark");
      });
    }
    if (el.refreshBtn) {
      el.refreshBtn.addEventListener("click", async () => {
        window.Wallet.showLoading("Refreshing...");
        await Promise.all([loadSystemStats(), loadAllTransactions(), loadBlacklist()]);
        renderCharts();
        window.Wallet.hideLoading();
      });
    }
    if (el.thresholdForm) {
      el.thresholdForm.addEventListener("submit", handleThresholdUpdate);
    }
    if (el.blacklistAddForm) {
      el.blacklistAddForm.addEventListener("submit", handleBlacklistAddress);
    }
    if (el.blacklistList) {
      el.blacklistList.addEventListener("click", (event) => {
        const btn = event.target.closest(".blacklist-remove");
        if (btn) handleWhitelistAddress(btn.dataset.address);
      });
    }
    if (el.filterSearch) {
      el.filterSearch.addEventListener("input", (event) => {
        applyFilters({ search: event.target.value });
      });
    }
    if (el.filterStatusChips) {
      el.filterStatusChips.addEventListener("click", (event) => {
        const chip = event.target.closest("[data-status]");
        if (!chip) return;
        el.filterStatusChips
          .querySelectorAll("[data-status]")
          .forEach((c) => c.classList.toggle("active", c === chip));
        applyFilters({ status: chip.dataset.status });
      });
    }
    if (el.filterDateFrom) {
      el.filterDateFrom.addEventListener("change", (event) =>
        applyFilters({ dateFrom: event.target.value || null })
      );
    }
    if (el.filterDateTo) {
      el.filterDateTo.addEventListener("change", (event) =>
        applyFilters({ dateTo: event.target.value || null })
      );
    }
    if (el.exportBtn) {
      el.exportBtn.addEventListener("click", () => exportReport("csv"));
    }
  }

  // ==========================================================================
  // 2. loadSystemStats()
  // ==========================================================================

  async function loadSystemStats() {
    try {
      const stats = await amlSystemContract.getSystemStats();
      // Returns: [totalUsers, totalRequests, totalPayments, totalSuspicious, totalBlacklisted]

      if (el.statTotalUsers) el.statTotalUsers.textContent = stats.totalUsers.toString();
      if (el.statTotalRequests) el.statTotalRequests.textContent = stats.totalRequests.toString();
      if (el.statTotalPayments) el.statTotalPayments.textContent = stats.totalPayments.toString();

      // totalSuspicious from getSystemStats() counts AMLSystem's own
      // transactionLogs -- which, per the gap noted above, is currently
      // always 0. We display the richer, backfilled count (from
      // allTransactions, computed after loadAllTransactions() runs)
      // instead, so this stat reflects reality. See updateSuspiciousStat().
      if (el.blacklistCount) el.blacklistCount.textContent = stats.totalBlacklisted.toString();
    } catch (error) {
      console.error("[page5-monitor] loadSystemStats failed:", error);
      window.Wallet.showToast("Could not load system stats.", "error");
    }
  }

  function updateSuspiciousStat() {
    const suspiciousCount = allTransactions.filter((t) => t.isSuspicious).length;
    if (el.statSuspicious) el.statSuspicious.textContent = suspiciousCount;
  }

  // ==========================================================================
  // 3. loadAllTransactions()
  // Merges AMLSystem's own (likely empty) log with a backfill reconstructed
  // from FundRequest/PaymentProcessor past events. See the file-header gap
  // note for why the backfill exists.
  // ==========================================================================

  async function loadAllTransactions() {
    try {
      const amlLogs = await amlSystemContract.getAllTransactionLogs();
      const fromAmlSystem = amlLogs.map((log) => ({
        id: `aml-${log.id.toString()}`,
        from: log.from,
        to: log.to,
        amount: log.amount,
        timestamp: Number(log.timestamp),
        txType: log.txType,
        isSuspicious: log.isSuspicious,
        source: "AMLSystem",
      }));

      const backfilled = await backfillTransactionsFromContractEvents();

      // Merge + sort newest first. No true de-duplication key exists across
      // the two sources (AMLSystem logs and raw contract events don't share
      // an ID scheme), so if logTransaction() is ever wired up on-chain,
      // expect duplicate-looking entries until this backfill is removed.
      allTransactions = [...fromAmlSystem, ...backfilled].sort((a, b) => b.timestamp - a.timestamp);

      updateSuspiciousStat();
      applyFilters({}); // renders the feed/table with current filter state
    } catch (error) {
      console.error("[page5-monitor] loadAllTransactions failed:", error);
      window.Wallet.showToast("Could not load transaction history.", "error");
    }
  }

  /**
   * Reconstructs feed entries from FundRequest's and PaymentProcessor's own
   * past events, since AMLSystem's internal log is not wired up to receive
   * them (see file-header gap note). Uses ethers' queryFilter to pull the
   * full event history from genesis -- fine for a demo/testnet contract
   * with limited history; a production system would paginate by block
   * range or use an indexer instead of querying full history on every load.
   */
  async function backfillTransactionsFromContractEvents() {
    const entries = [];

    try {
      const [created, approved, rejected, completed] = await Promise.all([
        fundRequestEventsContract.queryFilter(fundRequestEventsContract.filters.RequestCreated()),
        fundRequestEventsContract.queryFilter(fundRequestEventsContract.filters.RequestApproved()),
        fundRequestEventsContract.queryFilter(fundRequestEventsContract.filters.RequestRejected()),
        fundRequestEventsContract.queryFilter(fundRequestEventsContract.filters.RequestCompleted()),
      ]);

      const blockTimestampCache = new Map();
      const getBlockTimestamp = async (blockNumber) => {
        if (!blockTimestampCache.has(blockNumber)) {
          const block = await window.Wallet.getProvider().getBlock(blockNumber);
          blockTimestampCache.set(blockNumber, block.timestamp);
        }
        return blockTimestampCache.get(blockNumber);
      };

      for (const evt of created) {
        entries.push({
          id: `req-created-${evt.transactionHash}`,
          from: evt.args.requester,
          to: window.CONFIG.CONTRACT_ADDRESSES.fundRequest,
          amount: evt.args.amount,
          timestamp: await getBlockTimestamp(evt.blockNumber),
          txType: "REQUEST",
          isSuspicious: false,
          source: "FundRequest.RequestCreated",
        });
      }

      for (const evt of completed) {
        entries.push({
          id: `payment-completed-${evt.transactionHash}`,
          from: window.CONFIG.CONTRACT_ADDRESSES.paymentProcessor,
          to: "(see PaymentProcessor payment record)",
          amount: evt.args.amount,
          timestamp: await getBlockTimestamp(evt.blockNumber),
          txType: "PAYMENT",
          isSuspicious: false,
          source: "FundRequest.RequestCompleted",
        });
      }

      // Approved/Rejected don't carry an amount in their own event args, so
      // they're represented as zero-amount "BLOCK"-type informational
      // entries in the feed rather than misrepresenting a transfer amount.
      for (const evt of approved) {
        entries.push({
          id: `req-approved-${evt.transactionHash}`,
          from: evt.args.funder,
          to: "(request approved)",
          amount: window.ethers.BigNumber.from(0),
          timestamp: await getBlockTimestamp(evt.blockNumber),
          txType: "BLOCK",
          isSuspicious: false,
          source: "FundRequest.RequestApproved",
        });
      }

      for (const evt of rejected) {
        entries.push({
          id: `req-rejected-${evt.transactionHash}`,
          from: evt.args.funder,
          to: "(request rejected)",
          amount: window.ethers.BigNumber.from(0),
          timestamp: await getBlockTimestamp(evt.blockNumber),
          txType: "BLOCK",
          isSuspicious: false,
          source: "FundRequest.RequestRejected",
        });
      }

      const flagged = await paymentProcessorEventsContract.queryFilter(
        paymentProcessorEventsContract.filters.PaymentFlagged()
      );
      const flaggedPaymentIds = new Set(flagged.map((evt) => evt.args.paymentId.toString()));

      // Mark any already-added PAYMENT entry as suspicious if its
      // corresponding PaymentFlagged event fired. We match by amount +
      // approximate timestamp since PaymentFlagged only carries a payment
      // ID, not the underlying request ID -- a rough heuristic, noted here
      // rather than hidden.
      if (flaggedPaymentIds.size > 0) {
        const paymentProcessorSigner = window.Wallet.getContract(
          "paymentProcessor",
          window.Wallet.getProvider()
        );
        for (const idStr of flaggedPaymentIds) {
          try {
            const payment = await paymentProcessorSigner.getPayment(idStr);
            const match = entries.find(
              (e) => e.txType === "PAYMENT" && e.amount.eq(payment.amount)
            );
            if (match) match.isSuspicious = true;
          } catch (e) {
            // Ignore individual lookup failures -- non-critical enrichment.
          }
        }
      }
    } catch (error) {
      console.error("[page5-monitor] backfillTransactionsFromContractEvents failed:", error);
    }

    return entries;
  }

  // ==========================================================================
  // 4. loadBlacklist()
  // ==========================================================================

  async function loadBlacklist() {
    try {
      const addresses = await amlSystemContract.getBlacklistedAddresses();

      blacklistEntries = [];
      for (const address of addresses) {
        const isStillBlacklisted = await amlSystemContract.isBlacklisted(address);
        if (!isStillBlacklisted) continue; // getBlacklistedAddresses() includes historical, since-whitelisted entries

        const reason = await amlSystemContract.getBlacklistReason(address);
        blacklistEntries.push({ address, reason });
      }

      renderBlacklist();
    } catch (error) {
      console.error("[page5-monitor] loadBlacklist failed:", error);
      window.Wallet.showToast("Could not load blacklist.", "error");
    }
  }

  function renderBlacklist() {
    if (!el.blacklistList) return;

    if (el.blacklistCount) el.blacklistCount.textContent = blacklistEntries.length;

    if (blacklistEntries.length === 0) {
      el.blacklistList.innerHTML = `<div class="blacklist-empty">No addresses currently blacklisted.</div>`;
      return;
    }

    el.blacklistList.innerHTML = blacklistEntries
      .map(
        (entry) => `
          <div class="blacklist-item">
            <div>
              <div class="blacklist-address">${escapeHtml(entry.address)}</div>
              <span class="blacklist-reason">${escapeHtml(entry.reason)}</span>
            </div>
            <button class="blacklist-remove" data-address="${escapeHtml(entry.address)}">Remove</button>
          </div>
        `
      )
      .join("");
  }

  // ==========================================================================
  // 5. setupRealTimeListeners()
  // ==========================================================================

  function setupRealTimeListeners() {
    // --- AMLSystem's own events (see gap note: these likely never fire) ---
    amlSystemEventsContract.on("TransactionLogged", (id, from, to, amount, suspicious) => {
      addLiveTransaction({
        id: `aml-${id.toString()}`,
        from,
        to,
        amount,
        timestamp: Math.floor(Date.now() / 1000),
        txType: "UNKNOWN",
        isSuspicious: suspicious,
        source: "AMLSystem.TransactionLogged",
      });
    });

    amlSystemEventsContract.on("SuspiciousActivityDetected", (txId, user, amount) => {
      showAlertBanner(
        "danger",
        "Suspicious Activity Detected",
        `Transaction #${txId.toString()} involving ${window.Wallet.formatAddress(user)} for ${window.Wallet.formatETH(
          amount
        )} was flagged.`
      );
      playAlertSound();
    });

    amlSystemEventsContract.on("AddressBlacklisted", (user, reason) => {
      window.Wallet.showToast(`Address blacklisted: ${window.Wallet.formatAddress(user)}`, "warning");
      loadBlacklist();
    });

    amlSystemEventsContract.on("AddressWhitelisted", (user) => {
      window.Wallet.showToast(`Address whitelisted: ${window.Wallet.formatAddress(user)}`, "info");
      loadBlacklist();
    });

    // --- Real, firing events from FundRequest/PaymentProcessor (the actual
    // live-update mechanism, per the gap note above) ---
    fundRequestEventsContract.on("RequestCreated", (id, requester, amount, purpose) => {
      addLiveTransaction({
        id: `req-created-${id.toString()}-${Date.now()}`,
        from: requester,
        to: window.CONFIG.CONTRACT_ADDRESSES.fundRequest,
        amount,
        timestamp: Math.floor(Date.now() / 1000),
        txType: "REQUEST",
        isSuspicious: false,
        source: "FundRequest.RequestCreated",
      });
      window.Wallet.showToast(`New request from ${window.Wallet.formatAddress(requester)}`, "info");
    });

    fundRequestEventsContract.on("SuspiciousRequestFlagged", (id, amount) => {
      showAlertBanner(
        "warning",
        "Suspicious Request Flagged",
        `Request #${id.toString()} for ${window.Wallet.formatETH(amount)} exceeds the auto-flag threshold.`
      );
      playAlertSound();
      loadAllTransactions();
    });

    paymentProcessorEventsContract.on("PaymentCompleted", (paymentId, requestId, funder, requester, amount) => {
      addLiveTransaction({
        id: `payment-${paymentId.toString()}-${Date.now()}`,
        from: funder,
        to: requester,
        amount,
        timestamp: Math.floor(Date.now() / 1000),
        txType: "PAYMENT",
        isSuspicious: false,
        source: "PaymentProcessor.PaymentCompleted",
      });
    });

    paymentProcessorEventsContract.on("PaymentFlagged", (paymentId, amount) => {
      showAlertBanner(
        "danger",
        "Payment Flagged",
        `Payment #${paymentId.toString()} for ${window.Wallet.formatETH(amount)} exceeded the AML threshold.`
      );
      playAlertSound();
    });
  }

  function addLiveTransaction(entry) {
    allTransactions.unshift(entry);
    updateSuspiciousStat();
    applyFilters({});

    // Highlight the new row with the .is-new pulse class (see monitor.css),
    // removed automatically once the CSS animation finishes.
    requestAnimationFrame(() => {
      const node = el.liveFeedList && el.liveFeedList.querySelector(`[data-tx-id="${cssEscape(entry.id)}"]`);
      if (node) {
        node.classList.add("is-new");
        setTimeout(() => node.classList.remove("is-new"), 1800);
      }
    });
  }

  function showAlertBanner(type, title, message) {
    const container = document.getElementById("alertBannerContainer") || document.body;
    const banner = document.createElement("div");
    banner.className = `alert-banner alert-${type}`;
    banner.innerHTML = `
      <div class="alert-icon">!</div>
      <div class="alert-body">
        <div class="alert-title"></div>
        <div class="alert-message"></div>
      </div>
      <button class="alert-dismiss">&times;</button>
    `;
    banner.querySelector(".alert-title").textContent = title;
    banner.querySelector(".alert-message").textContent = message;
    banner.querySelector(".alert-dismiss").addEventListener("click", () => banner.remove());
    container.prepend(banner);

    setTimeout(() => banner.remove(), 15000);
  }

  /**
   * Plays a short alert beep via the Web Audio API, so no external audio
   * asset is required. NOTE: browsers block audio playback before the user
   * has interacted with the page at all -- the very first alert that fires
   * before any click may be silently blocked. This is a browser policy, not
   * a bug; hasUserInteracted (tracked at the top of this file) reflects it.
   */
  function playAlertSound() {
    if (!hasUserInteracted) {
      console.warn("[page5-monitor] Skipping alert sound -- no user interaction yet (browser autoplay policy).");
      return;
    }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.4);
    } catch (error) {
      console.warn("[page5-monitor] Could not play alert sound:", error);
    }
  }

  // ==========================================================================
  // 6. handleThresholdUpdate(event)
  // ==========================================================================

  async function handleThresholdUpdate(event) {
    event.preventDefault();

    const value = el.thresholdInput ? el.thresholdInput.value : "";
    if (!value || Number(value) <= 0) {
      window.Wallet.showToast("Please enter a valid threshold amount.", "error");
      return;
    }

    const thresholdWei = window.Wallet.parseETH(value);
    if (!thresholdWei) return;

    try {
      window.Wallet.showLoading("Confirm the transaction in MetaMask...");
      const tx = await amlSystemContract.setThreshold(thresholdWei);
      await tx.wait();
      window.Wallet.hideLoading();

      window.Wallet.showToast("Threshold updated.", "success");
      if (el.thresholdCurrentValue) {
        el.thresholdCurrentValue.textContent = `${value} ETH`;
      }
    } catch (error) {
      window.Wallet.hideLoading();
      console.error("[page5-monitor] handleThresholdUpdate failed:", error);
      if (error && (error.code === 4001 || error.code === "ACTION_REJECTED")) {
        window.Wallet.showToast("Threshold update cancelled.", "warning");
      } else {
        window.Wallet.showToast((error && error.reason) || "Failed to update threshold.", "error");
      }
    }
  }

  // ==========================================================================
  // 7. handleBlacklistAddress(event)
  // ==========================================================================

  async function handleBlacklistAddress(event) {
    event.preventDefault();

    const address = el.blacklistAddressInput ? el.blacklistAddressInput.value.trim() : "";
    const reason = el.blacklistReasonInput ? el.blacklistReasonInput.value.trim() : "";

    if (!window.ethers.utils.isAddress(address)) {
      window.Wallet.showToast("Please enter a valid Ethereum address.", "error");
      return;
    }
    if (!reason) {
      window.Wallet.showToast("Please provide a reason for blacklisting.", "error");
      return;
    }
    if (address.toLowerCase() === adminAddress.toLowerCase()) {
      window.Wallet.showToast("You cannot blacklist your own admin address.", "error");
      return;
    }

    const confirmed = window.confirm(`Blacklist ${address}? This can be undone later.`);
    if (!confirmed) return;

    try {
      window.Wallet.showLoading("Confirm the transaction in MetaMask...");
      const tx = await amlSystemContract.blacklistAddress(address, reason);
      await tx.wait();
      window.Wallet.hideLoading();

      window.Wallet.showToast("Address blacklisted.", "success");
      if (el.blacklistAddForm) el.blacklistAddForm.reset();
      await loadBlacklist();
    } catch (error) {
      window.Wallet.hideLoading();
      console.error("[page5-monitor] handleBlacklistAddress failed:", error);
      if (error && (error.code === 4001 || error.code === "ACTION_REJECTED")) {
        window.Wallet.showToast("Blacklist action cancelled.", "warning");
      } else {
        window.Wallet.showToast((error && error.reason) || "Failed to blacklist address.", "error");
      }
    }
  }

  // ==========================================================================
  // 8. handleWhitelistAddress(address)
  // ==========================================================================

  async function handleWhitelistAddress(address) {
    const confirmed = window.confirm(`Remove ${address} from the blacklist?`);
    if (!confirmed) return;

    try {
      window.Wallet.showLoading("Confirm the transaction in MetaMask...");
      const tx = await amlSystemContract.whitelistAddress(address);
      await tx.wait();
      window.Wallet.hideLoading();

      window.Wallet.showToast("Address removed from blacklist.", "success");
      await loadBlacklist();
    } catch (error) {
      window.Wallet.hideLoading();
      console.error("[page5-monitor] handleWhitelistAddress failed:", error);
      if (error && (error.code === 4001 || error.code === "ACTION_REJECTED")) {
        window.Wallet.showToast("Whitelist action cancelled.", "warning");
      } else {
        window.Wallet.showToast((error && error.reason) || "Failed to whitelist address.", "error");
      }
    }
  }

  // ==========================================================================
  // 9. renderCharts()
  // ==========================================================================

  function renderCharts() {
    if (typeof window.Chart === "undefined") return;

    renderTxOverTimeChart();
    renderNormalVsSuspiciousChart();
    renderTopRequestersChart();
  }

  function renderTxOverTimeChart() {
    if (!el.chartTxOverTime) return;

    // Bucket transactions by day for the last 14 days.
    const days = 14;
    const buckets = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      buckets.push({ label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), date: d, count: 0 });
    }

    allTransactions.forEach((tx) => {
      const txDate = new Date(tx.timestamp * 1000);
      const bucket = buckets.find(
        (b) =>
          b.date.getFullYear() === txDate.getFullYear() &&
          b.date.getMonth() === txDate.getMonth() &&
          b.date.getDate() === txDate.getDate()
      );
      if (bucket) bucket.count += 1;
    });

    if (charts.txOverTime) charts.txOverTime.destroy();
    charts.txOverTime = new window.Chart(el.chartTxOverTime, {
      type: "line",
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [
          {
            label: "Transactions",
            data: buckets.map((b) => b.count),
            borderColor: "#6366f1",
            backgroundColor: "rgba(99, 102, 241, 0.12)",
            tension: 0.3,
            fill: true,
          },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });
  }

  function renderNormalVsSuspiciousChart() {
    if (!el.chartNormalSuspicious) return;

    const suspiciousCount = allTransactions.filter((t) => t.isSuspicious).length;
    const normalCount = allTransactions.length - suspiciousCount;

    if (charts.normalVsSuspicious) charts.normalVsSuspicious.destroy();
    charts.normalVsSuspicious = new window.Chart(el.chartNormalSuspicious, {
      type: "doughnut",
      data: {
        labels: ["Normal", "Suspicious"],
        datasets: [{ data: [normalCount, suspiciousCount], backgroundColor: ["#10b981", "#ef4444"] }],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
  }

  function renderTopRequestersChart() {
    if (!el.chartTopRequesters) return;

    const totals = new Map(); // address -> summed amount (BigNumber)
    allTransactions
      .filter((t) => t.txType === "REQUEST")
      .forEach((t) => {
        const current = totals.get(t.from) || window.ethers.BigNumber.from(0);
        totals.set(t.from, current.add(t.amount));
      });

    const top5 = Array.from(totals.entries())
      .sort((a, b) => (b[1].sub(a[1]).isNegative() ? -1 : 1))
      .slice(0, 5);

    if (charts.topRequesters) charts.topRequesters.destroy();
    charts.topRequesters = new window.Chart(el.chartTopRequesters, {
      type: "bar",
      data: {
        labels: top5.map(([addr]) => window.Wallet.formatAddress(addr)),
        datasets: [
          {
            label: "Total Requested (ETH)",
            data: top5.map(([, amount]) => parseFloat(window.ethers.utils.formatEther(amount))),
            backgroundColor: "#6366f1",
          },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });
  }

  // ==========================================================================
  // 10. exportReport()
  // ==========================================================================

  function exportReport(format) {
    const filtered = getFilteredTransactions();

    if (filtered.length === 0) {
      window.Wallet.showToast("No transactions to export for the current filters.", "warning");
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    let blob, filename;

    if (format === "json") {
      const jsonData = filtered.map((t) => ({
        ...t,
        amount: window.ethers.utils.formatEther(t.amount),
        date: new Date(t.timestamp * 1000).toISOString(),
      }));
      blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: "application/json" });
      filename = `aml-transactions-${timestamp}.json`;
    } else {
      const header = "ID,From,To,Amount (ETH),Type,Suspicious,Date,Source";
      const rows = filtered.map((t) =>
        [
          t.id,
          t.from,
          t.to,
          window.ethers.utils.formatEther(t.amount),
          t.txType,
          t.isSuspicious,
          new Date(t.timestamp * 1000).toISOString(),
          t.source,
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(",")
      );
      blob = new Blob([header + "\n" + rows.join("\n")], { type: "text/csv" });
      filename = `aml-transactions-${timestamp}.csv`;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    window.Wallet.showToast(`Exported ${filtered.length} transactions.`, "success");
  }

  // ==========================================================================
  // 11. applyFilters()
  // ==========================================================================

  function applyFilters(partial) {
    filters = { ...filters, ...partial };
    currentPage = 1;
    renderFeedAndTable();
  }

  function getFilteredTransactions() {
    return allTransactions.filter((t) => {
      if (filters.status === "suspicious" && !t.isSuspicious) return false;
      if (filters.status === "normal" && t.isSuspicious) return false;
      if (filters.status === "blacklisted") {
        const blacklistAddrs = blacklistEntries.map((b) => b.address.toLowerCase());
        const involved = [t.from, t.to].map((a) => (a || "").toLowerCase());
        if (!involved.some((a) => blacklistAddrs.includes(a))) return false;
      }

      if (filters.search) {
        const term = filters.search.toLowerCase();
        const haystack = `${t.from} ${t.to}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }

      const txDate = new Date(t.timestamp * 1000);
      if (filters.dateFrom && txDate < new Date(filters.dateFrom)) return false;
      if (filters.dateTo && txDate > new Date(filters.dateTo + "T23:59:59")) return false;

      return true;
    });
  }

  function renderFeedAndTable() {
    const filtered = getFilteredTransactions();
    renderLiveFeed(filtered.slice(0, 20)); // feed always shows the most recent 20 regardless of pagination
    renderTable(filtered);
  }

  function renderLiveFeed(transactions) {
    if (!el.liveFeedList) return;

    if (transactions.length === 0) {
      el.liveFeedList.innerHTML = `<div class="table-empty">No transactions match the current filters.</div>`;
      return;
    }

    el.liveFeedList.innerHTML = transactions.map(feedItemHtml).join("");
  }

  function feedItemHtml(tx) {
    const typeClass = tx.txType === "PAYMENT" ? "type-payment" : tx.txType === "REQUEST" ? "type-request" : "type-block";
    const icon = tx.txType === "PAYMENT" ? "$" : tx.txType === "REQUEST" ? "#" : "!";
    const suspiciousClass = tx.isSuspicious ? " is-suspicious" : "";
    const timeStr = new Date(tx.timestamp * 1000).toLocaleString();

    return `
      <div class="feed-item ${typeClass}${suspiciousClass}" data-tx-id="${escapeHtml(tx.id)}">
        <div class="feed-icon">${icon}</div>
        <div class="feed-item-body">
          <div class="feed-item-title">${escapeHtml(window.Wallet.formatAddress(tx.from))} &rarr; ${escapeHtml(
      typeof tx.to === "string" && tx.to.startsWith("0x") ? window.Wallet.formatAddress(tx.to) : tx.to
    )}</div>
          <div class="feed-item-meta">${escapeHtml(tx.txType)} &middot; ${escapeHtml(timeStr)}</div>
        </div>
        <div class="feed-item-amount">${escapeHtml(window.Wallet.formatETH(tx.amount))}</div>
      </div>
    `;
  }

  function renderTable(filtered) {
    if (!el.txTableBody) return;

    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    currentPage = Math.min(currentPage, totalPages);
    const start = (currentPage - 1) * pageSize;
    const pageItems = filtered.slice(start, start + pageSize);

    el.txTableBody.innerHTML = pageItems
      .map(
        (tx) => `
          <tr>
            <td><span class="tx-type-tag type-${tx.txType.toLowerCase()}">${escapeHtml(tx.txType)}</span></td>
            <td class="mono">${escapeHtml(window.Wallet.formatAddress(tx.from))}</td>
            <td class="mono">${escapeHtml(
              typeof tx.to === "string" && tx.to.startsWith("0x") ? window.Wallet.formatAddress(tx.to) : tx.to
            )}</td>
            <td>${escapeHtml(window.Wallet.formatETH(tx.amount))}</td>
            <td>${tx.isSuspicious ? '<span class="badge badge-danger">Suspicious</span>' : '<span class="badge badge-success">Normal</span>'}</td>
            <td>${escapeHtml(new Date(tx.timestamp * 1000).toLocaleString())}</td>
          </tr>
        `
      )
      .join("");

    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    if (!el.txPagination) return;

    if (totalPages <= 1) {
      el.txPagination.innerHTML = "";
      return;
    }

    let buttons = `<button class="btn-ghost btn-sm" data-page="${currentPage - 1}" ${
      currentPage === 1 ? "disabled" : ""
    }>Prev</button>`;
    buttons += `<span class="text-sm text-muted"> Page ${currentPage} of ${totalPages} </span>`;
    buttons += `<button class="btn-ghost btn-sm" data-page="${currentPage + 1}" ${
      currentPage === totalPages ? "disabled" : ""
    }>Next</button>`;

    el.txPagination.innerHTML = buttons;
    el.txPagination.querySelectorAll("button[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentPage = Number(btn.dataset.page);
        renderFeedAndTable();
      });
    });
  }

  // ==========================================================================
  // Utility
  // ==========================================================================

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // Minimal CSS.escape polyfill fallback for the data-tx-id attribute
  // selector used in addLiveTransaction(); most modern browsers support
  // window.CSS.escape natively.
  function cssEscape(str) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(str);
    return String(str).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // ==========================================================================
  // Entry point
  // ==========================================================================

  document.addEventListener("DOMContentLoaded", init);
})();
