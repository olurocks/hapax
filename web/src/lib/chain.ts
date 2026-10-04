import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  createPublicClient,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  SYMBOLS,
  chainFor,
  collateralRegistryAbi,
  creditFacilityAbi,
  demoFeedAbi,
  facilityFactoryAbi,
  formatRevert,
  liquidityPoolAbi,
  marketOracleAbi,
  mockERC20Abi,
  riskManagerAbi,
  type Deployment,
  type StockSymbol,
} from "@hapax/shared";

// ------------------------------------------------------------------ config

const deployments = import.meta.glob("../../../contracts/deployments/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Deployment>;

export const chainId = Number(import.meta.env.VITE_CHAIN_ID ?? 31337);
export const chain = chainFor(chainId);
export const rpcUrl: string = import.meta.env.VITE_RPC_URL ?? chain.rpcUrls.default.http[0];
export const deployment: Deployment | null =
  Object.values(deployments).find((d) => Number(d.chainId) === chainId) ?? null;
export const explorer = chain.blockExplorers?.default.url;
export const LOOKBACK = BigInt(import.meta.env.VITE_LOG_LOOKBACK ?? 50_000);

export const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

const errorsOf = (abi: Abi) => abi.filter((x) => x.type === "error");
/** Facility ABI plus every error a nested risk or pool check can raise, so reverts decode by name. */
export const facilityAbiFull = [
  ...creditFacilityAbi,
  ...errorsOf(riskManagerAbi as Abi),
  ...errorsOf(liquidityPoolAbi as Abi),
] as unknown as typeof creditFacilityAbi;

// ------------------------------------------------------------------ snapshot

export interface StockView {
  symbol: StockSymbol;
  token: Address;
  balance: bigint; // 1e18
  mark: bigint;
  live: bigint;
  reference: bigint;
  closed: boolean;
  degraded: boolean;
  refUpdatedAt: bigint;
  liveUpdatedAt: bigint;
  haircutOpenBps: number;
  haircutClosedBps: number;
  refHeartbeat: number; // seconds
}

export type RiskParams = Awaited<ReturnType<typeof readParams>>;
export const readParams = () =>
  publicClient.readContract({ address: deployment!.risk, abi: riskManagerAbi, functionName: "params" });

export async function readSnapshot(f: Address) {
  const d = deployment!;
  const [block, e, rec, buyingPower, canDeleverage, mandate, owner, agent, idle, attStatus, att, positions, contributed, distributed] =
    await Promise.all([
      publicClient.getBlock(),
      publicClient.readContract({ address: d.risk, abi: riskManagerAbi, functionName: "evaluate", args: [f] }),
      publicClient.readContract({ address: d.risk, abi: riskManagerAbi, functionName: "recordOf", args: [f] }),
      publicClient.readContract({ address: d.risk, abi: riskManagerAbi, functionName: "buyingPower", args: [f] }),
      publicClient.readContract({ address: d.risk, abi: riskManagerAbi, functionName: "canDeleverage", args: [f] }),
      publicClient.readContract({ address: f, abi: creditFacilityAbi, functionName: "mandate" }),
      publicClient.readContract({ address: f, abi: creditFacilityAbi, functionName: "owner" }),
      publicClient.readContract({ address: f, abi: creditFacilityAbi, functionName: "agent" }),
      publicClient.readContract({ address: d.usdg, abi: mockERC20Abi, functionName: "balanceOf", args: [f] }),
      publicClient.readContract({ address: d.registry, abi: collateralRegistryAbi, functionName: "status", args: [f] }),
      publicClient.readContract({ address: d.registry, abi: collateralRegistryAbi, functionName: "record", args: [f] }),
      publicClient.readContract({ address: d.registry, abi: collateralRegistryAbi, functionName: "positions", args: [f] }),
      // Facilities from deployments that predate the P&L counters don't have them; read as null, not a failure.
      publicClient.readContract({ address: f, abi: creditFacilityAbi, functionName: "contributed" }).catch(() => null),
      publicClient.readContract({ address: f, abi: creditFacilityAbi, functionName: "distributed" }).catch(() => null),
    ]);

  const stocks: StockView[] = await Promise.all(
    SYMBOLS.map(async (symbol) => {
      const s = d.stocks[symbol];
      const [q, balance, ref, live, cfg] = await Promise.all([
        publicClient.readContract({ address: d.oracle, abi: marketOracleAbi, functionName: "quote", args: [s.token] }),
        publicClient.readContract({ address: s.token, abi: mockERC20Abi, functionName: "balanceOf", args: [f] }),
        publicClient.readContract({ address: s.refFeed, abi: demoFeedAbi, functionName: "latestRoundData" }),
        publicClient.readContract({ address: s.liveFeed, abi: demoFeedAbi, functionName: "latestRoundData" }),
        publicClient.readContract({ address: d.oracle, abi: marketOracleAbi, functionName: "config", args: [s.token] }),
      ]);
      return {
        symbol,
        token: s.token,
        balance,
        mark: q.mark,
        live: q.live,
        reference: q.reference_,
        closed: q.closed,
        degraded: q.degraded,
        refUpdatedAt: ref[3],
        liveUpdatedAt: live[3],
        haircutOpenBps: cfg.haircutBps,
        haircutClosedBps: cfg.weekendHaircutBps,
        refHeartbeat: cfg.refHeartbeat,
      };
    }),
  );

  const [m, mandateTokens, mandateActive] = mandate;
  const symbolOf = (a: Address) => SYMBOLS.find((s) => d.stocks[s].token.toLowerCase() === a.toLowerCase());
  return {
    block,
    facility: f,
    owner,
    agent: agent === "0x0000000000000000000000000000000000000000" ? null : agent,
    mandate: {
      expiresAt: m.expiresAt,
      maxPositionUsd: m.maxPositionUsd,
      symbols: mandateTokens.map(symbolOf).filter(Boolean) as StockSymbol[],
      active: mandateActive,
    },
    e,
    rec,
    buyingPower,
    canDeleverage,
    idle,
    stocks,
    /** USDG paid in from / out to wallets, base units (6 dec). */
    flows: { contributed: contributed ?? 0n, distributed: distributed ?? 0n },
    /** False on facilities deployed before repayFrom / cashOut / the P&L counters existed. */
    current: contributed !== null && distributed !== null,
    collateral: {
      status: attStatus,
      broker: att.broker,
      nonce: att.nonce,
      expiresAt: att.expiresAt,
      cashUsd: att.cashUsd,
      encumberedUsd: att.encumberedUsd,
      positions: positions.map((p) => ({ symbol: symbolOf(p.asset), shares: p.shares })),
    },
  };
}
export type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;

/** The connected wallet's own facilities only. No wallet → empty (don't browse other accounts). */
export async function facilitiesFor(owner?: Address): Promise<readonly Address[]> {
  if (!owner) return [];
  return publicClient.readContract({
    address: deployment!.factory,
    abi: facilityFactoryAbi,
    functionName: "facilitiesOf",
    args: [owner],
  });
}

export const readPoolApr = () =>
  publicClient.readContract({ address: deployment!.pool, abi: liquidityPoolAbi, functionName: "aprBps" });

/** Gas and USDG in the user's own wallet, and how much USDG the facility may pull from it. */
export async function readWalletBalances(owner: Address, facility: Address | null) {
  const d = deployment!;
  const [eth, usdg, allowance] = await Promise.all([
    publicClient.getBalance({ address: owner }),
    publicClient.readContract({ address: d.usdg, abi: mockERC20Abi, functionName: "balanceOf", args: [owner] }),
    facility
      ? publicClient.readContract({ address: d.usdg, abi: mockERC20Abi, functionName: "allowance", args: [owner, facility] })
      : Promise.resolve(0n),
  ]);
  return { eth, usdg, allowance };
}
export type WalletBalances = Awaited<ReturnType<typeof readWalletBalances>>;

// ------------------------------------------------------------------ events

export interface ChainEvent {
  key: string;
  block: bigint;
  logIndex: number;
  time: number; // unix seconds
  name: string;
  args: Record<string, unknown>;
  tx: string | null;
}

const blockTimes = new Map<bigint, number>();
async function timeOf(block: bigint) {
  if (!blockTimes.has(block)) {
    const b = await publicClient.getBlock({ blockNumber: block });
    blockTimes.set(block, Number(b.timestamp));
  }
  return blockTimes.get(block)!;
}

type RawLog = {
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: string | null;
  eventName: string;
  args: unknown;
};

async function withTimes(logs: RawLog[]): Promise<ChainEvent[]> {
  const out: ChainEvent[] = [];
  for (const l of logs) {
    if (l.blockNumber == null || l.logIndex == null) continue;
    out.push({
      key: `${l.blockNumber}-${l.logIndex}-${l.eventName}`,
      block: l.blockNumber,
      logIndex: l.logIndex,
      time: await timeOf(l.blockNumber),
      name: l.eventName,
      args: (l.args ?? {}) as Record<string, unknown>,
      tx: l.transactionHash,
    });
  }
  return out;
}

/** Facility, risk and registry events for one facility in a block range. */
export async function readEvents(f: Address, fromBlock: bigint, toBlock: bigint) {
  const d = deployment!;
  const lower = f.toLowerCase();
  const [risk, fac, revoked] = await Promise.all([
    publicClient.getContractEvents({ address: d.risk, abi: riskManagerAbi, fromBlock, toBlock }),
    publicClient.getContractEvents({ address: f, abi: creditFacilityAbi, fromBlock, toBlock }),
    publicClient.getContractEvents({
      address: d.registry,
      abi: collateralRegistryAbi,
      eventName: "AttestationRevoked",
      args: { facility: f },
      fromBlock,
      toBlock,
    }),
  ]);
  const mine = (risk as RawLog[]).filter(
    (l) => String((l.args as { facility?: string }).facility ?? "").toLowerCase() === lower,
  );
  return withTimes([...mine, ...(fac as RawLog[]), ...(revoked as RawLog[])]);
}

export interface PricePoint {
  key: string; // block-logIndex, unique per update
  time: number; // when the update landed
  asOf: number; // the price's own timestamp (backdated for "market close")
  price: number;
  feed: "ref" | "live";
}

/** Price history from the demo feeds' AnswerUpdated events. */
export async function readPrices(symbol: StockSymbol, fromBlock: bigint, toBlock: bigint): Promise<PricePoint[]> {
  const s = deployment!.stocks[symbol];
  const [ref, live] = await Promise.all([
    publicClient.getContractEvents({ address: s.refFeed, abi: demoFeedAbi, eventName: "AnswerUpdated", fromBlock, toBlock }),
    publicClient.getContractEvents({ address: s.liveFeed, abi: demoFeedAbi, eventName: "AnswerUpdated", fromBlock, toBlock }),
  ]);
  const pts: PricePoint[] = [];
  for (const [feed, logs] of [["ref", ref], ["live", live]] as const) {
    for (const l of logs) {
      if (l.blockNumber == null) continue;
      pts.push({
        key: `${l.blockNumber}-${l.logIndex}`,
        time: await timeOf(l.blockNumber),
        asOf: Number(l.args.updatedAt),
        price: Number(l.args.answer) / 1e8,
        feed,
      });
    }
  }
  return sortPrices(pts);
}

/** Chronological order by block, then log index, so ref/live updates in one block keep their sequence. */
export function sortPrices(pts: PricePoint[]) {
  const pos = (k: string) => k.split("-").map(Number) as [number, number];
  return pts.sort((a, b) => {
    const [ba, la] = pos(a.key), [bb, lb] = pos(b.key);
    return ba - bb || la - lb;
  });
}

// ------------------------------------------------------------------ transactions

export type TxStage = "wallet" | "pending";
export interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/**
 * Simulate (so reverts surface with their decoded reason before the wallet opens), ask the wallet to sign,
 * then wait for the receipt. `onStage` drives the progress UI.
 */
export async function send(
  client: import("viem").WalletClient,
  account: Address,
  call: Call,
  onStage?: (stage: TxStage, hash?: Hex) => void,
) {
  try {
    const { request } = await publicClient.simulateContract({ ...call, account } as never);
    onStage?.("wallet");
    const hash = await client.writeContract({ ...(request as object), account, chain } as never);
    onStage?.("pending", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Transaction reverted");
    return hash;
  } catch (err) {
    throw new Error(revertReason(err));
  }
}

export const txUrl = (hash: string) => (explorer ? `${explorer}/tx/${hash}` : null);
export const addressUrl = (a: string) => (explorer ? `${explorer}/address/${a}` : null);

export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "You rejected the request in your wallet.";
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return formatRevert(revert.data?.errorName ?? revert.reason ?? "reverted", revert.data?.args ?? [], deployment);
    }
    if (/insufficient funds/i.test(err.message)) return "Not enough ETH in your wallet to pay for gas.";
    return err.shortMessage;
  }
  const code = (err as { code?: number })?.code;
  if (code === 4001) return "You rejected the request in your wallet.";
  return err instanceof Error ? err.message : String(err);
}
