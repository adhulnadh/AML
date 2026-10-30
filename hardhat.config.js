// hardhat.config.js
//
// Hardhat configuration for the AML Detection System contracts. Loads
// secrets/network URLs from .env (see that file's own comments), configures
// four networks (hardhat/localhost/sepolia/mainnet, plus goerli for
// completeness), enables the Solidity optimizer, and wires up gas reporting
// and Etherscan verification.

require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-etherscan");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("dotenv").config();

// Only use PRIVATE_KEY when it is a real 32-byte hex key. Hardhat validates
// EVERY network's accounts when the config loads, so the placeholder text
// in .env ("your_private_key_here") would otherwise crash even
// `npx hardhat compile` with an "invalid account" error. The .env file
// stores the key WITHOUT the 0x prefix; it is added here.
const RAW_KEY = process.env.PRIVATE_KEY || "";
const ACCOUNTS = /^(0x)?[0-9a-fA-F]{64}$/.test(RAW_KEY)
  ? ["0x" + RAW_KEY.replace(/^0x/, "")]
  : [];

// NOTE: this project uses the ethers v5 toolchain (@nomiclabs/hardhat-ethers).
// hardhat-waffle is intentionally NOT used (nothing needs it, and its
// ganache dependency is a common cause of failed installs on Windows).
// scripts/deploy.js and scripts/seed-data.js use v5-style calls
// (.deployed(), .address, ethers.utils.parseEther).

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  // --------------------------------------------------------------------
  // SOLIDITY COMPILER
  // --------------------------------------------------------------------
  // Version must match the `pragma solidity ^0.8.19;` line in every
  // contract (UserRegistry, FundRequest, PaymentProcessor, AMLSystem).
  // The optimizer trades compile time for cheaper deployed bytecode and
  // lower gas per call -- `runs: 200` is Hardhat's own suggested default,
  // tuned for contracts expected to be called many times after deployment
  // (as opposed to a low `runs` value, which favors cheaper deployment at
  // the cost of more expensive calls). viaIR enables the newer IR-based
  // codegen pipeline, which can produce better-optimized bytecode and
  // avoid "stack too deep" errors on more complex functions, at the cost
  // of somewhat slower compilation.
  solidity: {
    version: "0.8.19",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },

  // --------------------------------------------------------------------
  // NETWORKS
  // --------------------------------------------------------------------
  // Every network below reads its RPC URL / private key from
  // process.env, populated via .env + dotenv.config() above. Falling
  // back to "" / an empty accounts array (rather than throwing) means
  // `npx hardhat compile` and local-only tasks still work even before
  // .env is filled in -- only network-specific tasks (deploy, verify)
  // against sepolia/goerli/mainnet will fail, and only when actually
  // invoked against that network.
  networks: {
    // In-memory network Hardhat spins up automatically for `npx hardhat
    // test` and `npx hardhat run` with no --network flag. Resets on
    // every run; nothing persists between invocations.
    hardhat: {
      chainId: 1337,
      // Uncomment to fork mainnet state for integration testing against
      // real on-chain data/contracts without spending real ETH. Requires
      // MAINNET_RPC_URL to be set in .env.
      // forking: {
      //   url: process.env.MAINNET_RPC_URL,
      // },
    },

    // A separately-run persistent node (`npx hardhat node`), useful when
    // the frontend needs a stable RPC endpoint across multiple script
    // runs (e.g. deploy.js then seed-data.js then manually poking at
    // contracts), unlike the ephemeral `hardhat` network above.
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
    },

    // Sepolia -- the network referenced elsewhere in this project (see
    // config.js's NETWORK_CONFIG) and the recommended testnet target.
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: ACCOUNTS,
      chainId: 11155111,
      gasPrice: "auto",
    },

    // Goerli -- included for completeness per spec, but most faucets and
    // providers have deprecated it in favor of Sepolia/Holesky. Avoid
    // starting new work here.
    goerli: {
      url: process.env.GOERLI_RPC_URL || "",
      accounts: ACCOUNTS,
      chainId: 5,
    },

    // Ethereum Mainnet -- REAL FUNDS. Only point deployments here once
    // the contracts have been thoroughly tested on testnet and, ideally,
    // audited; see the security warnings already in .env.
    mainnet: {
      url: process.env.MAINNET_RPC_URL || "",
      accounts: ACCOUNTS,
      chainId: 1,
      gasPrice: "auto",
    },
  },

  // --------------------------------------------------------------------
  // ETHERSCAN VERIFICATION
  // --------------------------------------------------------------------
  // Powers `npx hardhat verify --network <network> <address> <constructor args>`,
  // which publishes contract source code so block explorers can decode
  // calls/events (and so users can read + trust the deployed bytecode
  // matches the source). One Etherscan API key now covers their unified
  // multi-chain v2 API, including Sepolia -- the same ETHERSCAN_API_KEY
  // value is reused for every network entry below.
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      goerli: process.env.ETHERSCAN_API_KEY || "",
    },
  },

  // --------------------------------------------------------------------
  // GAS REPORTER
  // --------------------------------------------------------------------
  // Prints a per-function gas-usage table after `npx hardhat test` when
  // enabled. Gated behind REPORT_GAS so it doesn't slow down every test
  // run by default -- run with `REPORT_GAS=true npx hardhat test` to
  // generate it on demand. The COINMARKETCAP_API_KEY (also optional) adds
  // a live USD cost column; without it, the report still shows gas units
  // and ETH cost, just not USD.
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    outputFile: "gas-report.txt",
    noColors: true,
  },

  // --------------------------------------------------------------------
  // PATHS
  // --------------------------------------------------------------------
  // Matches this project's existing file tree: contracts/ for .sol
  // sources, test/ for the (not yet written) Hardhat test suite,
  // cache/ and artifacts/ as Hardhat's own build output directories
  // (both should be in .gitignore, not committed).
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  // --------------------------------------------------------------------
  // MOCHA (test runner)
  // --------------------------------------------------------------------
  // 200-second timeout per test, well above Mocha's 2-second default --
  // necessary when a test suite deploys to and waits for confirmations
  // on a live testnet (e.g. Sepolia) rather than the instant-mining
  // in-memory hardhat network, where confirmation can take real wall-clock
  // time.
  mocha: {
    timeout: 200000,
  },
};
