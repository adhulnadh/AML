// scripts/blacklist.js
//
// Blacklists (or un-blacklists) a REGISTERED user in UserRegistry -- the
// blacklist that PaymentProcessor actually enforces. A blacklisted requester
// or funder cannot be paid / cannot pay: approveAndPay() reverts, so the
// transaction is blocked.
//
// Must be run by the UserRegistry admin, i.e. the account that ran
// deploy.js (Hardhat account #0). Hardhat's localhost network uses that
// account automatically.
//
// Usage (PowerShell):
//   $env:TARGET="0xYourRequesterAddress"
//   npx hardhat run scripts/blacklist.js --network localhost
//
// To undo:
//   $env:ACTION="whitelist"
//   npx hardhat run scripts/blacklist.js --network localhost
//   Remove-Item Env:ACTION

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const target = process.env.TARGET;
  const action = (process.env.ACTION || "blacklist").toLowerCase();

  if (!target || !hre.ethers.utils.isAddress(target)) {
    throw new Error(
      'Set TARGET to a valid wallet address first, e.g.  $env:TARGET="0x7099..."'
    );
  }
  if (action !== "blacklist" && action !== "whitelist") {
    throw new Error('ACTION must be "blacklist" or "whitelist".');
  }

  const deploymentsPath = path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error("deployments.json not found. Run `npm run deploy:local` first.");
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"))[hre.network.name];
  if (!deployment) {
    throw new Error(`No deployment recorded for network "${hre.network.name}".`);
  }

  // Find which local account is the UserRegistry admin (whoever deployed),
  // and sign with that one.
  const readOnly = await hre.ethers.getContractAt("UserRegistry", deployment.contracts.UserRegistry);
  const admin = await readOnly.admin();
  const signers = await hre.ethers.getSigners();
  const signer = signers.find((s) => s.address.toLowerCase() === admin.toLowerCase());
  if (!signer) {
    throw new Error(
      `UserRegistry admin is ${admin}, which is not one of this network's local accounts, ` +
        "so this script cannot sign for it."
    );
  }
  console.log(`Signing as UserRegistry admin: ${signer.address}`);
  const registry = readOnly.connect(signer);

  const info = await registry.getUserInfo(target);
  if (!info.isRegistered) {
    throw new Error(`${target} is not a registered user yet -- register it in the app first.`);
  }

  console.log(`${action === "blacklist" ? "Blacklisting" : "Whitelisting"}: ${info.name} (${target})`);

  const tx =
    action === "blacklist"
      ? await registry.blacklistUser(target)
      : await registry.whitelistUser(target);
  await tx.wait();

  const after = await registry.getUserInfo(target);
  console.log(`Done. isBlacklisted is now: ${after.isBlacklisted}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  });
