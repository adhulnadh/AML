// scripts/deploy.js
//
// Deploys the four AML system contracts in dependency order, wires up the
// cross-contract permissions they need to call each other, and writes the
// resulting addresses out to both deployments.json and
// frontend/js/config.js so the frontend can pick them up immediately.
//
// Usage:
//   npx hardhat run scripts/deploy.js --network <networkName>

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  // The account that deploys becomes the on-chain ADMIN of UserRegistry and
  // AMLSystem. Defaults to account #0; set DEPLOYER_INDEX to use another
  // account, e.g. in PowerShell:  $env:DEPLOYER_INDEX="3"
  const signers = await hre.ethers.getSigners();
  const deployerIndex = Number(process.env.DEPLOYER_INDEX || 0);
  if (!signers[deployerIndex]) {
    throw new Error(
      `DEPLOYER_INDEX=${deployerIndex}, but only ${signers.length} accounts are available.`
    );
  }
  const deployer = signers[deployerIndex];

  console.log("=".repeat(60));
  console.log("AML SYSTEM DEPLOYMENT");
  console.log("=".repeat(60));
  console.log(`Network:   ${hre.network.name}`);
  console.log(`Deployer:  ${deployer.address}  (account #${deployerIndex} -> contract ADMIN)`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${hre.ethers.utils.formatEther(balance)} ETH`);
  console.log("-".repeat(60));

  // -----------------------------------------------------------------
  // 1. Deploy UserRegistry
  // -----------------------------------------------------------------
  console.log("\n[1/4] Deploying UserRegistry...");
  const UserRegistry = await hre.ethers.getContractFactory("UserRegistry", deployer);
  const userRegistry = await UserRegistry.deploy();
  await userRegistry.deployed();
  const userRegistryAddress = userRegistry.address;
  console.log(`      UserRegistry deployed at: ${userRegistryAddress}`);

  // -----------------------------------------------------------------
  // 2. Deploy FundRequest (needs UserRegistry address)
  // -----------------------------------------------------------------
  console.log("\n[2/4] Deploying FundRequest...");
  const FundRequest = await hre.ethers.getContractFactory("FundRequest", deployer);
  const fundRequest = await FundRequest.deploy(userRegistryAddress);
  await fundRequest.deployed();
  const fundRequestAddress = fundRequest.address;
  console.log(`      FundRequest deployed at: ${fundRequestAddress}`);

  // -----------------------------------------------------------------
  // 3. Deploy PaymentProcessor (needs UserRegistry + FundRequest addresses)
  // -----------------------------------------------------------------
  console.log("\n[3/4] Deploying PaymentProcessor...");
  const PaymentProcessor = await hre.ethers.getContractFactory("PaymentProcessor", deployer);
  const paymentProcessor = await PaymentProcessor.deploy(userRegistryAddress, fundRequestAddress);
  await paymentProcessor.deployed();
  const paymentProcessorAddress = paymentProcessor.address;
  console.log(`      PaymentProcessor deployed at: ${paymentProcessorAddress}`);

  // -----------------------------------------------------------------
  // 4. Deploy AMLSystem (needs all three prior addresses)
  // -----------------------------------------------------------------
  console.log("\n[4/4] Deploying AMLSystem...");
  const AMLSystem = await hre.ethers.getContractFactory("AMLSystem", deployer);
  const amlSystem = await AMLSystem.deploy(
    userRegistryAddress,
    fundRequestAddress,
    paymentProcessorAddress
  );
  await amlSystem.deployed();
  const amlSystemAddress = amlSystem.address;
  console.log(`      AMLSystem deployed at: ${amlSystemAddress}`);

  // -----------------------------------------------------------------
  // Post-deployment wiring: authorize contracts to call each other.
  // Without these calls, FundRequest/PaymentProcessor cannot update
  // UserRegistry's counters, and PaymentProcessor cannot advance a
  // request's status in FundRequest.
  // -----------------------------------------------------------------
  console.log("\n" + "-".repeat(60));
  console.log("Linking contracts...");

  let tx;

  tx = await userRegistry.setFundRequestContract(fundRequestAddress);
  await tx.wait();
  console.log("      UserRegistry.setFundRequestContract() -> FundRequest");

  tx = await userRegistry.setPaymentProcessorContract(paymentProcessorAddress);
  await tx.wait();
  console.log("      UserRegistry.setPaymentProcessorContract() -> PaymentProcessor");

  tx = await fundRequest.setPaymentProcessor(paymentProcessorAddress);
  await tx.wait();
  console.log("      FundRequest.setPaymentProcessor() -> PaymentProcessor");

  // -----------------------------------------------------------------
  // Admin ownership decision for UserRegistry.
  //
  // The task asks to either hand UserRegistry admin control to AMLSystem,
  // or keep the deployer as admin. As currently written, UserRegistry has
  // no transferAdmin()/transferOwnership() function -- only AMLSystem
  // exposes transferAdmin(). So UserRegistry's admin CANNOT be reassigned
  // to AMLSystem without adding that function to UserRegistry.sol first.
  //
  // Default choice here: keep the deployer as UserRegistry's admin. This
  // is the safer default for a demo, since AMLSystem currently maintains
  // its own SEPARATE blacklist rather than acting through UserRegistry's
  // blacklist/unblacklist functions (see the note left on AMLSystem.sol).
  // Flip TRANSFER_USER_REGISTRY_ADMIN_TO_AML_SYSTEM to true only after
  // adding a transferAdmin() function to UserRegistry.sol.
  // -----------------------------------------------------------------
  const TRANSFER_USER_REGISTRY_ADMIN_TO_AML_SYSTEM = false;

  if (TRANSFER_USER_REGISTRY_ADMIN_TO_AML_SYSTEM) {
    if (typeof userRegistry.transferAdmin !== "function") {
      console.log(
        "\n      SKIPPED: UserRegistry has no transferAdmin() function yet -- " +
          "add one before enabling this step."
      );
    } else {
      tx = await userRegistry.transferAdmin(amlSystemAddress);
      await tx.wait();
      console.log(`      UserRegistry admin transferred to AMLSystem (${amlSystemAddress})`);
    }
  } else {
    console.log(`\n      UserRegistry admin remains the deployer (${deployer.address})`);
  }

  // -----------------------------------------------------------------
  // Assemble deployment record
  // -----------------------------------------------------------------
  const deployment = {
    network: hre.network.name,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    userRegistryAdmin: TRANSFER_USER_REGISTRY_ADMIN_TO_AML_SYSTEM ? amlSystemAddress : deployer.address,
    contracts: {
      UserRegistry: userRegistryAddress,
      FundRequest: fundRequestAddress,
      PaymentProcessor: paymentProcessorAddress,
      AMLSystem: amlSystemAddress,
    },
  };

  // -----------------------------------------------------------------
  // Write deployments.json (project root)
  // -----------------------------------------------------------------
  const deploymentsPath = path.join(__dirname, "..", "deployments.json");
  let existingDeployments = {};
  if (fs.existsSync(deploymentsPath)) {
    try {
      existingDeployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    } catch (e) {
      console.log("\n      WARNING: could not parse existing deployments.json, overwriting it.");
    }
  }
  existingDeployments[hre.network.name] = deployment;
  fs.writeFileSync(deploymentsPath, JSON.stringify(existingDeployments, null, 2));
  console.log(`\n      Saved -> ${deploymentsPath}`);

  // -----------------------------------------------------------------
  // Write frontend/js/deployed.js
  //
  // Generated file holding the deployed addresses, the network, AND the
  // compiled ABIs (read straight from Hardhat's artifacts), exposed as
  // window.DEPLOYED. frontend/js/config.js (hand-written, never
  // overwritten) reads from it. This replaces the old behavior of
  // overwriting config.js itself, and removes the manual step of pasting
  // ABIs into config.js.
  // -----------------------------------------------------------------
  const abis = {
    userRegistry: (await hre.artifacts.readArtifact("UserRegistry")).abi,
    fundRequest: (await hre.artifacts.readArtifact("FundRequest")).abi,
    paymentProcessor: (await hre.artifacts.readArtifact("PaymentProcessor")).abi,
    amlSystem: (await hre.artifacts.readArtifact("AMLSystem")).abi,
  };

  const jsDir = path.join(__dirname, "..", "frontend", "js");
  fs.mkdirSync(jsDir, { recursive: true });
  const deployedPath = path.join(jsDir, "deployed.js");

  const deployedData = {
    network: {
      name: hre.network.name,
      chainId: deployment.chainId,
      chainIdHex: "0x" + Number(deployment.chainId).toString(16),
    },
    addresses: {
      userRegistry: userRegistryAddress,
      fundRequest: fundRequestAddress,
      paymentProcessor: paymentProcessorAddress,
      amlSystem: amlSystemAddress,
    },
    abis,
  };

  fs.writeFileSync(
    deployedPath,
    "// AUTO-GENERATED by scripts/deploy.js -- do not edit by hand.\n" +
      "// Network: " + hre.network.name + " | Generated: " + deployment.deployedAt + "\n" +
      "window.DEPLOYED = " + JSON.stringify(deployedData, null, 2) + ";\n"
  );
  console.log(`      Saved -> ${deployedPath}`);

  // -----------------------------------------------------------------
  // Summary table
  // -----------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.table({
    UserRegistry: { Address: userRegistryAddress },
    FundRequest: { Address: fundRequestAddress },
    PaymentProcessor: { Address: paymentProcessorAddress },
    AMLSystem: { Address: amlSystemAddress },
  });
  console.log(`Network:            ${hre.network.name}`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log(`UserRegistry admin: ${deployment.userRegistryAdmin}`);
  console.log("=".repeat(60));
  console.log("Deployment complete.\n");
}

// Allow this script to be run directly via `npx hardhat run scripts/deploy.js`
// AND to be imported/called programmatically (e.g. from a test file or
// another script) via `const main = require("./deploy"); await main();`
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("\n" + "=".repeat(60));
      console.error("DEPLOYMENT FAILED");
      console.error("=".repeat(60));
      console.error(error);
      process.exit(1);
    });
}

module.exports = main;
