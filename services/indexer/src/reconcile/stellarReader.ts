// Read-only on-chain views used by reconciliation.
//
// These are `simulateTransaction` calls against deployed contracts: no signing,
// no fees, no state change. A simulated read is the only way to compare the
// indexer's numbers with the ledger without trusting either side.

import {
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

export interface ViewReader {
  /** `wrapped_asset.total_supply()` */
  wrappedSupply(contractId: string): Promise<bigint>;
  /** `lending_pool.total_deposit(asset)` */
  poolTotalDeposit(poolId: string, asset: string): Promise<bigint>;
  /** `lending_pool.total_borrow(asset)` */
  poolTotalBorrow(poolId: string, asset: string): Promise<bigint>;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`view returned non-integer ${value}`);
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`view returned unsupported type ${typeof value}`);
}

export class SorobanViewReader implements ViewReader {
  constructor(
    private readonly server: rpc.Server,
    /** Any funded account; used only as the simulation source. */
    private readonly sourceAccount: string,
    private readonly networkPassphrase: string = Networks.TESTNET,
  ) {}

  async wrappedSupply(contractId: string): Promise<bigint> {
    return this.invoke(contractId, "total_supply", []);
  }

  async poolTotalDeposit(poolId: string, asset: string): Promise<bigint> {
    return this.invoke(poolId, "total_deposit", [nativeToScVal(asset, { type: "symbol" })]);
  }

  async poolTotalBorrow(poolId: string, asset: string): Promise<bigint> {
    return this.invoke(poolId, "total_borrow", [nativeToScVal(asset, { type: "symbol" })]);
  }

  private async invoke(
    contractId: string,
    fn: string,
    args: ReturnType<typeof nativeToScVal>[],
  ): Promise<bigint> {
    const account = await this.server.getAccount(this.sourceAccount);
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(fn, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`${contractId}.${fn} simulation failed: ${sim.error}`);
    }
    const retval = sim.result?.retval;
    if (!retval) throw new Error(`${contractId}.${fn} returned no value`);
    return toBigInt(scValToNative(retval));
  }
}

export { toBigInt };
