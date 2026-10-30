# 🛡️ AML Detection System
> Blockchain-Based Anti-Money Laundering Detection System

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Solidity](https://img.shields.io/badge/solidity-%5E0.8.19-363636?logo=solidity)
![Network](https://img.shields.io/badge/network-Sepolia-627eea?logo=ethereum)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

> **Project status: educational demo.** This is a learning/portfolio project, not an audited, production-grade AML compliance system. See [Known Limitations](#known-limitations) before relying on it for anything beyond a local demo.

---

## 📖 Table of Contents
1. [Overview](#-overview)
2. [Features](#-features)
3. [System Architecture](#-system-architecture)
4. [Tech Stack](#-tech-stack)
5. [User Roles](#-user-roles)
6. [Workflow](#-workflow)
7. [Installation](#-installation)
8. [Deployment](#-deployment)
9. [Usage](#-usage)
10. [Smart Contracts](#-smart-contracts)
11. [Project Structure](#-project-structure)
12. [Screenshots](#-screenshots)
13. [Testing](#-testing)
14. [Security](#-security)
15. [Known Limitations](#known-limitations)
16. [Roadmap](#-roadmap)
17. [Contributing](#-contributing)
18. [License](#-license)
19. [Contact](#-contact)

---

## 📌 Overview

The AML Detection System is a demonstration of how anti-money-laundering controls — transaction thresholds, blacklisting, and audit trails — can be enforced directly on-chain rather than bolted on as an off-chain compliance layer. Requesters ask for funds, Funders review and pay them, and an Admin dashboard monitors activity across the whole system in real time, all backed by four Solidity contracts on Ethereum.

Traditional AML compliance happens inside a bank's internal systems: opaque, centralized, and auditable only by the institution itself. By moving the core rules — registration, request/approval flow, threshold-based flagging, and blacklist enforcement — into smart contracts, every action becomes a public, immutable, independently verifiable event. Nobody (including the system's own admin) can quietly approve a payment, remove a blacklist entry, or edit history without it being visible on-chain forever.

This project pairs that contract layer with a role-based frontend (separate login/dashboard pages for Requesters, Funders, and Admins) so the full request → review → pay → monitor lifecycle can be exercised end-to-end against a local Hardhat node or a public testnet like Sepolia.

## ✨ Features

- 🔐 MetaMask wallet authentication
- 👥 Role-based access (Requester, Funder, Admin)
- 💰 Peer-to-peer fund transfers, paid directly wallet-to-wallet via smart contract
- 🚨 Automated AML threshold checks on both requests and payments
- 🚫 Real-time address blacklisting, enforced on-chain
- 📊 Live monitoring dashboard with charts and transaction feed
- 🔍 Complete transaction audit trail via contract events
- ⛓️ Immutable on-chain records — no action can be silently edited or deleted
- ⚡ Real-time event notifications across all five frontend pages
- 📱 Responsive UI, mobile-friendly down to 480px

## 🏗️ System Architecture

```
                         ┌──────────────────────────┐
                         │        AMLSystem          │
                         │  (admin control, blacklist,│
                         │   thresholds, tx logging)  │
                         └─────────────┬─────────────┘
                                       │ reads/links
                 ┌─────────────────────┼─────────────────────┐
                 │                     │                     │
                 ▼                     ▼                     ▼
      ┌────────────────────┐ ┌────────────────────┐ ┌──────────────────────┐
      │   UserRegistry      │ │    FundRequest      │ │   PaymentProcessor    │
      │ roles, blacklist,   │ │ request lifecycle,  │ │ approve + pay, AML    │
      │ registration        │ │ pending queue        │◄─┤ threshold flagging   │
      └─────────▲───────────┘ └─────────▲────────────┘ └───────────▲───────────┘
                │                       │                           │
                │  registers /          │  creates /                │  approves /
                │  looks up users       │  cancels requests         │  rejects + pays
                │                       │                           │
      ┌─────────┴───────────────────────┴───────────────────────────┴───────────┐
      │                              Frontend (5 pages)                          │
      │  Login → Request (Requester) → Dashboard+Review (Funder) → Monitor (Admin)│
      │           MetaMask / ethers.js v5  ·  shared config.js + metamask.js      │
      └───────────────────────────────────────────────────────────────────────────┘
```

Requests and payments flow strictly in one direction — `UserRegistry` has no knowledge of `FundRequest`, which has no knowledge of `PaymentProcessor` — while `AMLSystem` sits above all three as an admin/monitoring layer with its own independent blacklist and threshold. See [Known Limitations](#known-limitations) for how that layering currently falls short of full integration.

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Smart contracts | Solidity `^0.8.19` |
| Contract framework | Hardhat `^2.19` |
| Contract interaction (Hardhat scripts) | ethers.js `^5.7.2` (legacy `@nomiclabs/hardhat-ethers` + `hardhat-waffle` stack) |
| Contract interaction (frontend) | ethers.js v5 (CDN UMD build) |
| Wallet | MetaMask |
| Frontend | Vanilla HTML / CSS / JavaScript (no framework/bundler) |
| Charts | Chart.js v4 |
| Icons | Font Awesome 6 |
| Font | Inter (Google Fonts) |
| Testing | Mocha + Chai + `solidity-coverage` |
| Gas reporting | `hardhat-gas-reporter` |
| Contract verification | `@nomiclabs/hardhat-etherscan` |
| Target network | Sepolia testnet (configurable) |

## 👥 User Roles

| Role | Can do | Cannot do |
|---|---|---|
| **Requester** 🆘 | Register, create fund requests, cancel their own pending requests, view their own request history | Approve/reject any request, see other users' requests, access admin controls |
| **Funder** 💎 | Register, view all pending requests system-wide, approve + pay a request, reject a request with a reason | Create fund requests, access admin controls, edit thresholds/blacklist |
| **Admin** 🛡️ | Register, view the full monitoring dashboard, set the AML threshold, blacklist/whitelist addresses, view system-wide stats and charts | — (highest privilege in the frontend) |

> **Note:** the `ADMIN` value in `UserRegistry`'s role enum is a *label only* — it does not itself grant contract-level authority. Real administrative power over `AMLSystem` and its blacklist/threshold functions belongs exclusively to whichever address deployed `AMLSystem` (`AMLSystem.admin()`). See [Security](#-security).

## 🔄 Workflow

```
1. Connect wallet → Register (choose Requester / Funder / Admin) → role-based redirect
2. Requester:  submit request (amount, purpose, urgency)
3. Funder:     browse pending requests → review AML check + balance comparison → approve & pay, or reject
4. Contract:   transfers ETH requester←funder atomically; flags payment if amount exceeds threshold
5. Admin:      monitors all activity live, manages blacklist, tunes the suspicious-amount threshold
```

## ⚙️ Installation

```bash
# Clone the repository
git clone https://github.com/your-username/aml-detection-system.git
cd aml-detection-system

# Install dependencies
npm install

# Copy the environment template and fill in your own values
cp .env.example .env   # see .env's own comments for what each variable is
```

Required in `.env` before deploying anywhere but a local Hardhat node: `PRIVATE_KEY`, `SEPOLIA_RPC_URL` (from Infura/Alchemy), and `ETHERSCAN_API_KEY` (optional, only needed for `npm run verify`). **Never commit `.env`.**

## 🚀 Deployment

```bash
# 1. Compile contracts
npm run compile

# 2a. Local development: start a persistent local node in one terminal...
npm run node

# 2b. ...then, in a second terminal, deploy to it
npm run deploy:local

# Optional: populate the local deployment with demo users/requests/payments
npm run seed

# 3. Deploy to Sepolia testnet (requires PRIVATE_KEY + SEPOLIA_RPC_URL in .env,
#    and Sepolia ETH in the deployer wallet — get some from a faucet first)
npm run deploy:sepolia

# 4. Verify the deployed contracts on Etherscan (requires ETHERSCAN_API_KEY)
npx hardhat verify --network sepolia <CONTRACT_ADDRESS> <constructor-args>
```

`scripts/deploy.js` deploys all four contracts in dependency order (`UserRegistry` → `FundRequest` → `PaymentProcessor` → `AMLSystem`), wires up the cross-contract permissions they need, and writes the resulting addresses to both `deployments.json` and `frontend/js/config.js` automatically.

## 🖥️ Usage

1. Open `frontend/pages/page1-login.html` (served via any static file server — opening it directly as a `file://` URL will block MetaMask's provider injection in some browsers, so `npx http-server frontend` or similar is recommended).
2. Connect MetaMask, pointed at whichever network you deployed to.
3. Register with a name, role, and (if Funder) stated annual income.
4. You'll be redirected automatically based on role:
   - **Requester** → request dashboard
   - **Funder** → pending-requests dashboard
   - **Admin** → monitoring dashboard

## 📜 Smart Contracts

| Contract | Responsibility | Key functions |
|---|---|---|
| `UserRegistry.sol` | User registration, roles, per-user blacklist flag | `registerUser`, `blacklistUser`, `getUserInfo` |
| `FundRequest.sol` | Fund request lifecycle (create/cancel/approve/reject/complete) | `createRequest`, `cancelRequest`, `getPendingRequests` |
| `PaymentProcessor.sol` | Approval + atomic ETH transfer, AML amount flagging | `approveAndPay`, `rejectRequest`, `setThreshold` |
| `AMLSystem.sol` | Admin control: system-wide blacklist, threshold, transaction log, aggregate stats | `blacklistAddress`, `setThreshold`, `getSystemStats` |

Full NatSpec documentation is included in each contract file. All four target Solidity `^0.8.19` under the MIT license.

## 📁 Project Structure

```
aml-detection-system/
│
├── contracts/
│   ├── UserRegistry.sol
│   ├── FundRequest.sol
│   ├── PaymentProcessor.sol
│   └── AMLSystem.sol
│
├── scripts/
│   ├── deploy.js
│   └── seed-data.js
│
├── test/                        # Hardhat test suite (not yet written)
│
├── frontend/
│   ├── pages/
│   │   ├── page1-login.html
│   │   ├── page2-user-request.html
│   │   ├── page3-rich-login.html
│   │   ├── page4-approve-payment.html
│   │   └── page5-monitor.html   # pending
│   ├── css/
│   │   ├── common.css
│   │   ├── login.css
│   │   ├── request.css
│   │   ├── approve.css
│   │   └── monitor.css
│   └── js/
│       ├── config.js
│       ├── metamask.js
│       ├── page1-login.js
│       ├── page2-request.js
│       ├── page3-rich-login.js
│       ├── page4-approve.js
│       └── page5-monitor.js
│
├── .env                         # never commit
├── hardhat.config.js
├── package.json
└── README.md
```

## 📸 Screenshots

> Screenshots not yet captured — add them here once the frontend is deployed and running end-to-end. Suggested shots: login/role selection, requester dashboard with request cards, funder's AML check + balance comparison screen, and the admin monitoring dashboard with charts.

| Page | Preview |
|---|---|
| Login & Registration | _add screenshot_ |
| Requester Dashboard | _add screenshot_ |
| Funder Review Screen | _add screenshot_ |
| Admin Monitor | _add screenshot_ |

## 🧪 Testing

```bash
npm test              # run the Hardhat/Mocha test suite
npm run coverage       # generate a solidity-coverage report
npm run gas-report     # run tests with per-function gas usage printed
```

> ⚠️ No test files exist in `test/` yet — `npm test` will currently report zero tests. Writing the suite (unit tests per contract, plus an integration test covering the full request → approve → pay flow) is the top item in [Known Limitations](#known-limitations).

## 🔒 Security

- **Role labels vs. real authority:** `UserRegistry`'s `ADMIN` role is a display label only. Actual control over `AMLSystem` (blacklist, threshold) is gated by `AMLSystem.admin()`, set once at deployment to whichever address ran `deploy.js`.
- **Reentrancy:** `PaymentProcessor.approveAndPay()` sends ETH via a low-level `call` before finishing its own bookkeeping (payment record, registry counters, marking the request `COMPLETED`). This isn't currently exploitable — a reentrant call into `approveAndPay` for the same request fails because its status is no longer `PENDING` — but it doesn't follow strict checks-effects-interactions ordering either. Adding OpenZeppelin's `ReentrancyGuard` is recommended before this touches real funds.
- **No external audit.** This codebase has not been reviewed by a third-party security firm. Do not deploy to mainnet with real funds without one.
- **Private key hygiene:** see `.env`'s own security warnings. Use a dedicated low-value deployer wallet, never your primary wallet.
- Found a vulnerability? Please open a private security advisory rather than a public issue — see [Contact](#-contact).

## Known Limitations

Documented honestly here rather than glossed over, since several of these affect what actually works today:

- **`AMLSystem.logTransaction()` is never called.** It's `internal` with no caller anywhere in the codebase, so `AMLSystem.getAllTransactionLogs()` currently always returns an empty array, and its `TransactionLogged`/`SuspiciousActivityDetected` events never fire. The monitoring dashboard (`page5-monitor.js`) works around this by reconstructing its feed and charts directly from `FundRequest`'s and `PaymentProcessor`'s own events instead — functional, but means `AMLSystem`'s own audit log is currently decorative. Wiring real calls into it is the top contract-level fix needed.
- **Two independent blacklists exist** — `AMLSystem`'s own `blacklist` mapping and `UserRegistry`'s per-user `isBlacklisted` flag. They are not kept in sync automatically; blacklisting someone through one does not affect the other.
- **ethers v5/v6 mismatch**: `package.json`/`hardhat.config.js` pin the project to ethers v5, but `scripts/deploy.js` and `scripts/seed-data.js` were originally written using ethers v6 method calls (`waitForDeployment()`, `getAddress()`, `ethers.parseEther`). These need updating to v5 equivalents (`.deployed()`, `.address`, `ethers.utils.parseEther`) before `npm run deploy:local` will succeed.
- **`page5-monitor.html` has not been built yet** — `page5-monitor.js` and `monitor.css` are ready, but there's no HTML page wiring them together yet.
- **`.gitignore` has not been created yet.** Until it exists and excludes `.env`, `node_modules/`, `cache/`, and `artifacts/`, do not run `git add .`.
- **No automated test suite.** See [Testing](#-testing).
- **Contract ABIs in `frontend/js/config.js` are placeholders.** They must be pasted in from the compiled Hardhat artifacts after running `npm run compile`.

## 🗺️ Roadmap

- [ ] Wire `AMLSystem.logTransaction()` into `FundRequest`/`PaymentProcessor` so the admin's own audit log is real
- [ ] Unify the two blacklist systems into one source of truth
- [ ] Fix the ethers v5/v6 mismatch in deploy/seed scripts
- [ ] Build `page5-monitor.html`
- [ ] Write the Hardhat test suite (unit + integration)
- [ ] Add `.gitignore`
- [ ] Add `ReentrancyGuard` to `PaymentProcessor`
- [ ] Third-party security audit before any mainnet deployment
- [ ] ERC-20 token support alongside native ETH
- [ ] Multi-signature approval for large payments

## 🤝 Contributing

Contributions are welcome. Please:
1. Fork the repository and create a feature branch
2. Follow the existing code style (`npm run format` before committing)
3. Add or update tests for any behavior change
4. Open a pull request describing what changed and why

## 📄 License

Distributed under the MIT License. See `LICENSE` for details.

## 📬 Contact

Project maintainer: **Your Name** — replace with your actual contact details (email, Twitter/X, or a link to your GitHub profile) before publishing this README.

Project link: [https://github.com/your-username/aml-detection-system](https://github.com/your-username/aml-detection-system)
