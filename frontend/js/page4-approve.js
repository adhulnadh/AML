// frontend/js/page4-approve.js
//
// Page script for page4-approve-payment.html. Depends on config.js and
// metamask.js being loaded first. Expects a request ID to already be stored
// in localStorage under "aml_system:selected_request" by page3-rich-login.js
// (viewRequestDetails()) before this page is opened.
//
// EXPECTED HTML STRUCTURE (none generated yet for this page). Matches
// approve.css's classes from the earlier spec:
//
//   <div class="approve-page">
//     <div class="approve-container">
//       <div class="approve-page-header">
//         <h1>Review Request</h1>
//         <p id="funderBalanceDisplay"></p>
//       </div>
//
//       <div class="stats-row" id="statsRow"> <!-- optional, reused from page3 -->
//         ...
//       </div>
//
//       <div class="request-detail-card" id="requestDetailCard">
//         <div class="request-detail-header">
//           <div class="request-detail-requester">
//             <div class="requester-avatar"></div>
//             <div>
//               <div class="requester-name" id="requesterName"></div>
//               <div class="requester-address" id="requesterAddress"></div>
//             </div>
//           </div>
//           <span class="badge" id="requesterReputationBadge"></span>
//         </div>
//
//         <div class="request-detail-body">
//           <div class="request-detail-amount">
//             <span class="amount-value" id="requestAmount"></span>
//             <span class="amount-unit">ETH</span>
//           </div>
//           <div class="detail-field">
//             <div class="detail-field-label">Urgency</div>
//             <div class="detail-field-value" id="requestUrgency"></div>
//           </div>
//           <div class="detail-field">
//             <div class="detail-field-label">Submitted</div>
//             <div class="detail-field-value" id="requestDate"></div>
//           </div>
//           <div class="detail-field detail-purpose">
//             <div class="detail-field-label">Purpose</div>
//             <div class="detail-field-value" id="requestPurpose"></div>
//           </div>
//         </div>
//
//         <div class="aml-check-box" id="amlCheckBox"></div>
//         <div class="balance-comparison" id="balanceComparison"></div>
//         <div class="tx-preview" id="txPreview"></div>
//
//         <div class="action-buttons">
//           <button id="rejectBtn" class="btn-reject">Reject</button>
//           <button id="approveBtn" class="btn-approve">Approve &amp; Pay</button>
//         </div>
//       </div>
//
//       <div id="requestErrorBanner" class="alert-banner alert-danger hidden"></div>
//     </div>
//   </div>

(function () {
  "use strict";

  // ==========================================================================
  // Module state
  // ==========================================================================

  let funderAddress = null;
  let requestId = null;
  let currentRequest = null; // raw struct from FundRequest.getRequest()
  let requesterInfo = null; // raw struct from UserRegistry.getUserInfo()
  let paymentProcessorContract = null; // signer-backed
  let fundRequestContract = null; // provider-backed, read-only here

  const SELECTED_REQUEST_KEY = "aml_system:selected_request";

  // ==========================================================================
  // DOM references
  // ==========================================================================

  const el = {
    funderBalanceDisplay: document.getElementById("funderBalanceDisplay"),
    requestDetailCard: document.getElementById("requestDetailCard"),
    requesterName: document.getElementById("requesterName"),
    requesterAddress: document.getElementById("requesterAddress"),
    requesterReputationBadge: document.getElementById("requesterReputationBadge"),
    requestAmount: document.getElementById("requestAmount"),
    requestUrgency: document.getElementById("requestUrgency"),
    requestDate: document.getElementById("requestDate"),
    requestPurpose: document.getElementById("requestPurpose"),
    amlCheckBox: document.getElementById("amlCheckBox"),
    balanceComparison: document.getElementById("balanceComparison"),
    txPreview: document.getElementById("txPreview"),
    rejectBtn: document.getElementById("rejectBtn"),
    approveBtn: document.getElementById("approveBtn"),
    requestErrorBanner: document.getElementById("requestErrorBanner"),
  };

  const URGENCY_LABEL = ["Low", "Medium", "High"];

  // ==========================================================================
  // 1. init()
  // ==========================================================================

  async function init() {
    if (!window.Wallet || !window.CONFIG) {
      console.error("[page4-approve] Wallet/CONFIG not available -- check script load order.");
      return;
    }

    if (!window.Wallet.requireConnection()) {
      return;
    }

    const storedUser = window.Wallet.getStoredUser();
    funderAddress = storedUser.address;

    requestId = localStorage.getItem(SELECTED_REQUEST_KEY);
    if (!requestId) {
      showFatalError("No request selected. Please choose a request from your dashboard.");
      return;
    }

    try {
      window.Wallet.showLoading("Loading request...");

      const userRegistry = window.Wallet.getContract("userRegistry", window.Wallet.getProvider());
      if (!userRegistry) {
        window.Wallet.hideLoading();
        return;
      }

      // Verify FUNDER role on-chain -- same reasoning as page2/page3: this
      // is a UX guard, the contracts enforce the real access control.
      const onChainRole = Number(await userRegistry.getUserRole(funderAddress));
      if (onChainRole !== window.CONFIG.ROLES.FUNDER) {
        window.Wallet.hideLoading();
        window.Wallet.showToast("This page is only available to Funders.", "error");
        redirectToCorrectPage(onChainRole);
        return;
      }

      fundRequestContract = window.Wallet.getContract("fundRequest", window.Wallet.getProvider());
      paymentProcessorContract = window.Wallet.getContract(
        "paymentProcessor",
        window.Wallet.getSigner()
      );

      const request = await loadRequestDetails(requestId);
      if (!request) {
        window.Wallet.hideLoading();
        return; // loadRequestDetails already showed the error state
      }

      await loadRequesterInfo(request.requester);
      await refreshBalanceAndChecks();
      await showTxPreview();
      setupButtons();

      window.Wallet.hideLoading();
    } catch (error) {
      window.Wallet.hideLoading();
      console.error("[page4-approve] init failed:", error);
      window.Wallet.showToast("Failed to load this request.", "error");
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

  function showFatalError(message) {
    window.Wallet.showToast(message, "error");
    if (el.requestDetailCard) el.requestDetailCard.classList.add("hidden");
    if (el.requestErrorBanner) {
      el.requestErrorBanner.classList.remove("hidden");
      el.requestErrorBanner.innerHTML = `
        <div class="alert-icon">!</div>
        <div class="alert-body">
          <div class="alert-title">Cannot display this request</div>
          <div class="alert-message"></div>
        </div>
      `;
      el.requestErrorBanner.querySelector(".alert-message").textContent = message;
    }
  }

  // ==========================================================================
  // 2. loadRequestDetails(requestId)
  // ==========================================================================

  async function loadRequestDetails(id) {
    try {
      const request = await fundRequestContract.getRequest(id);

      // getRequest() on a never-created ID returns a zero-initialized
      // struct rather than reverting -- requester will be the zero address.
      if (
        !request ||
        request.requester === "0x0000000000000000000000000000000000000000"
      ) {
        showFatalError(`Request #${id} does not exist.`);
        return null;
      }

      if (Number(request.status) !== window.CONFIG.REQUEST_STATUS.PENDING) {
        const statusLabel = window.CONFIG.STATUS_LABELS[Number(request.status)] || "unknown";
        showFatalError(
          `Request #${id} is no longer pending (current status: ${statusLabel}). It may have already been handled.`
        );
        return null;
      }

      currentRequest = request;

      if (el.requestAmount) {
        el.requestAmount.textContent = window.Wallet.formatETH(request.amount).replace(" ETH", "");
      }
      if (el.requestUrgency) {
        el.requestUrgency.textContent = URGENCY_LABEL[Number(request.urgency)] || "Medium";
      }
      if (el.requestDate) {
        el.requestDate.textContent = new Date(Number(request.createdAt) * 1000).toLocaleString();
      }
      if (el.requestPurpose) {
        el.requestPurpose.textContent = request.purpose;
      }

      return request;
    } catch (error) {
      console.error("[page4-approve] loadRequestDetails failed:", error);
      showFatalError("Could not load this request from the blockchain.");
      return null;
    }
  }

  // ==========================================================================
  // 3. loadRequesterInfo(address)
  // ==========================================================================

  async function loadRequesterInfo(address) {
    try {
      const userRegistry = window.Wallet.getContract("userRegistry", window.Wallet.getProvider());
      const info = await userRegistry.getUserInfo(address);
      requesterInfo = info;

      if (el.requesterName) el.requesterName.textContent = info.name;
      if (el.requesterAddress) {
        el.requesterAddress.textContent = window.Wallet.formatAddress(address);
        el.requesterAddress.title = address;
      }
      if (el.requesterReputationBadge) {
        el.requesterReputationBadge.textContent = `${info.totalRequests.toString()} past requests`;
        el.requesterReputationBadge.className = info.isBlacklisted
          ? "badge badge-danger"
          : "badge badge-neutral";
      }

      return info;
    } catch (error) {
      console.error("[page4-approve] loadRequesterInfo failed:", error);
      window.Wallet.showToast("Could not load requester info.", "error");
      return null;
    }
  }

  // ==========================================================================
  // 4. runAMLCheck(request)
  //
  // Checks three things and renders a single clear/suspicious verdict box:
  //   1. Amount vs. the configured AML threshold
  //   2. Requester's blacklist status
  //   3. Funder's balance sufficiency
  //
  // NOTE: CONFIG.APP_CONFIG.amlThreshold is explicitly a DISPLAY-ONLY mirror
  // (see config.js's own comment on that field) -- PaymentProcessor.sol's
  // on-chain amlThreshold is the actual source of truth and can be changed
  // via setThreshold() independently of this frontend constant. This
  // function fetches the on-chain value and uses THAT for the real
  // suspicious/clear determination, only falling back to CONFIG's value if
  // the on-chain read fails, so the check reflects reality even if this
  // file's config.js goes stale.
  // ==========================================================================

  async function runAMLCheck(request) {
    const reasons = [];
    let isSuspicious = false;

    // -- 1. Amount vs. threshold --
    let thresholdWei;
    try {
      thresholdWei = await paymentProcessorContract.getThreshold();
    } catch (error) {
      console.warn(
        "[page4-approve] Could not read on-chain AML threshold, falling back to CONFIG.APP_CONFIG.amlThreshold",
        error
      );
      thresholdWei = window.Wallet.parseETH(window.CONFIG.APP_CONFIG.amlThreshold);
    }

    if (thresholdWei && request.amount.gt(thresholdWei)) {
      isSuspicious = true;
      reasons.push(
        `Amount (${window.Wallet.formatETH(request.amount)}) exceeds the AML threshold (${window.Wallet.formatETH(
          thresholdWei
        )}).`
      );
    }

    // -- 2. Requester blacklist status --
    if (requesterInfo && requesterInfo.isBlacklisted) {
      isSuspicious = true;
      reasons.push("Requester is blacklisted. This payment cannot be processed.");
    }

    // -- 3. Funder balance sufficiency --
    const balanceStr = await window.Wallet.getBalance(funderAddress);
    const balanceWei = balanceStr ? window.Wallet.parseETH(balanceStr) : null;
    const hasSufficientBalance = balanceWei ? balanceWei.gte(request.amount) : false;

    if (!hasSufficientBalance) {
      isSuspicious = true;
      reasons.push("Insufficient balance to cover this payment.");
    }

    renderAmlCheckBox(isSuspicious, reasons);

    return { isSuspicious, reasons, hasSufficientBalance };
  }

  function renderAmlCheckBox(isSuspicious, reasons) {
    if (!el.amlCheckBox) return;

    el.amlCheckBox.className = `aml-check-box ${isSuspicious ? "aml-suspicious" : "aml-clear"}`;

    if (isSuspicious) {
      el.amlCheckBox.innerHTML = `
        <div class="aml-check-icon">!</div>
        <div class="aml-check-body">
          <div class="aml-check-title">Suspicious</div>
          <div class="aml-check-detail">
            <ul></ul>
          </div>
        </div>
      `;
      const ul = el.amlCheckBox.querySelector("ul");
      reasons.forEach((reason) => {
        const li = document.createElement("li");
        li.textContent = reason;
        ul.appendChild(li);
      });
    } else {
      el.amlCheckBox.innerHTML = `
        <div class="aml-check-icon">&#10003;</div>
        <div class="aml-check-body">
          <div class="aml-check-title">Clear</div>
          <div class="aml-check-detail">No AML concerns detected for this request.</div>
        </div>
      `;
    }
  }

  // ==========================================================================
  // 5. showBalanceComparison(amount)
  // ==========================================================================

  async function showBalanceComparison(amountWei) {
    if (!el.balanceComparison) return;

    const balanceStr = await window.Wallet.getBalance(funderAddress);
    if (balanceStr === null) return;

    const balanceWei = window.Wallet.parseETH(balanceStr);
    const insufficientBalance = balanceWei.lt(amountWei);
    const afterWei = insufficientBalance ? window.ethers.BigNumber.from(0) : balanceWei.sub(amountWei);

    el.balanceComparison.innerHTML = `
      <div class="balance-side">
        <div class="balance-label">Current Balance</div>
        <div class="balance-value" id="balanceCurrentValue"></div>
      </div>
      <div class="balance-arrow">&rarr;</div>
      <div class="balance-side">
        <div class="balance-label">After Payment</div>
        <div class="balance-value balance-after" id="balanceAfterValue"></div>
      </div>
    `;
    el.balanceComparison.querySelector("#balanceCurrentValue").textContent = `${parseFloat(
      balanceStr
    ).toFixed(4)} ETH`;

    if (insufficientBalance) {
      el.balanceComparison.querySelector("#balanceAfterValue").textContent = "Insufficient balance";
      window.Wallet.showToast(
        "Your balance is insufficient to cover this payment.",
        "warning"
      );
    } else {
      el.balanceComparison.querySelector("#balanceAfterValue").textContent = `${parseFloat(
        window.ethers.utils.formatEther(afterWei)
      ).toFixed(4)} ETH`;
    }

    return !insufficientBalance;
  }

  async function refreshBalanceAndChecks() {
    if (el.funderBalanceDisplay) {
      const balance = await window.Wallet.getBalance(funderAddress);
      if (balance !== null) {
        el.funderBalanceDisplay.textContent = `Your balance: ${parseFloat(balance).toFixed(4)} ETH`;
      }
    }

    await showBalanceComparison(currentRequest.amount);
    await runAMLCheck(currentRequest);
  }

  // ==========================================================================
  // 8. showTxPreview()
  // (documented after showBalanceComparison in the file, but defined here so
  // it can be called from init() before the button handlers are wired up)
  // ==========================================================================

  async function showTxPreview() {
    if (!el.txPreview) return;

    el.txPreview.innerHTML = `
      <div class="tx-preview-header">
        <span class="tx-preview-title">MetaMask Transaction Preview</span>
      </div>
      <div class="tx-preview-row"><span class="tx-preview-key">To</span><span class="tx-preview-val" id="txPreviewTo"></span></div>
      <div class="tx-preview-row"><span class="tx-preview-key">Amount</span><span class="tx-preview-val" id="txPreviewAmount"></span></div>
      <div class="tx-preview-row"><span class="tx-preview-key">Estimated Gas</span><span class="tx-preview-val" id="txPreviewGas"></span></div>
      <div class="tx-preview-row tx-preview-total"><span class="tx-preview-key">Total Cost</span><span class="tx-preview-val" id="txPreviewTotal"></span></div>
      <div class="tx-preview-gas-note">Gas estimate is approximate and may change at confirmation time.</div>
    `;

    el.txPreview.querySelector("#txPreviewTo").textContent = window.CONFIG.CONTRACT_ADDRESSES.paymentProcessor;
    el.txPreview.querySelector("#txPreviewAmount").textContent = window.Wallet.formatETH(
      currentRequest.amount
    );

    try {
      const provider = window.Wallet.getProvider();
      const gasPrice = await provider.getGasPrice();
      const gasEstimate = await paymentProcessorContract.estimateGas.approveAndPay(requestId, {
        value: currentRequest.amount,
      });

      const gasCostWei = gasEstimate.mul(gasPrice);
      const totalWei = currentRequest.amount.add(gasCostWei);

      el.txPreview.querySelector("#txPreviewGas").textContent = `${gasEstimate.toString()} units (~${window.Wallet.formatETH(
        gasCostWei
      )})`;
      el.txPreview.querySelector("#txPreviewTotal").textContent = window.Wallet.formatETH(totalWei);
    } catch (error) {
      // Estimation can legitimately fail here (e.g. would-revert due to
      // insufficient balance, blacklisted requester, etc.) -- show a
      // fallback rather than blocking the whole page on it.
      console.warn("[page4-approve] Gas estimation failed:", error);
      el.txPreview.querySelector("#txPreviewGas").textContent = "Unavailable";
      el.txPreview.querySelector("#txPreviewTotal").textContent = `${window.Wallet.formatETH(
        currentRequest.amount
      )} + gas`;
    }
  }

  // ==========================================================================
  // Button wiring
  // ==========================================================================

  function setupButtons() {
    if (el.approveBtn) {
      el.approveBtn.addEventListener("click", confirmApprove);
    }
    if (el.rejectBtn) {
      el.rejectBtn.addEventListener("click", confirmReject);
    }
  }

  // ==========================================================================
  // 6. handleApprove() (invoked after a confirmation modal)
  // ==========================================================================

  function confirmApprove() {
    window.Wallet.showModal(
      "Confirm Payment",
      `
        <div class="confirmation-modal confirm-approve">
          <div class="confirmation-icon">&#10003;</div>
          <h3>Send ${escapeHtml(window.Wallet.formatETH(currentRequest.amount))}?</h3>
          <p>This will approve the request and transfer funds immediately. This action cannot be undone.</p>
        </div>
      `
    );

    const overlay = document.getElementById("wallet-modal-overlay");
    if (!overlay) return;

    const body = overlay.querySelector(".modal-body");
    const footer = document.createElement("div");
    footer.className = "modal-footer";
    footer.innerHTML = `
      <button class="btn btn-outline" id="cancelApproveBtn">Cancel</button>
      <button class="btn btn-approve" id="confirmApproveBtn">Confirm &amp; Pay</button>
    `;
    body.appendChild(footer);

    footer.querySelector("#cancelApproveBtn").addEventListener("click", window.Wallet.hideModal);
    footer.querySelector("#confirmApproveBtn").addEventListener("click", () => {
      window.Wallet.hideModal();
      handleApprove();
    });
  }

  async function handleApprove() {
    try {
      if (el.approveBtn) el.approveBtn.disabled = true;
      if (el.rejectBtn) el.rejectBtn.disabled = true;

      window.Wallet.showLoading("Confirm the payment in MetaMask...");

      const tx = await paymentProcessorContract.approveAndPay(requestId, {
        value: currentRequest.amount,
      });

      window.Wallet.showLoading("Waiting for confirmation on-chain...");
      const receipt = await tx.wait();

      window.Wallet.hideLoading();
      window.Wallet.showToast(
        `Payment sent! TxHash: ${window.Wallet.formatAddress(receipt.transactionHash)}`,
        "success"
      );

      localStorage.removeItem(SELECTED_REQUEST_KEY);

      setTimeout(() => {
        window.location.href = window.CONFIG.ROUTES.richLogin;
      }, 3000);
    } catch (error) {
      window.Wallet.hideLoading();
      if (el.approveBtn) el.approveBtn.disabled = false;
      if (el.rejectBtn) el.rejectBtn.disabled = false;

      console.error("[page4-approve] handleApprove failed:", error);

      if (error && (error.code === 4001 || error.code === "ACTION_REJECTED")) {
        window.Wallet.showToast("Payment cancelled.", "warning");
      } else if (error && /insufficient funds/i.test(error.message || "")) {
        window.Wallet.showToast("Insufficient funds to complete this payment.", "error");
      } else {
        window.Wallet.showToast((error && error.reason) || "Payment failed.", "error");
      }
    }
  }

  // ==========================================================================
  // 7. handleReject()
  // ==========================================================================

  const REJECTION_REASONS = [
    "Insufficient documentation",
    "Amount too high for stated purpose",
    "Suspicious activity",
    "Other",
  ];

  function confirmReject() {
    const optionsHtml = REJECTION_REASONS.map(
      (reason, i) => `
        <label class="rejection-reason-option" data-reason="${escapeHtml(reason)}">
          <input type="radio" name="rejectionReason" value="${i}" ${i === 0 ? "checked" : ""} />
          ${escapeHtml(reason)}
        </label>
      `
    ).join("");

    window.Wallet.showModal(
      "Reject Request",
      `
        <div class="rejection-modal">
          <p>Please select a reason for rejecting this request.</p>
          <div class="rejection-reason-options" id="rejectionReasonOptions">
            ${optionsHtml}
          </div>
          <div class="form-group mt-4">
            <label class="form-label" for="customRejectionReason">Additional details (optional)</label>
            <textarea id="customRejectionReason" class="form-textarea"></textarea>
          </div>
        </div>
      `
    );

    const overlay = document.getElementById("wallet-modal-overlay");
    if (!overlay) return;

    const optionsContainer = overlay.querySelector("#rejectionReasonOptions");
    optionsContainer.querySelectorAll(".rejection-reason-option").forEach((option) => {
      option.addEventListener("click", () => {
        optionsContainer
          .querySelectorAll(".rejection-reason-option")
          .forEach((o) => o.classList.remove("selected"));
        option.classList.add("selected");
        option.querySelector('input[type="radio"]').checked = true;
      });
    });
    // Default-select the first option visually.
    optionsContainer.querySelector(".rejection-reason-option").classList.add("selected");

    const body = overlay.querySelector(".modal-body");
    const footer = document.createElement("div");
    footer.className = "modal-footer";
    footer.innerHTML = `
      <button class="btn btn-outline" id="cancelRejectBtn">Cancel</button>
      <button class="btn-reject" id="confirmRejectBtn">Reject Request</button>
    `;
    body.appendChild(footer);

    footer.querySelector("#cancelRejectBtn").addEventListener("click", window.Wallet.hideModal);
    footer.querySelector("#confirmRejectBtn").addEventListener("click", () => {
      const selectedOption = optionsContainer.querySelector(".rejection-reason-option.selected");
      const baseReason = selectedOption ? selectedOption.dataset.reason : "Other";
      const customDetails = overlay.querySelector("#customRejectionReason").value.trim();
      const fullReason = customDetails ? `${baseReason}: ${customDetails}` : baseReason;

      window.Wallet.hideModal();
      handleReject(fullReason);
    });
  }

  async function handleReject(reason) {
    try {
      if (el.approveBtn) el.approveBtn.disabled = true;
      if (el.rejectBtn) el.rejectBtn.disabled = true;

      window.Wallet.showLoading("Confirm the rejection in MetaMask...");

      const tx = await paymentProcessorContract.rejectRequest(requestId, reason);

      window.Wallet.showLoading("Waiting for confirmation on-chain...");
      await tx.wait();

      window.Wallet.hideLoading();
      window.Wallet.showToast("Request rejected.", "info");

      localStorage.removeItem(SELECTED_REQUEST_KEY);

      setTimeout(() => {
        window.location.href = window.CONFIG.ROUTES.richLogin;
      }, 1500);
    } catch (error) {
      window.Wallet.hideLoading();
      if (el.approveBtn) el.approveBtn.disabled = false;
      if (el.rejectBtn) el.rejectBtn.disabled = false;

      console.error("[page4-approve] handleReject failed:", error);

      if (error && (error.code === 4001 || error.code === "ACTION_REJECTED")) {
        window.Wallet.showToast("Rejection cancelled.", "warning");
      } else {
        window.Wallet.showToast((error && error.reason) || "Failed to reject request.", "error");
      }
    }
  }

  // ==========================================================================
  // Utility
  // ==========================================================================

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // ==========================================================================
  // Entry point
  // ==========================================================================

  document.addEventListener("DOMContentLoaded", init);
})();
