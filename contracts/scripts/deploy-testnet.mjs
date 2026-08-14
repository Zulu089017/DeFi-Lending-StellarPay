#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────────
// Deploy all StellarPay Soroban contracts to Stellar testnet using
// @stellar/stellar-sdk v16 (no stellar CLI / soroban-cli required).
//
//   node stellar-contracts/scripts/deploy-testnet.mjs
//
// Behaviour:
//   • Secrets are read from stellar-contracts/.env (gitignored). Missing
//     secrets (admin + 3 attesters) are generated, funded via friendbot,
//     and persisted to .env.
//   • The 6 protocol contracts are uploaded & created, then initialized in
//     dependency order. Contract IDs are derived deterministically so re-runs
//     are idempotent.
//   • Writes sdk/src/manifest.json and stellar.toml with the live addresses.
//
// Contract ID derivation (verified against soroban-env-host 27 and the
// deployed testnet ledger): the host computes
//     sha256(HashIdPreimage::ContractId{ network_id, contract_id_preimage }.toXDR())
// NOT sha256(contract_id_preimage.toXDR()). network_id = sha256(network_passphrase).
// Using the bare-preimage hash yields addresses that exist nowhere on-chain and
// every call then fails with `Error(Storage, MissingValue)`. See
// soroban-env-host src/e2e_testutils.rs get_contract_id_hash().
//
// REDEPLOY AFTER A CODE CHANGE: salts are sha256(saltLabel) and do NOT depend
// on the wasm bytes. Re-running after rebuilding a contract hits "already
// exists" and resumes with the OLD deployed wasm. To deploy new code, bump the
// saltLabel (e.g. append a version suffix) or use a fresh admin keypair.
// ──────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.resolve(__dirname, "..");
const ROOT = path.resolve(CONTRACTS_DIR, "..");

// @stellar/stellar-sdk is a dependency of the `sdk` package (pnpm workspace),
// not the root. Anchor module resolution at sdk/package.json so this script
// runs from anywhere in the repo.
const require = createRequire(path.join(ROOT, "packages", "sdk", "package.json"));
const {
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
  rpc,
} = require("@stellar/stellar-sdk");
const ENV_FILE = path.join(CONTRACTS_DIR, ".env");
const WASM_DIR = path.join(CONTRACTS_DIR, "target", "wasm32v1-none", "release");
const MANIFEST_PATH = path.join(ROOT, "packages", "sdk", "src", "manifest.json");
const STELLAR_TOML_PATH = path.join(ROOT, "stellar.toml");

const RPC_URL = process.env.STELLAR_RPC ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const FRIENDBOT_URL = "https://friendbot.stellar.org";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────── env helpers ────────────────────────────────

function readEnv() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeEnv(env) {
  const lines = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(ENV_FILE, lines.join("\n") + "\n");
}

// ─────────────────────────────── RPC helpers ────────────────────────────────

// Poll Soroban RPC getTransaction via raw JSON-RPC. The installed stellar-sdk
// 12.3.0 bundles an older js-xdr whose TransactionMeta parsing predates the
// current testnet protocol, so we read the status string directly and skip XDR
// parsing of the result meta (we don't need it for deploy bookkeeping).
async function pollTransaction(_server, hash, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: { hash },
      }),
    });
    const j = await r.json();
    const res = j.result ?? {};
    if (res.status === "SUCCESS") return res;
    if (res.status === "FAILED") {
      throw new Error(`tx ${hash} failed: ${res.resultXdr ?? "(no result xdr)"}`);
    }
    await sleep(2000);
  }
  throw new Error(`tx ${hash} not confirmed after ${tries * 2}s`);
}

async function sendTx(server, tx, signer) {
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`send failed: ${sent.errorResultXdr}`);
  }
  return pollTransaction(server, sent.hash);
}

// Post-deploy read-back: confirm every contract actually has a live instance
// on-chain with initialized storage. This guards the resumability logic: a
// swallowed `initialize` trap must never result in a "successful" deploy that
// is secretly uninitialized. Throws if any contract fails the check.
async function verifyOnChain(ids) {
  console.log("▶ verifying on-chain state...");
  const keys = Object.entries(ids).map(([name, cid]) => {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(cid)),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    return { name, cid, key };
  });

  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLedgerEntries",
      params: { keys: keys.map((k) => k.key.toXDR("base64")) },
    }),
  });
  const j = await r.json();
  const entries = j.result?.entries ?? [];
  const found = new Map(entries.map((e) => [e.key, e.xdr]));

  for (const { name, cid, key } of keys) {
    const keyB64 = key.toXDR("base64");
    const entryXdr = found.get(keyB64);
    if (!entryXdr) {
      throw new Error(
        `verify failed: ${name} (${cid}) has no contract-instance entry on-chain — ` +
          `contract was never created or was created at a different address`,
      );
    }
    // A created-but-never-initialized contract still has a (empty) instance
    // entry, so presence alone proves nothing. Decode the entry and require a
    // non-empty instance storage map: `initialize` always writes ≥1 key
    // (Admin, and for wrapped_asset also Minter/Metadata/TotalSupply).
    //
    // getLedgerEntries returns `xdr` as a base64 LedgerEntryData, whose
    // contractData() arm holds the ContractDataEntry; val() is then an ScVal
    // with arm scvContractInstance. In @stellar/js-xdr v4 the arm ACCESSOR is
    // `val.instance()` (the arm CONSTRUCTOR is `scvContractInstance(...)`),
    // and ScContractInstance.storage() is a plain Array of ScMapEntry.
    const data = xdr.LedgerEntryData.fromXDR(entryXdr, "base64").contractData();
    let storageLen = 0;
    try {
      const storage = data.val().instance().storage();
      if (storage) storageLen = storage.length;
    } catch {
      storageLen = -1; // unexpected ScVal shape — treat as unverified
    }
    if (storageLen <= 0) {
      const why =
        storageLen === -1
          ? "instance ScVal shape could not be decoded"
          : "instance storage is empty";
      throw new Error(
        `verify failed: ${name} (${cid}) ${why} (len=${storageLen}) — ` +
          `initialize likely never succeeded`,
      );
    }
    console.log(`  ✔ ${name} (${cid.slice(0, 12)}…) initialized (${storageLen} storage keys)`);
  }
}

async function ensureFunded(server, kp) {
  try {
    const acc = await server.getAccount(kp.publicKey());
    const native = acc.balances?.find((b) => b.asset_type === "native");
    console.log(`  ${kp.publicKey()} funded (${native?.balance ?? "?"} XLM)`);
    return;
  } catch {
    /* account does not exist yet */
  }
  console.log(`  funding ${kp.publicKey()} via friendbot...`);
  const r = await fetch(`${FRIENDBOT_URL}?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot failed: ${await r.text()}`);
  await sleep(3000); // let the account become visible
}

// ─────────────────────────────── host functions ─────────────────────────────

async function uploadWasm(server, admin, wasm) {
  const source = await server.getAccount(admin.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeUploadContractWasm(wasm),
        auth: [],
      }),
    )
    .setTimeout(0)
    .build();
  await sendTx(server, tx, admin);
  return createHash("sha256").update(wasm).digest(); // wasm id = sha256(wasm)
}

// network_id = sha256(network_passphrase); part of the HashIdPreimage envelope.
const NETWORK_ID = createHash("sha256").update(NETWORK_PASSPHRASE).digest();

// Deterministic preimage for a CONTRACT_ID_PREIMAGE_FROM_ADDRESS creation.
// salt = sha256(saltLabel), so re-running the deploy yields identical addresses.
function buildPreimage(adminPublicKeyEd25519, saltLabel) {
  return xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: xdr.ScAddress.scAddressTypeAccount(
        xdr.PublicKey.publicKeyTypeEd25519(adminPublicKeyEd25519),
      ),
      salt: createHash("sha256").update(saltLabel).digest(),
    }),
  );
}

// Contract ID from a preimage: sha256(HashIdPreimage::ContractId envelope).
function deriveContractId(preimage) {
  const hashIdPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: NETWORK_ID,
      contractIdPreimage: preimage,
    }),
  );
  return StrKey.encodeContract(createHash("sha256").update(hashIdPreimage.toXDR()).digest());
}

async function createContract(server, admin, wasmHash, saltLabel) {
  const preimage = buildPreimage(admin.rawPublicKey(), saltLabel);
  const contractId = deriveContractId(preimage);
  const source = await server.getAccount(admin.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeCreateContract(
          new xdr.CreateContractArgs({
            contractIdPreimage: preimage,
            executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
          }),
        ),
        auth: [],
      }),
    )
    .setTimeout(0)
    .build();
  try {
    await sendTx(server, tx, admin);
  } catch (err) {
    // Deterministic salts ⇒ a re-run of a partially completed deploy hits
    // "contract already exists" during prepareTransaction/send. Treat that as
    // success so the deploy is resumable; the derived id is authoritative.
    const msg = String(err.message ?? err);
    if (/already exists/.test(msg)) {
      console.log(`    ${contractId} already exists (resumed)`);
      return contractId;
    }
    throw err;
  }
  return contractId;
}

async function invoke(server, admin, contractId, fn, args) {
  const source = await server.getAccount(admin.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: contractId, function: fn, args }),
    )
    .setTimeout(0)
    .build();
  try {
    await sendTx(server, tx, admin);
  } catch (err) {
    // Resumability: a partially-completed deploy may have already initialized
    // some contracts. `initialize` panics with "already initialized" in that
    // case — treat it as success so re-runs pick up where they left off.
    //
    // Note: the contract's `panic!` surfaces as a WASM trap in the simulation
    // error string ("VM call trapped: UnreachableCodeReached, initialize"), so
    // we also match the trap. `initialize` only ever panics with "already
    // initialized" in these contracts, so this cannot mask a real failure.
    const msg = String(err.message ?? err);
    if (fn === "initialize" && /already initialized|UnreachableCodeReached/.test(msg)) {
      console.log(`    ${contractId}.${fn} already initialized (resumed)`);
      return;
    }
    throw err;
  }
}

// ScVal builders
const addr = (s) => new Address(s).toScVal();
const u32 = (n) => xdr.ScVal.scvU32(n);
const str = (s) => xdr.ScVal.scvString(s);
const bytes = (b) => xdr.ScVal.scvBytes(b);
const mapEntry = (key, val) =>
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

// ─────────────────────────────────── main ───────────────────────────────────

async function main() {
  console.log("▶ StellarPay testnet deploy (stellar-sdk v16)");
  const server = new rpc.Server(RPC_URL);

  const env = readEnv();

  // 1. Secrets: admin + 3 attesters (ed25519). Bridge BytesN<32> = attester A's
  //    raw public key, matching the off-chain signer (bridge/src/attest/signer.ts).
  const admin = env.STELLAR_ADMIN_SECRET
    ? Keypair.fromSecret(env.STELLAR_ADMIN_SECRET)
    : Keypair.random();
  const attA = env.STELLAR_ATTESTER_A_SECRET
    ? Keypair.fromSecret(env.STELLAR_ATTESTER_A_SECRET)
    : Keypair.random();
  const attB = env.STELLAR_ATTESTER_B_SECRET
    ? Keypair.fromSecret(env.STELLAR_ATTESTER_B_SECRET)
    : Keypair.random();
  const attC = env.STELLAR_ATTESTER_C_SECRET
    ? Keypair.fromSecret(env.STELLAR_ATTESTER_C_SECRET)
    : Keypair.random();

  const newEnv = {
    ...env,
    STELLAR_ADMIN_SECRET: admin.secret(),
    STELLAR_ATTESTER_A_SECRET: attA.secret(),
    STELLAR_ATTESTER_B_SECRET: attB.secret(),
    STELLAR_ATTESTER_C_SECRET: attC.secret(),
  };
  writeEnv(newEnv);

  console.log("  admin    :", admin.publicKey());
  console.log("  attesterA:", attA.publicKey());
  console.log("  attesterB:", attB.publicKey());
  console.log("  attesterC:", attC.publicKey());

  // 2. Idempotency: if all contracts are already pinned in .env, verify on-chain
  //    and regenerate the manifest/toml, but don't redeploy.
  const pinned = ["WRAPPED_ASSET", "WRAPPED_USDC", "ORACLE", "COLLATERAL_VAULT", "LENDING_POOL", "LIQUIDATION", "LENDING_CONTROLLER"];
  const existing = Object.fromEntries(
    pinned.map((k) => [k, env[`CONTRACT_${k}`]]),
  );
  const alreadyDeployed = pinned.every((k) => existing[k]);
  if (alreadyDeployed) {
    console.log("▶ All contracts already pinned in .env — skipping deploy.");
    for (const [k, v] of Object.entries(existing)) console.log(`  ${k}=${v}`);
    // Even on the fast path, verify the pinned addresses are live and truly
    // initialized before regenerating artifacts (stale pins must not win).
    await verifyOnChain(existing);
    writeArtifacts(admin, attA, attB, attC, existing);
    return;
  }

  await ensureFunded(server, admin);

  // 3. Upload WASMs (all six), reuse hashes for the two wrapped_asset instances.
  const wasmFiles = {
    wrapped_asset: path.join(WASM_DIR, "wrapped_asset.wasm"),
    oracle: path.join(WASM_DIR, "oracle.wasm"),
    collateral_vault: path.join(WASM_DIR, "collateral_vault.wasm"),
    lending_pool: path.join(WASM_DIR, "lending_pool.wasm"),
    liquidation: path.join(WASM_DIR, "liquidation.wasm"),
    lending_controller: path.join(WASM_DIR, "lending_controller.wasm"),
  };
  const wasmHashes = {};
  for (const [name, file] of Object.entries(wasmFiles)) {
    if (!existsSync(file)) throw new Error(`missing wasm: ${file} — run cargo build --target wasm32v1-none --release first`);
    console.log(`▶ uploading ${name}.wasm...`);
    wasmHashes[name] = await uploadWasm(server, admin, readFileSync(file));
  }

  // 4. Create contracts. Deterministic salts ⇒ re-runs hit `contract already
  //    exists` and can be resumed; ids are recomputed identically.
  console.log("▶ creating contracts...");
  const ids = {};
  ids.WRAPPED_ASSET = await createContract(server, admin, wasmHashes.wrapped_asset, "wrapped_asset:weth");
  ids.WRAPPED_USDC = await createContract(server, admin, wasmHashes.wrapped_asset, "wrapped_asset:usdc");
  ids.ORACLE = await createContract(server, admin, wasmHashes.oracle, "oracle");
  ids.COLLATERAL_VAULT = await createContract(server, admin, wasmHashes.collateral_vault, "collateral_vault");
  ids.LENDING_POOL = await createContract(server, admin, wasmHashes.lending_pool, "lending_pool");
  ids.LIQUIDATION = await createContract(server, admin, wasmHashes.liquidation, "liquidation");
  ids.LENDING_CONTROLLER = await createContract(server, admin, wasmHashes.lending_controller, "lending_controller");
  for (const [k, v] of Object.entries(ids)) console.log(`  ${k}=${v}`);

  // 5. Initialize in dependency order. Admin requires auth on each call.
  const ORIGIN_ETH = str("ethereum");
  const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  console.log("▶ initializing wrapped_asset (wETH)...");
  await invoke(server, admin, ids.WRAPPED_ASSET, "initialize", [
    addr(admin.publicKey()),
    addr(ids.LENDING_CONTROLLER), // minter = lending_controller
    str("Wrapped Ether (StellarPay)"),
    str("wETH"),
    u32(18),
    ORIGIN_ETH,
    str(WETH_MAINNET),
  ]);

  console.log("▶ initializing wrapped_asset (wUSDC)...");
  await invoke(server, admin, ids.WRAPPED_USDC, "initialize", [
    addr(admin.publicKey()),
    addr(ids.LENDING_CONTROLLER),
    str("Wrapped USDC (StellarPay)"),
    str("wUSDC"),
    u32(6),
    ORIGIN_ETH,
    str(USDC_MAINNET),
  ]);

  for (const [name, cid] of [
    ["oracle", ids.ORACLE],
    ["collateral_vault", ids.COLLATERAL_VAULT],
    ["lending_pool", ids.LENDING_POOL],
  ]) {
    console.log(`▶ initializing ${name}...`);
    await invoke(server, admin, cid, "initialize", [addr(admin.publicKey())]);
  }

  console.log("▶ initializing liquidation...");
  // NOTE: the host rejects ScMaps whose keys are not sorted (lexicographic
  // symbol order). Sort bonus/fee/close_factor before the address fields.
  await invoke(server, admin, ids.LIQUIDATION, "initialize", [
    addr(admin.publicKey()),
    xdr.ScVal.scvMap([
      mapEntry("bonus_bps", u32(500)),
      mapEntry("close_factor_bps", u32(5000)),
      mapEntry("fee_bps", u32(200)),
      mapEntry("oracle", addr(ids.ORACLE)),
      mapEntry("pool", addr(ids.LENDING_POOL)),
      mapEntry("vault", addr(ids.COLLATERAL_VAULT)),
    ]),
    addr(admin.publicKey()), // treasury
  ]);

  console.log("▶ initializing lending_controller...");
  // All 3 attester ed25519 pubkeys, threshold = 2.
  const bridgeKeys = xdr.ScVal.scvVec([
    bytes(attA.rawPublicKey()),
    bytes(attB.rawPublicKey()),
    bytes(attC.rawPublicKey()),
  ]);
  await invoke(server, admin, ids.LENDING_CONTROLLER, "initialize", [
    addr(admin.publicKey()),
    bridgeKeys,
    u32(2), // bridge_threshold = 2-of-3
    addr(ids.WRAPPED_ASSET),
    addr(ids.LENDING_POOL),
    addr(ids.COLLATERAL_VAULT),
    addr(ids.ORACLE),
  ]);

  // 6. Persist pinned IDs + regenerate artifacts. Verify first so a silently
  //    uninitialized contract can never be recorded as deployed.
  await verifyOnChain(ids);
  writeEnv({ ...newEnv, ...Object.fromEntries(Object.entries(ids).map(([k, v]) => [`CONTRACT_${k}`, v])) });
  writeArtifacts(admin, attA, attB, attC, ids);

  console.log("\n✔ Deploy complete.");
}

function writeArtifacts(admin, attA, attB, attC, ids) {
  // ── sdk/src/manifest.json ──
  const manifest = {
    $schema: "./manifest.schema.json",
    network: "testnet",
    stellar: {
      rpc: "https://horizon-testnet.stellar.org",
      networkPassphrase: NETWORK_PASSPHRASE,
      contracts: {
        wrapped_asset: ids.WRAPPED_ASSET,
        wrapped_usdc: ids.WRAPPED_USDC,
        oracle: ids.ORACLE,
        collateral_vault: ids.COLLATERAL_VAULT,
        lending_pool: ids.LENDING_POOL,
        liquidation: ids.LIQUIDATION,
        lending_controller: ids.LENDING_CONTROLLER,
      },
    },
    evm: {
      ethereum: { bridge: "0x0000000000000000000000000000000000000000" },
      polygon: { bridge: "0x0000000000000000000000000000000000000000" },
    },
    api: "https://api.spg.xyz",
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`✔ wrote ${MANIFEST_PATH}`);

  // ── stellar.toml (SEP-0001, v2.7.0) ──
  const toml = `# StellarPay stellar.toml — SEP-0001 compliant
# Generated by stellar-contracts/scripts/deploy-testnet.mjs — do not hand-edit.
# Validated by stellar-contracts/scripts/validate-sep1.py.

VERSION = "2.0.0"
NETWORK_PASSPHRASE = "${NETWORK_PASSPHRASE}"

# Signing key used for SEP-10/SEP-45 authentication (protocol admin).
SIGNING_KEY = "${admin.publicKey()}"

# Accounts controlled by the StellarPay domain (admin + bridge attesters).
ACCOUNTS = [
  "${admin.publicKey()}",
  "${attA.publicKey()}",
  "${attB.publicKey()}",
  "${attC.publicKey()}",
]

[DOCUMENTATION]
ORG_NAME = "StellarPay"
ORG_DBA = "StellarPay"
ORG_URL = "https://spg.xyz"
ORG_DESCRIPTION = "Cross-chain lending protocol settled on Stellar with automated liquidation."
ORG_OFFICIAL_EMAIL = "hello@spg.xyz"
ORG_TWITTER = "spg_xyz"
ORG_GITHUB = "https://github.com/Zulu089017/DeFi-Lending-Platform"

# StellarPay does not run a Stellar validator; bridge attester keys are listed
# under ACCOUNTS above. (SEP-1 [[PRINCIPALS]] is reserved for personal info and
# does not support key publication.)

[[CURRENCIES]]
code = "wETH"
contract = "${ids.WRAPPED_ASSET}"
status = "test"
display_decimals = 4
name = "Wrapped Ether (StellarPay)"
desc = "Wrapped ETH bridged from Ethereum mainnet via the StellarPay bridge."

[[CURRENCIES]]
code = "wUSDC"
contract = "${ids.WRAPPED_USDC}"
status = "test"
display_decimals = 6
name = "Wrapped USDC (StellarPay)"
desc = "Wrapped USDC bridged via the StellarPay bridge."

# lETH (deposit receipt token) is not yet deployed on testnet — the lending
# pool tracks deposit shares internally. It will be listed here once a token
# contract is minted by the pool.
`;
  writeFileSync(STELLAR_TOML_PATH, toml);
  console.log(`✔ wrote ${STELLAR_TOML_PATH}`);

  // SEP-1 hosting copy: the frontend serves /.well-known/stellar.toml from
  // its `public` dir so wallets/explorers can discover StellarPay assets on
  // https://spg.xyz. Keep it byte-identical to the canonical file.
  const frontendToml = path.join(ROOT, "apps", "web", "public", ".well-known", "stellar.toml");
  mkdirSync(path.dirname(frontendToml), { recursive: true });
  writeFileSync(frontendToml, toml);
  console.log(`✔ wrote ${frontendToml}`);
}

main().catch((err) => {
  console.error("\n✖ Deploy failed:", err);
  process.exit(1);
});
