import manifest_ from "./manifest.json" with { type: "json" };
import type {
  Manifest,
  StellarPayConfig,
  WrapRequest,
  WrapResult,
  UnwrapRequest,
  Market,
  Position,
  StreamEvent,
} from "./types.js";
import { ethers } from "ethers";
import {
  Horizon,
  Keypair,
  TransactionBuilder,
  Operation,
  Address as ScAddress,
  nativeToScVal,
  Contract,
  xdr,
} from "@stellar/stellar-sdk";

const BRIDGE_ABI = [
  "function lock(address token, uint256 amount, bytes32 stellarDest, bytes32 salt) returns (uint256)",
  "function burn(address token, uint256 amount, bytes32 stellarDest, bytes32 salt) returns (uint256)",
  "function release(address token, address recipient, uint256 amount, bytes32 stellarTxHash, uint256 nonce, bytes[] calldata signatures) external",
];

export class StellarPay {
  readonly config: StellarPayConfig;
  readonly manifest: Manifest = manifest_ as Manifest;
  readonly stellar: { keypair: Keypair; publicKey: string; server: Horizon.Server };
  readonly evm: Record<string, { provider: ethers.JsonRpcProvider; bridge: ethers.Contract }>;

  constructor(config: StellarPayConfig) {
    this.config = config;
    const kp = Keypair.fromSecret(config.stellar.secretKey);
    this.stellar = {
      keypair: kp,
      publicKey: kp.publicKey(),
      server: new Horizon.Server(config.stellar.rpc),
    };
    this.evm = {};
    for (const [name, c] of Object.entries(config.evm)) {
      const provider = new ethers.JsonRpcProvider(c.rpc);
      const bridge = new ethers.Contract(c.bridgeAddress, BRIDGE_ABI, provider);
      this.evm[name] = { provider, bridge };
    }
  }

  // ──────────────────────── Wrap / Unwrap ────────────────────────

  async wrap(req: WrapRequest): Promise<WrapResult> {
    const evmChain = this.evm[req.sourceChain];
    if (!evmChain) throw new Error(`Unsupported source chain: ${req.sourceChain}`);

    const salt = ethers.hexlify(ethers.randomBytes(32));
    const stellarDest = ethers.zeroPadValue(
      ethers.hexlify(Buffer.from(this.stellar.keypair.rawPublicKey())),
      32,
    );

    const signer = await evmChain.provider.getSigner();
    const bridgeWithSigner = evmChain.bridge.connect(signer) as ethers.Contract;
    const tx = await bridgeWithSigner.lock(req.token, req.amount, stellarDest, salt);
    const receipt = await tx.wait();

    return {
      sourceTx: receipt.hash,
      salt,
      stellarTx: this.awaitStellarMint(receipt.hash, salt),
    };
  }

  /** Polls the API until the source-tx is reflected as a wrap event on Stellar. */
  private async awaitStellarMint(sourceTx: string, salt: string): Promise<string> {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const r = await fetch(`${this.config.api}/v1/wrap-events`);
      const data = (await r.json()) as any[];
      const hit = data.find((e) => e.salt === salt || e.txHash === sourceTx);
      if (hit?.txHash) return hit.txHash;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new Error("stellar mint not observed within 5 minutes");
  }

  async unwrap(req: UnwrapRequest): Promise<{ stellarTx: string }> {
    const source = await this.stellar.server.loadAccount(this.stellar.publicKey);
    // keep in sync with lending_controller.unwrap: source_addr is BytesN<32>
    const saHex = req.sourceAddr.startsWith("0x") ? req.sourceAddr.slice(2) : req.sourceAddr;
    let sourceAddrBytes: Buffer;
    if (/^[0-9a-fA-F]{40,64}$/.test(saHex)) {
      sourceAddrBytes = Buffer.from(saHex.padStart(64, "0"), "hex");
    } else {
      sourceAddrBytes = Buffer.alloc(32);
      Buffer.from(req.sourceAddr, "ascii").subarray(0, 32).copy(sourceAddrBytes);
    }
    const tx = new TransactionBuilder(source, {
      fee: "100000",
      networkPassphrase: this.config.stellar.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.config.stellar.controllerContract,
          function: "unwrap",
          args: [
            ScAddress.fromString(this.stellar.publicKey).toScVal(),
            nativeToScVal(BigInt(req.amount), { type: "i128" }),
            nativeToScVal(this.chainIdToU32(req.sourceChain), { type: "u32" }),
            // NB: we use `scvBytes` (variable-length) here even though the
            // contract declares `source_addr: BytesN<32>` (fixed-size 32).
            // The @stellar/stellar-sdk v12 JS bindings do not expose a
            // `scvBytesN` helper, but a 32-byte buffer serialised through
            // `scvBytes` produces the same on-wire bytes for a `BytesN<32>`
            // parameter. If the SDK ever adds `scvBytesN`, switch to it for
            // a stronger compile-time guarantee. See `docs/invariants.md`
            // § 6 (C-6) for the protocol's domain-separation rule.
            xdr.ScVal.scvBytes(sourceAddrBytes),
          ],
        }) as any,
      )
      .setTimeout(60)
      .build();
    tx.sign(this.stellar.keypair);
    const res = await this.stellar.server.submitTransaction(tx);
    return { stellarTx: res.hash };
  }

  // ──────────────────────── Lending ────────────────────────

  async supply(asset: string, amount: string): Promise<{ hash: string }> {
    return this.invokeController("supply_collateral", [
      ScAddress.fromString(this.stellar.publicKey).toScVal(),
      nativeToScVal(asset, { type: "symbol" }),
      nativeToScVal(BigInt(amount), { type: "i128" }),
    ]);
  }

  /**
   * @deprecated Use {@link supply} instead. The on-chain entry point is
   * `supply_collateral`; this alias is kept for compatibility with the
   * README examples.
   */
  async supplyCollateral(asset: string, amount: string): Promise<{ hash: string }> {
    return this.supply(asset, amount);
  }

  async withdraw(asset: string, amount: string): Promise<{ hash: string }> {
    // calls lending_pool.withdraw via controller
    return this.invokeController("withdraw", [
      ScAddress.fromString(this.stellar.publicKey).toScVal(),
      nativeToScVal(asset, { type: "symbol" }),
      nativeToScVal(BigInt(amount), { type: "i128" }),
    ]);
  }

  async borrow(opts: {
    collateralAsset: string;
    collateralAmount: string;
    debtAsset: string;
    borrowAmount: string;
  }): Promise<{ hash: string }> {
    return this.invokeController("borrow", [
      ScAddress.fromString(this.stellar.publicKey).toScVal(),
      nativeToScVal(opts.collateralAsset, { type: "symbol" }),
      nativeToScVal(BigInt(opts.collateralAmount), { type: "i128" }),
      nativeToScVal(opts.debtAsset, { type: "symbol" }),
      nativeToScVal(BigInt(opts.borrowAmount), { type: "i128" }),
    ]);
  }

  async repay(asset: string, amount: string): Promise<{ hash: string }> {
    return this.invokeController("repay", [
      ScAddress.fromString(this.stellar.publicKey).toScVal(),
      nativeToScVal(asset, { type: "symbol" }),
      nativeToScVal(BigInt(amount), { type: "i128" }),
    ]);
  }

  async liquidate(opts: {
    borrower: string;
    debtAsset: string;
    collateralAsset: string;
    repayAmount: string;
  }): Promise<{ hash: string }> {
    return this.invokeController("liquidate", [
      ScAddress.fromString(this.stellar.publicKey).toScVal(),
      ScAddress.fromString(opts.borrower).toScVal(),
      nativeToScVal(opts.debtAsset, { type: "symbol" }),
      nativeToScVal(opts.collateralAsset, { type: "symbol" }),
      nativeToScVal(BigInt(opts.repayAmount), { type: "i128" }),
    ]);
  }

  // ──────────────────────── Read API ────────────────────────

  async markets(): Promise<Market[]> {
    const r = await fetch(`${this.config.api}/v1/markets`);
    return r.json();
  }

  async positions(user: string): Promise<Position> {
    const r = await fetch(`${this.config.api}/v1/positions/${user}`);
    return r.json();
  }

  async healthFactor(user: string): Promise<number> {
    const r = await fetch(`${this.config.api}/v1/health-factor/${user}`);
    const d = (await r.json()) as { healthFactor: number };
    return d.healthFactor;
  }

  // ──────────────────────── WebSocket stream ────────────────────────

  stream(handler: (evt: StreamEvent) => void): () => void {
    const ws = new WebSocket(`${this.config.api.replace(/^http/, "ws")}/v1/stream`);
    ws.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data as string) as StreamEvent;
        handler(parsed);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => ws.close();
  }

  // ──────────────────────── Internals ────────────────────────

  private async invokeController(fn: string, args: xdr.ScVal[]): Promise<{ hash: string }> {
    const source = await this.stellar.server.loadAccount(this.stellar.publicKey);
    const tx = new TransactionBuilder(source, {
      fee: "100000",
      networkPassphrase: this.config.stellar.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.config.stellar.controllerContract,
          function: fn,
          args,
        }) as any,
      )
      .setTimeout(60)
      .build();
    tx.sign(this.stellar.keypair);
    const res = await this.stellar.server.submitTransaction(tx);
    return { hash: res.hash };
  }

  private chainIdToU32(c: string): number {
    if (c === "ethereum") return 1;
    if (c === "polygon") return 137;
    if (c === "solana") return 0;
    return 0;
  }
}
