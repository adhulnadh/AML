// scripts/seed-data.js
//
// Populates a freshly-deployed AML system with demo data: registers three
// users, has the REQUESTER create three fund requests, has the FUNDER pay
// one of them, and has the admin blacklist one address -- then prints a
// summary of everything created.
//
// Usage:
//   npx hardhat run scripts/seed-data.js --network <networkName>
//
// Prerequisite: scripts/deploy.js must already have been run against the
// same network, so deployments.json has an entry for it.

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// UserRegistry.UserRole enum order: NONE, REQUESTER, FUNDER, ADMIN
const UserRole = { NONE: 0, REQUESTER: 1, FUNDER: 2, ADMIN: 3 };

// FundRequest.Urgency enum order: LOW, MEDIUM, HIGH
const Urgency = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Pulls the RequestCreated event out of a createRequest transaction receipt
 * so we know the real on-chain request ID, rather than assuming it matches
 * call order (safer if this script is ever re-run against a non-empty
 * deployment).
 */
function getRequestIdFromReceipt(receipt, fundRequestInterface) {
  for (const log of receipt.logs) {
    try {
      const parsed = fundRequestInterface.parseLog(log);
      if (parsed && parsed.name === "RequestCreated") {
        return parsed.args.id;
      }
    } catch (e) {
      // Log wasn't from FundRequest's ABI -- ignore and keep scanning.
    }
  }
  throw new Error("RequestCreated event not found in transaction receipt");
}

async function main() {
  console.log("=".repeat(60));
  console.log("AML SYSTEM -- SEED DATA");
  console.log("=".repeat(60));
  console.log(`Network: ${hre.network.name}`);

  // -----------------------------------------------------------------
  // 1. Load deployed contract addresses from deployments.json
  // -----------------------------------------------------------------
  const deploymentsPath = path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(
      `deployments.json not found at ${deploymentsPath}. Run scripts/deploy.js first.`
    );
  }

  const allDeployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  const deployment = allDeployments[hre.network.name];
  if (!deployment) {
    throw new Error(
      `No deployment recorded for network "${hre.network.name}" in deployments.json. ` +
        `Run scripts/deploy.js --network ${hre.network.name} first.`
    );
  }

  const { UserRegistry: userRegistryAddress, FundRequest: fundRequestAddress, PaymentProcessor: paymentProcessorAddress } =
    deployment.contracts;

  console.log("\nLoaded deployment addresses:");
  console.log(`  UserRegistry:     ${userRegistryAddress}`);
  console.log(`  FundRequest:      ${fundRequestAddress}`);
  console.log(`  PaymentProcessor: ${paymentProcessorAddress}`);

  const userRegistry = await hre.ethers.getContractAt("UserRegistry", userRegistryAddress);
  const fundRequest = await hre.ethers.getContractAt("FundRequest", fundRequestAddress);
  const paymentProcessor = await hre.ethers.getContractAt("PaymentProcessor", paymentProcessorAddress);

  // -----------------------------------------------------------------
  // 2. Get test signers
  // -----------------------------------------------------------------
  const signers = await hre.ethers.getSigners();
  if (signers.length < 3) {
    throw new Error("Need at least 3 signers available to seed data.");
  }
  const [alice, bob, adminWatch] = signers;

  console.log("\nTest signers:");
  console.log(`  Alice Poor (REQUESTER): ${alice.address}`);
  console.log(`  Bob Rich (FUNDER):      ${bob.address}`);
  console.log(`  Admin Watch (ADMIN):    ${adminWatch.address}`);

  // NOTE: signers[0] (Alice) is also whichever address ran deploy.js and is
  // therefore UserRegistry's admin (the deployer). Contract-level admin
  // power comes from that address matching UserRegistry.admin(), not from
  // the ADMIN *role* assigned to Admin Watch below -- the ADMIN role here
  // is just a label in the User struct, it grants no on-chain authority by
  // itself. We verify this explicitly before attempting the blacklist step.
  const onChainAdmin = await userRegistry.admin();
  if (onChainAdmin.toLowerCase() !== alice.address.toLowerCase()) {
    console.log(
      `\n  WARNING: UserRegistry.admin() (${onChainAdmin}) does not match signers[0] ` +
        `(${alice.address}). The blacklist step below will likely revert.`
    );
  }

  // -----------------------------------------------------------------
  // 3. Register 3 users
  // -----------------------------------------------------------------
  console.log("\n" + "-".repeat(60));
  console.log("Registering users...");

  const testUsers = [
    { signer: alice, name: "Alice Poor", role: UserRole.REQUESTER, income: "1000" },
    { signer: bob, name: "Bob Rich", role: UserRole.FUNDER, income: "100000" },
    { signer: adminWatch, name: "Admin Watch", role: UserRole.ADMIN, income: "0" },
  ];

  for (const user of testUsers) {
    try {
      const alreadyRegistered = await userRegistry.isUserRegistered(user.signer.address);
      if (alreadyRegistered) {
        console.log(`  SKIPPED: ${user.name} (${user.signer.address}) already registered`);
        continue;
      }

      const incomeWei = hre.ethers.utils.parseEther(user.income);
      const tx = await userRegistry
        .connect(user.signer)
        .registerUser(user.name, user.role, incomeWei);
      await tx.wait();

      console.log(`  Registered ${user.name} (${user.signer.address}) -- income: ${user.income} ETH`);
    } catch (err) {
      console.error(`  ERROR registering ${user.name}: ${err.message}`);
      throw err;
    }
  }

  // -----------------------------------------------------------------
  // 4. Create 3 fund requests from Alice
  // -----------------------------------------------------------------
  console.log("\n" + "-".repeat(60));
  console.log("Creating fund requests from Alice...");

  const requestPlans = [
    { amount: "0.5", purpose: "Education fees", urgency: Urgency.MEDIUM },
    { amount: "1.0", purpose: "Medical emergency", urgency: Urgency.HIGH },
    { amount: "2.0", purpose: "Business startup", urgency: Urgency.LOW },
  ];

  const createdRequestIds = [];

  for (const plan of requestPlans) {
    try {
      const amountWei = hre.ethers.utils.parseEther(plan.amount);
      const tx = await fundRequest
        .connect(alice)
        .createRequest(amountWei, plan.purpose, plan.urgency);
      const receipt = await tx.wait();

      const requestId = getRequestIdFromReceipt(receipt, fundRequest.interface);
      createdRequestIds.push(requestId);

      console.log(
        `  Created request #${requestId}: ${plan.amount} ETH for "${plan.purpose}" (urgency: ${
          Object.keys(Urgency)[plan.urgency]
        })`
      );
    } catch (err) {
      console.error(`  ERROR creating request "${plan.purpose}": ${err.message}`);
      throw err;
    }
  }

  // -----------------------------------------------------------------
  // 5. Bob approves and pays the first request (0.5 ETH)
  // -----------------------------------------------------------------
  console.log("\n" + "-".repeat(60));
  console.log("Bob approving and paying request #1...");

  try {
    const firstRequestId = createdRequestIds[0];
    const firstRequest = await fundRequest.getRequest(firstRequestId);

    const tx = await paymentProcessor
      .connect(bob)
      .approveAndPay(firstRequestId, { value: firstRequest.amount });
    await tx.wait();

    console.log(
      `  Bob paid ${hre.ethers.utils.formatEther(firstRequest.amount)} ETH for request #${firstRequestId}`
    );
  } catch (err) {
    console.error(`  ERROR approving/paying request: ${err.message}`);
    throw err;
  }

  // -----------------------------------------------------------------
  // 6. Admin blacklists one test address
  //
  // blacklistUser() requires the target to already be a registered user,
  // so we can't blacklist an arbitrary unregistered wallet here -- we pick
  // one of the three seeded accounts instead. Bob is used below (rather
  // than Alice, who is also the contract admin signer, or Admin Watch, who
  // is just a labeled role with no real authority) to keep the demo
  // scenario clear: a funder later flagged for review after already
  // completing a payment.
  // -----------------------------------------------------------------
  console.log("\n" + "-".repeat(60));
  console.log("Admin blacklisting a test address...");

  const blacklistTarget = bob;

  try {
    const tx = await userRegistry.connect(alice).blacklistUser(blacklistTarget.address);
    await tx.wait();
    console.log(`  Blacklisted: Bob Rich (${blacklistTarget.address})`);
  } catch (err) {
    console.error(`  ERROR blacklisting address: ${err.message}`);
    throw err;
  }

  // -----------------------------------------------------------------
  // 7. Print summary
  // -----------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("SEED DATA SUMMARY");
  console.log("=".repeat(60));

  console.table({
    "Alice Poor": { Address: alice.address, Role: "REQUESTER", "Income (ETH)": "1000" },
    "Bob Rich": { Address: bob.address, Role: "FUNDER", "Income (ETH)": "100000" },
    "Admin Watch": { Address: adminWatch.address, Role: "ADMIN", "Income (ETH)": "0" },
  });

  console.table({
    "Request #1 (paid)": { Amount: "0.5 ETH", Purpose: "Education fees", Urgency: "MEDIUM" },
    "Request #2": { Amount: "1.0 ETH", Purpose: "Medical emergency", Urgency: "HIGH" },
    "Request #3": { Amount: "2.0 ETH", Purpose: "Business startup", Urgency: "LOW" },
  });

  console.log(`Blacklisted address: ${blacklistTarget.address} (Bob Rich)`);
  console.log(`Total requests created: ${createdRequestIds.length}`);
  console.log(`Total payments made: 1`);
  console.log("=".repeat(60));
  console.log("Seed data complete.\n");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("\n" + "=".repeat(60));
      console.error("SEED DATA SCRIPT FAILED");
      console.error("=".repeat(60));
      console.error(error);
      process.exit(1);
    });
}

module.exports = main;
