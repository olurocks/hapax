// Hapax agents: AI traders that get buying power, not keys.
//
// The service offers a small catalog of agents. When a facility owner hires one, the service derives a dedicated
// key for that (agent, facility) pair; the owner appoints that address onchain with a mandate (setAgent) and
// signs the instructions. Each cycle the service reads every running facility, decides trades (Claude, or a
// rules strategy), and submits them with that facility's key. The contract is the leash: anything outside the
// mandate reverts onchain, and the agent records the refusal instead of crashing.
//
// Public API (used by the app):
//   GET  /agents                           catalog
//   GET  /agents/:id/address?facility=0x   the key this agent would trade with for that facility
//   POST /assignments                      owner-signed hire (instructions)
//   POST /assignments/:facility/instructions   owner-signed instruction change
//   GET  /assignments/:facility            assignment, live status and decision history
// Admin (demo control plane, x-admin-token):
//   GET /admin/assignments, POST /admin/tick { facility }, POST /admin/try { facility, action, symbol, usd }
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  encodePacked,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  STATES,
  SYMBOLS,
  creditFacilityAbi,
  demoVenueAbi,
  formatRevert,
  fromWad,
  marketOracleAbi,
  mockERC20Abi,
  riskManagerAbi,
  type AgentDecision,
  type AgentProfile,
  type Assignment,
  type AssignmentStatus,
  type SignedOwnerRequest,
  type StockSymbol,
} from "@hapax/shared";
import { chain, chainId, env, loadDeployment, publicClient, repoRoot, rpcUrl, walletFor } from "@hapax/shared/env";
import { log as mkLog, serve } from "@hapax/shared/http";
import { verifyOwnerRequest } from "@hapax/shared/verify";

const log = mkLog("agent");
const d = loadDeployment();
/** Treasury: never trades. It derives the per-facility keys and pays their gas. */
const treasury = walletFor("AGENT_PK");
const SEED = keccak256(encodePacked(["string", "string"], ["hapax-agent-seed", env("AGENT_SEED", env("AGENT_PK"))]));
const INTERVAL = Number(env("AGENT_INTERVAL_MS", "60000"));
const GAS_MIN = parseEther(env("AGENT_GAS_MIN_ETH", "0.002"));
const GAS_TOPUP = parseEther(env("AGENT_GAS_TOPUP_ETH", "0.01"));
const MODEL = "claude-opus-5-5";
const claude = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;

// ------------------------------------------------------------------ catalog

type Strategy = "claude" | "dip" | "momentum";
const CATALOG: Array<AgentProfile & { strategy: Strategy }> = [
  {
    id: "claude",
    strategy: "claude",
    name: "Claude Discretionary",
    tagline: "Reads the market and your instructions every cycle, and decides.",
    description:
      "A Claude-powered trader. It follows your plain-English instructions within the mandate you set onchain, " +
      "explains each decision, and cuts risk on its own when the facility is under pressure.",
    engine: MODEL,
    available: !!claude,
    unavailableReason: claude ? undefined : "Not available on this server right now.",
    defaultInstructions:
      "Trade large-cap tech. Buy meaningful dips, take profit into strength, and keep at least 20% of idle USDG in reserve.",
    suggested: { symbols: ["TSLA", "NFLX"], maxPositionUsd: 250_000, hours: 24 },
  },
  {
    id: "dip-buyer",
    strategy: "dip",
    name: "Dip Buyer",
    tagline: "Buys 3% dips in the stocks you allow and trims 5% winners.",
    description:
      "A fixed-rule strategy. It buys a stock you allow after a drop of 3% or more, sells half a position after a 5% gain, " +
      "keeps 20% of idle USDG in reserve, and repays and halves positions when the facility leaves Active. " +
      "Your notes are kept with the mandate but don't change its rules.",
    engine: "rules",
    available: true,
    defaultInstructions: "Buy 3% dips, trim 5% winners, keep a 20% reserve.",
    suggested: { symbols: ["TSLA", "AMZN", "NFLX"], maxPositionUsd: 150_000, hours: 72 },
  },
  {
    id: "momentum",
    strategy: "momentum",
    name: "Momentum",
    tagline: "Rides stocks moving up and cuts losers at 4%.",
    description:
      "A fixed-rule strategy. It adds to a stock you allow once it is up 2% or more, exits a position that falls 4%, " +
      "and repays and halves positions when the facility leaves Active. Your notes are kept with the mandate but don't change its rules.",
    engine: "rules",
    available: true,
    defaultInstructions: "Follow strength, cut losers quickly.",
    suggested: { symbols: ["TSLA", "NFLX"], maxPositionUsd: 150_000, hours: 72 },
  },
];
const profile = (id: string) => {
  const p = CATALOG.find((a) => a.id === id);
  if (!p) throw new Error(`Unknown agent "${id}"`);
  return p;
};

// ------------------------------------------------------------------ keys and assignments

const keyFor = (agentId: string, facility: Address): Hex =>
  keccak256(encodePacked(["bytes32", "string", "address"], [SEED, agentId, facility]));
const addressFor = (agentId: string, facility: Address) => privateKeyToAccount(keyFor(agentId, facility)).address;
const clientFor = (agentId: string, facility: Address) =>
  createWalletClient({ account: privateKeyToAccount(keyFor(agentId, facility)), chain, transport: http(rpcUrl) });

interface Stored {
  facility: Address;
  agentId: string;
  agent: Address;
  instructions: string;
  hiredAt: string;
  seenRunning: boolean;
  lastRunAt?: string;
  lastError?: string;
  history: AgentDecision[];
}
// Per deployment: a fresh deploy has no facilities to trade.
const storePath = join(repoRoot, "agent", `assignments.${chainId}.${d.factory.slice(2, 10).toLowerCase()}.json`);
const store: Record<string, Stored> = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : {};
const save = () => writeFileSync(storePath, JSON.stringify(store, null, 2));
const assignmentOf = (facility: string) => {
  const a = store[facility.toLowerCase()];
  if (!a) throw new Error(`No agent hired for facility ${facility}`);
  return a;
};

/** Price when the agent first saw each stock on a facility: its reference for "dip", "gain" and "trend". */
const anchors = new Map<string, Partial<Record<StockSymbol, number>>>();

async function statusOf(a: Stored): Promise<AssignmentStatus> {
  const [onchain, [, , active]] = await Promise.all([
    publicClient.readContract({ address: a.facility, abi: creditFacilityAbi, functionName: "agent" }),
    publicClient.readContract({ address: a.facility, abi: creditFacilityAbi, functionName: "mandate" }),
  ]);
  if (onchain.toLowerCase() === a.agent.toLowerCase()) {
    if (active) {
      if (!a.seenRunning) {
        a.seenRunning = true;
        save();
      }
      return "running";
    }
    return "expired";
  }
  return a.seenRunning ? "revoked" : "not-appointed";
}

async function view(a: Stored): Promise<Assignment> {
  const status = await statusOf(a);
  const next = a.lastRunAt ? Date.parse(a.lastRunAt) + INTERVAL : Date.now();
  return {
    facility: a.facility,
    agentId: a.agentId,
    agentName: profile(a.agentId).name,
    agent: a.agent,
    instructions: a.instructions,
    hiredAt: a.hiredAt,
    status,
    lastRunAt: a.lastRunAt,
    nextRunAt: status === "running" && INTERVAL > 0 ? new Date(Math.max(next, Date.now())).toISOString() : undefined,
    lastError: a.lastError,
    history: a.history,
  };
}

/** Each agent key pays its own gas; the treasury keeps it topped up. */
async function ensureGas(addr: Address) {
  const bal = await publicClient.getBalance({ address: addr });
  if (bal >= GAS_MIN) return;
  const hash = await treasury.sendTransaction({ to: addr, value: GAS_TOPUP });
  await publicClient.waitForTransactionReceipt({ hash });
  log(`topped up ${addr} with ${formatEther(GAS_TOPUP)} ETH`);
}

// ------------------------------------------------------------------ state

async function snapshot(f: Address) {
  const [e, [mandate, mandateTokens, active], idle] = await Promise.all([
    publicClient.readContract({ address: d.risk, abi: riskManagerAbi, functionName: "evaluate", args: [f] }),
    publicClient.readContract({ address: f, abi: creditFacilityAbi, functionName: "mandate" }),
    publicClient.readContract({ address: d.usdg, abi: mockERC20Abi, functionName: "balanceOf", args: [f] }),
  ]);
  const allowed = new Set(mandateTokens.map((t) => t.toLowerCase()));
  const anchor = anchors.get(f.toLowerCase()) ?? {};
  anchors.set(f.toLowerCase(), anchor);
  const stocks = await Promise.all(
    SYMBOLS.map(async (s) => {
      const token = d.stocks[s].token;
      const [q, bal] = await Promise.all([
        publicClient.readContract({ address: d.oracle, abi: marketOracleAbi, functionName: "quote", args: [token] }),
        publicClient.readContract({ address: token, abi: mockERC20Abi, functionName: "balanceOf", args: [f] }),
      ]);
      const live = fromWad(q.live);
      const shares = Number(formatUnits(bal, 18));
      anchor[s] ??= live;
      return {
        symbol: s,
        inMandate: allowed.has(token.toLowerCase()),
        lastClose: fromWad(q.reference_),
        live,
        changeFromClose: +((live / fromWad(q.reference_) - 1) * 100).toFixed(2),
        changeSinceAgentStart: +((live / anchor[s]! - 1) * 100).toFixed(2),
        marketClosed: q.closed,
        shares: +shares.toFixed(4),
        positionUsd: +(shares * live).toFixed(2),
      };
    }),
  );
  return {
    state: STATES[e.state],
    idleUsdg: Number(formatUnits(idle, 6)),
    debtUsd: fromWad(e.debt),
    exposureUsd: fromWad(e.exposure),
    creditLimitUsd: fromWad(e.creditLimit),
    utilization: e.U > 10n ** 30n ? null : +(fromWad(e.U) * 100).toFixed(1),
    health: e.H > 10n ** 30n ? null : +(fromWad(e.H) * 100).toFixed(1),
    marketClosed: e.anyClosed,
    mandate: {
      active,
      expiresAt: new Date(Number(mandate.expiresAt) * 1000).toISOString(),
      maxPositionUsd: fromWad(mandate.maxPositionUsd),
    },
    stocks,
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

// ------------------------------------------------------------------ deciding

/** A buy or sell of a stock, or a repayment of debt from idle USDG (symbol "USDG"). */
type Trade = { action: "buy" | "sell" | "repay"; symbol: StockSymbol | "USDG"; usd: number };
type Plan = { reasoning: string; trades: Trade[] };

const DecisionSchema = z.object({
  reasoning: z.string().describe("One or two sentences explaining the decision"),
  trades: z
    .array(
      z.object({
        action: z.enum(["buy", "sell", "repay"]),
        symbol: z.enum([...SYMBOLS, "USDG"]).describe('The stock to buy or sell; "USDG" for a repay'),
        usd: z.number().describe("USD notional of the trade or repayment"),
      }),
    )
    .describe("Zero to three actions, executed in order. Empty means hold."),
});

const SYSTEM = `You are a trading agent operating a Hapax credit facility on Robinhood Chain.
You trade tokenized stocks against USDG with borrowed buying power. You hold the facility's agent key: you can
buy and sell through the venue and repay debt from idle USDG, but you cannot borrow or withdraw. The owner's mandate
is enforced by the smart contract; any trade outside it reverts onchain.

Hard rules enforced onchain (plan within them; trades that break them are wasted):
- Buy only stocks with inMandate=true. Selling any holding is always allowed.
- A buy must keep that stock's position at or below mandate.maxPositionUsd.
- Buys are refused when state is not ACTIVE or WARNING, or when utilization would exceed 70%.
- Buys cannot exceed idle USDG.

When the market is closed (weekend), prices come from the 24/7 onchain market and the risk engine is stricter.
In WARNING or worse, prefer reducing risk. Selling alone does not restore position health (health = assets / debt);
repaying debt from idle USDG does. In MARGIN_CALL or worse, sell what you must and repay. Follow the owner's
instructions below.`;

async function decideWithClaude(s: Snapshot, instructions: string): Promise<Plan> {
  const response = await claude!.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(DecisionSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Owner instructions:\n${instructions}\n\nFacility and market snapshot:\n${JSON.stringify(s, null, 2)}`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error(`model refused (${response.stop_details?.category ?? "unknown"})`);
  if (!response.parsed_output) throw new Error(`no parsed output (stop_reason ${response.stop_reason})`);
  return response.parsed_output;
}

/** Shared by the rules strategies: outside ACTIVE, repay from idle USDG and halve every position. */
function deRisk(s: Snapshot): Plan | null {
  if (s.state === "ACTIVE") return null;
  const trades: Trade[] = [];
  if (s.idleUsdg > 1 && s.debtUsd > 0) trades.push({ action: "repay", symbol: "USDG", usd: Math.min(s.idleUsdg, s.debtUsd) });
  for (const st of s.stocks) if (st.positionUsd > 1) trades.push({ action: "sell", symbol: st.symbol, usd: st.positionUsd / 2 });
  return { reasoning: `Facility is ${s.state}; repaying from idle USDG and halving positions to cut risk.`, trades: trades.slice(0, 3) };
}

/** Weekend: measure from the last close. Market open: the reference follows the price, so use the agent's anchor. */
const moveOf = (st: Snapshot["stocks"][number]) => (st.marketClosed ? st.changeFromClose : st.changeSinceAgentStart);
const roomIn = (s: Snapshot, st: Snapshot["stocks"][number], budget: number) =>
  s.mandate.maxPositionUsd > 0 ? Math.min(budget, s.mandate.maxPositionUsd * 0.98 - st.positionUsd) : budget;

function decideDip(s: Snapshot): Plan {
  const stressed = deRisk(s);
  if (stressed) return stressed;
  const trades: Trade[] = [];
  let budget = s.idleUsdg * 0.8;
  for (const st of s.stocks) {
    const move = moveOf(st);
    if (move >= 5 && st.positionUsd > 1) {
      trades.push({ action: "sell", symbol: st.symbol, usd: st.positionUsd / 2 });
    } else if (st.inMandate && move <= -3 && budget > 100) {
      const usd = roomIn(s, st, budget / 2);
      if (usd > 100) {
        trades.push({ action: "buy", symbol: st.symbol, usd });
        budget -= usd;
      }
    }
  }
  return { reasoning: trades.length ? "Buying dips in allowed stocks and trimming winners." : "No dip or gain past the thresholds; holding.", trades: trades.slice(0, 3) };
}

function decideMomentum(s: Snapshot): Plan {
  const stressed = deRisk(s);
  if (stressed) return stressed;
  const trades: Trade[] = [];
  let budget = s.idleUsdg * 0.8;
  for (const st of s.stocks) {
    const move = moveOf(st);
    if (move <= -4 && st.positionUsd > 1) {
      trades.push({ action: "sell", symbol: st.symbol, usd: st.positionUsd });
    } else if (st.inMandate && move >= 2 && budget > 100) {
      const usd = roomIn(s, st, budget / 2);
      if (usd > 100) {
        trades.push({ action: "buy", symbol: st.symbol, usd });
        budget -= usd;
      }
    }
  }
  return { reasoning: trades.length ? "Adding to stocks trending up and cutting losers." : "No trend strong enough to act on; holding.", trades: trades.slice(0, 3) };
}

// ------------------------------------------------------------------ executing

/** Facility ABI plus RiskManager errors, so refusals raised inside the facility's risk checks decode by name. */
const facilityAbiWithRiskErrors = [...creditFacilityAbi, ...riskManagerAbi.filter((x) => x.type === "error")] as const;

function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return formatRevert(revert.data?.errorName ?? revert.reason ?? "reverted", revert.data?.args ?? [], d);
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

type Wallet = ReturnType<typeof clientFor>;

async function execute(w: Wallet, f: Address, s: Snapshot, t: Trade) {
  if (t.action === "repay") return repay(w, f, t);
  const st = s.stocks.find((x) => x.symbol === t.symbol);
  if (!st) return { status: "skipped" as const, detail: `cannot ${t.action} ${t.symbol}` };
  const token = d.stocks[st.symbol].token;
  let tokenIn: Address, tokenOut: Address, amountIn: bigint;

  if (t.action === "buy") {
    const usd = Math.min(t.usd, s.idleUsdg);
    if (usd < 1) return { status: "skipped" as const, detail: "no idle USDG" };
    [tokenIn, tokenOut, amountIn] = [d.usdg, token, parseUnits(usd.toFixed(6), 6)];
  } else {
    if (st.shares <= 0) return { status: "skipped" as const, detail: "no position" };
    const shares = Math.min(t.usd / st.live, st.shares);
    const bal = await publicClient.readContract({ address: token, abi: mockERC20Abi, functionName: "balanceOf", args: [f] });
    const amt = parseUnits(shares.toFixed(12), 18);
    [tokenIn, tokenOut, amountIn] = [token, d.usdg, amt > bal ? bal : amt];
  }

  try {
    const quoted = await publicClient.readContract({
      address: d.venue,
      abi: demoVenueAbi,
      functionName: "quoteOut",
      args: [tokenIn, tokenOut, amountIn],
    });
    const minOut = (quoted * 995n) / 1000n;
    const { request } = await publicClient.simulateContract({
      account: w.account,
      address: f,
      abi: facilityAbiWithRiskErrors,
      functionName: "trade",
      args: [d.venue, tokenIn, tokenOut, amountIn, minOut],
    });
    const tx = await w.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: tx });
    return { status: "filled" as const, detail: `${t.action} ${t.symbol} ~$${t.usd.toFixed(0)}`, tx };
  } catch (err) {
    return { status: "refused" as const, detail: `contract refused: ${revertReason(err)}` };
  }
}

/** Repay from the facility's current idle USDG (read fresh: sells earlier in the same cycle add to it). */
async function repay(w: Wallet, f: Address, t: Trade) {
  try {
    const idle = await publicClient.readContract({ address: d.usdg, abi: mockERC20Abi, functionName: "balanceOf", args: [f] });
    const want = parseUnits(t.usd.toFixed(6), 6);
    const amount = want > idle ? idle : want;
    if (amount === 0n) return { status: "skipped" as const, detail: "no idle USDG" };
    const { request } = await publicClient.simulateContract({
      account: w.account,
      address: f,
      abi: facilityAbiWithRiskErrors,
      functionName: "repay",
      args: [amount],
    });
    const tx = await w.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: tx });
    return { status: "filled" as const, detail: `repaid $${formatUnits(amount, 6)}`, tx };
  } catch (err) {
    return { status: "refused" as const, detail: `contract refused: ${revertReason(err)}` };
  }
}

const running = new Set<string>();

async function run(a: Stored, forced?: Trade[]): Promise<AgentDecision> {
  const key = a.facility.toLowerCase();
  if (running.has(key)) throw new Error("A decision is already in progress for this facility");
  const status = await statusOf(a);
  if (status !== "running") throw new Error(`Agent is ${status} on this facility`);
  running.add(key);
  try {
    await ensureGas(a.agent);
    const w = clientFor(a.agentId, a.facility);
    const s = await snapshot(a.facility);
    const p = profile(a.agentId);

    let source: AgentDecision["source"] = p.strategy === "claude" ? "claude" : "rules";
    let plan: Plan;
    if (forced) {
      source = "operator";
      plan = { reasoning: "Forced trade from the control plane.", trades: forced };
    } else if (p.strategy === "claude") {
      if (!claude) throw new Error("Claude is not configured on this server");
      plan = await decideWithClaude(s, a.instructions);
    } else plan = p.strategy === "dip" ? decideDip(s) : decideMomentum(s);

    const decision: AgentDecision = { at: new Date().toISOString(), source, reasoning: plan.reasoning, trades: [] };
    for (const t of plan.trades.slice(0, 3)) {
      const r = await execute(w, a.facility, s, t);
      decision.trades.push({ ...t, ...r });
      log(`${a.facility.slice(0, 10)} ${t.action.toUpperCase()} ${t.symbol} $${t.usd.toFixed(0)} -> ${r.status}: ${r.detail}`);
    }
    a.history.unshift(decision);
    a.history.splice(50);
    a.lastRunAt = decision.at;
    a.lastError = undefined;
    save();
    log(`${a.facility.slice(0, 10)} [${source}] ${plan.reasoning}`);
    return decision;
  } catch (err) {
    a.lastError = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (!forced) a.lastRunAt = new Date().toISOString();
    save();
    throw err;
  } finally {
    running.delete(key);
  }
}

// ------------------------------------------------------------------ API

const publicProfile = ({ strategy: _s, ...p }: (typeof CATALOG)[number]): AgentProfile => p;

serve("agent", Number(env("AGENT_PORT", "8789")), {
  "GET /agents": () => ({ agents: CATALOG.map(publicProfile), intervalMs: INTERVAL }),

  "GET /agents/:id/address": (_b, { params, query }) => {
    profile(params.id);
    if (!/^0x[0-9a-fA-F]{40}$/.test(query.facility ?? "")) throw new Error("facility query parameter required");
    return { agent: addressFor(params.id, query.facility as Address) };
  },

  /** Owner-signed hire. Fields: Agent, Agent address, Instructions. Appointing onchain (setAgent) is separate. */
  "POST /assignments": async (b: SignedOwnerRequest) => {
    await verifyOwnerRequest(b, "hire-agent");
    const p = profile(b.fields.Agent ?? "");
    if (!p.available) throw new Error(`${p.name} is not available right now`);
    const agent = addressFor(p.id, b.facility);
    if (b.fields["Agent address"]?.toLowerCase() !== agent.toLowerCase()) throw new Error("Agent address does not match");
    const prev = store[b.facility.toLowerCase()];
    const sameAgent = prev?.agentId === p.id;
    store[b.facility.toLowerCase()] = {
      facility: b.facility,
      agentId: p.id,
      agent,
      instructions: (b.fields.Instructions ?? "").trim() || p.defaultInstructions,
      hiredAt: new Date().toISOString(),
      seenRunning: false,
      history: sameAgent ? prev.history : [],
    };
    if (!sameAgent) anchors.delete(b.facility.toLowerCase());
    save();
    await ensureGas(agent);
    log(`hired ${p.id} for ${b.facility} as ${agent}`);
    const a = store[b.facility.toLowerCase()];
    // First decision shortly after hire, so the owner sees the agent working without waiting a full interval.
    setTimeout(() => run(a).catch((e) => log(`${a.facility.slice(0, 10)} first run: ${e.message}`)), 3000);
    return view(a);
  },

  "POST /assignments/:facility/instructions": async (b: SignedOwnerRequest, { params }) => {
    if (b.facility?.toLowerCase() !== params.facility.toLowerCase()) throw new Error("Facility mismatch");
    await verifyOwnerRequest(b, "update-instructions");
    const a = assignmentOf(params.facility);
    a.instructions = (b.fields.Instructions ?? "").trim() || profile(a.agentId).defaultInstructions;
    save();
    return view(a);
  },

  "GET /assignments/:facility": async (_b, { params }) => {
    const a = store[params.facility.toLowerCase()];
    return { assignment: a ? await view(a) : null };
  },

  // ---------------------------------------------------------------- admin (demo control plane)

  "GET /admin/assignments": async () => ({
    treasury: treasury.account.address,
    model: claude ? MODEL : null,
    intervalMs: INTERVAL,
    assignments: await Promise.all(Object.values(store).map(view)),
  }),
  /** Run one decision cycle now. */
  "POST /admin/tick": (b: { facility: Address }) => run(assignmentOf(b.facility)),
  /** Force a specific trade, e.g. one outside the mandate, to show the contract refusing it. */
  "POST /admin/try": (b: Trade & { facility: Address }) =>
    run(assignmentOf(b.facility), [{ action: b.action, symbol: b.symbol, usd: Number(b.usd) }]),
});

log(
  `treasury ${treasury.account.address}; ${claude ? `Claude via ${MODEL}` : "Claude unavailable (no ANTHROPIC_API_KEY)"}; ` +
    (INTERVAL > 0 ? `deciding every ${INTERVAL / 1000}s` : "autorun off (control plane triggers decisions)"),
);

let cycling = false;
if (INTERVAL > 0)
  setInterval(async () => {
    if (cycling) return;
    cycling = true;
    try {
      for (const a of Object.values(store)) {
        if (a.lastRunAt && Date.now() - Date.parse(a.lastRunAt) < INTERVAL * 0.9) continue;
        if ((await statusOf(a).catch(() => null)) !== "running") continue;
        await run(a).catch((err) => log(`${a.facility.slice(0, 10)} cycle failed: ${err instanceof Error ? err.message : err}`));
      }
    } finally {
      cycling = false;
    }
  }, Math.min(INTERVAL, 10_000));
