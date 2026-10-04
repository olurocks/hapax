import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Abi,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
  const [block, e, rec, buyingPower, canDeleverage, mandate, owner, agent, idle, attStatus, att, positions] =
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

export async function facilitiesFor(owner?: Address) {
  const d = deployment!;
  if (owner) {
    const mine = await publicClient.readContract({
      address: d.factory,
      abi: facilityFactoryAbi,
      functionName: "facilitiesOf",
      args: [owner],
    });
    if (mine.length) return mine;
  }
  return publicClient.readContract({ address: d.factory, abi: facilityFactoryAbi, functionName: "facilities" });
}

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

// ------------------------------------------------------------------ wallet

declare global {
  interface Window {
    ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
  }
}

export interface Wallet {
  client: WalletClient;
  address: Address;
  kind: "browser" | "dev key";
}

/** Browser wallet if present; otherwise a local dev key (Anvil only, never a real key). */
export async function connectWallet(): Promise<Wallet> {
  if (window.ethereum) {
    const client = createWalletClient({ chain, transport: custom(window.ethereum) });
    const [address] = await client.requestAddresses();
    try {
      await client.switchChain({ id: chain.id });
    } catch {
      await client.addChain({ chain });
    }
    return { client, address, kind: "browser" };
  }
  const pk = import.meta.env.VITE_DEV_OWNER_PK as Hex | undefined;
  if (!pk) throw new Error("No browser wallet found. Install one, or set VITE_DEV_OWNER_PK for a local Anvil demo.");
  const account = privateKeyToAccount(pk);
  return { client: createWalletClient({ account, chain, transport: http(rpcUrl) }), address: account.address, kind: "dev key" };
}

/** Simulate, send and wait. Throws an Error whose message is the decoded revert reason. */
export async function send(
  wallet: Wallet,
  call: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] },
) {
  try {
    const { request } = await publicClient.simulateContract({ ...call, account: wallet.address } as never);
    const hash = await wallet.client.writeContract({ ...(request as object), account: wallet.client.account ?? wallet.address } as never);
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  } catch (err) {
    throw new Error(revertReason(err));
  }
}

export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return formatRevert(revert.data?.errorName ?? revert.reason ?? "reverted", revert.data?.args ?? [], deployment);
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}
