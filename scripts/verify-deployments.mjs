#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────────
// Verify every Soroban contract ID in packages/sdk/src/manifest.json against the
// live Stellar RPC. Read-only: it never signs or submits a transaction.
//
//   node scripts/verify-deployments.mjs [--json] [--wasm-dir <dir>]
//
// What it proves, per contract:
//   • the ID is a valid StrKey contract address;
//   • a contract instance exists in ledger state (getLedgerEntries);
//   • the executable is either a WASM upload or builtin, and if WASM, the
//     sha256 of the installed code;
//   • optionally, whether the installed code matches a locally built
//     `<contract>.wasm` (--wasm-dir). A mismatch means the source in this
//     repository is NOT what is deployed.
//
// Exit code 0 only when every contract resolves. Mismatching WASM hashes are
// reported but do not fail the run (deployed code can legitimately predate the
// working tree) — pass --strict to make them fatal, e.g. in a release gate.
// ──────────────────────────────────────────────────────────────────────────────
import { createRequire } from "module";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "packages", "sdk", "src", "manifest.json");

// @stellar/stellar-sdk is a dependency of the `sdk` workspace package, not the
// root, so anchor resolution at packages/sdk/package.json.
const require = createRequire(path.join(ROOT, "packages", "sdk", "package.json"));
const { rpc, xdr, StrKey } = require("@stellar/stellar-sdk");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");
const wasmDirArg = args.indexOf("--wasm-dir") !== -1 ? args[args.indexOf("--wasm-dir") + 1] : null;

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function localWasmFor(name, dir) {
  if (!dir) return null;
  const file = path.join(dir, `${name}.wasm`);
  if (!existsSync(file)) return null;
  return { file, hash: sha256(readFileSync(file)), bytes: readFileSync(file).length };
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const rpcUrl = process.env.SOROBAN_RPC ?? "https://soroban-testnet.stellar.org";
  const server = new rpc.Server(rpcUrl);
  const health = await server.getHealth();

  const rows = [];
  for (const [name, contractId] of Object.entries(manifest.stellar.contracts)) {
    const row = { name, contractId, ok: false, error: null };
    try {
      if (!StrKey.isValidContract(contractId)) throw new Error("invalid contract StrKey");
      const data = await server.getContractData(
        contractId,
        xdr.ScVal.scvLedgerKeyContractInstance(),
      );
      const instance = data.val.contractData().val().instance();
      const executable = instance.executable();
      const kind = executable.switch().name;
      row.ledger = data.lastModifiedLedgerSeq;
      row.executable =
        kind === "contractExecutableWasm"
          ? { kind: "wasm", sha256: Buffer.from(executable.wasmHash()).toString("hex") }
          : { kind: "builtin" };
      row.storageKeys = instance.storage().map((entry) => {
        const key = entry.key();
        return key.switch().name === "scvSymbol" ? key.sym().toString() : key.switch().name;
      });
      const local = localWasmFor(name, wasmDirArg);
      if (local) {
        row.localWasm = {
          sha256: local.hash,
          bytes: local.bytes,
          file: path.relative(ROOT, local.file),
        };
        row.wasmMatchesLocal =
          row.executable.kind === "wasm" ? row.executable.sha256 === local.hash : false;
      }
      row.ok = true;
    } catch (err) {
      row.error = err?.message ?? String(err);
    }
    rows.push(row);
  }

  const allResolved = rows.every((r) => r.ok);
  const wasmMatches = rows.filter((r) => r.wasmMatchesLocal === true).length;
  const wasmChecked = rows.filter((r) => r.wasmMatchesLocal !== undefined).length;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          network: manifest.network,
          rpc: rpcUrl,
          checkedAt: new Date().toISOString(),
          latestLedger: health.latestLedger,
          allResolved,
          wasmChecked,
          wasmMatches,
          contracts: rows,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`RPC ${rpcUrl} (latest ledger ${health.latestLedger})\n`);
    for (const r of rows) {
      if (!r.ok) {
        console.log(`✗ ${r.name.padEnd(20)} ${r.contractId}  ${r.error}`);
        continue;
      }
      const wasm =
        r.executable.kind === "wasm" ? r.executable.sha256.slice(0, 16) + "…" : "builtin";
      const match =
        r.wasmMatchesLocal === undefined
          ? ""
          : r.wasmMatchesLocal
            ? " wasm=local ✓"
            : " wasm≠local ✗";
      console.log(
        `✓ ${r.name.padEnd(20)} ${r.contractId}  ledger ${r.ledger}  wasm ${wasm}${match}`,
      );
    }
    if (wasmChecked > 0) {
      console.log(
        `\nWASM: ${wasmMatches}/${wasmChecked} deployed contracts match the local build.`,
      );
      if (wasmMatches !== wasmChecked) {
        console.log(
          "Deployed code differs from this working tree — redeploy before claiming parity.",
        );
      }
    }
    console.log(
      `\n${allResolved ? "All contracts resolved on-chain." : "Some contracts did NOT resolve."}`,
    );
  }

  if (!allResolved) process.exitCode = 1;
  else if (strict && wasmChecked > 0 && wasmMatches !== wasmChecked) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
