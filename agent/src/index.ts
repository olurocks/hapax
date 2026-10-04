// Hapax agent: an AI trader that gets buying power, not keys.
//
// It holds the facility's agent key. Each tick it reads the facility and market, asks Claude for trades as
// validated JSON, and submits them. The contract is the leash: anything outside the mandate (wrong stock,
// position too big, facility at risk) reverts onchain, and the agent logs the refusal instead of crashing.
// Without ANTHROPIC_API_KEY (or on an API error or refusal) it falls back to a small rules strategy so the
// demo never depends on a network call.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  BaseError,
  ContractFunctionRevertedError,
  formatUnits,
  parseUnits,
  type Address,
} from "viem";
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
  type StockSymbol,
} from "@hapax/shared";
import { env, loadDeployment, publicClient, walletFor } from "@hapax/shared/env";
import { log as mkLog, serve } from "@hapax/shared/http";

const log = mkLog("agent");
const d = loadDeployment();
const wallet = walletFor("AGENT_PK");
const INTERVAL = Number(env("AGENT_INTERVAL_MS", "60000"));
const MODEL = "claude-opus-5-5";
const claude = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;

let facility = (process.env.AGENT_FACILITY ?? "") as Address | "";
let instructions = env(
  "AGENT_MANDATE",
  "Trade large-cap tech stock tokens. Buy dips of 3% or more from the last close, take profit above +5%, " +
    "keep at least 20% of idle USDG in reserve, and never chase a position past its cap.",
);

/** A buy or sell of a stock, or a repayment of debt from idle USDG (symbol "USDG"). */
type Trade = { action: "buy" | "sell" | "repay"; symbol: StockSymbol | "USDG"; usd: number };
interface Decision {
  at: string;
  source: "claude" | "rules" | "manual";
  reasoning: string;
  trades: Array<Trade & { status: "filled" | "refused" | "skipped"; detail: string; tx?: string }>;
}
const history: Decision[] = [];

/** Price when the agent first saw each stock: the reference for "dip" and "gain" while the market is open. */
const anchors: Partial<Record<StockSymbol, number>> = {};

/** Facility ABI plus RiskManager errors, so refusals raised inside the facility's risk checks decode by name. */
const facilityAbiWithRiskErrors = [...creditFacilityAbi, ...riskManagerAbi.filter((x) => x.type === "error")] as const;

// ------------------------------------------------------------------ state

async function snapshot(f: Address) {
  const [e, [mandate, mandateTokens, active], idle] = await Promise.all([
    publicClient.readContract({ address: d.risk, abi: riskManagerAbi, functionName: "evaluate", args: [f] }),
    publicClient.readContract({ address: f, abi: creditFacilityAbi, functionName: "mandate" }),
    publicClient.readContract({ address: d.usdg, abi: mockERC20Abi, functionName: "balanceOf", args: [f] }),
  ]);
  const allowed = new Set(mandateTokens.map((t) => t.toLowerCase()));
  const stocks = await Promise.all(
    SYMBOLS.map(async (s) => {
      const token = d.stocks[s].token;
      const [q, bal] = await Promise.all([
        publicClient.readContract({ address: d.oracle, abi: marketOracleAbi, functionName: "quote", args: [token] }),
        publicClient.readContract({ address: token, abi: mockERC20Abi, functionName: "balanceOf", args: [f] }),
      ]);
      const live = fromWad(q.live);
      const shares = Number(formatUnits(bal, 18));
      anchors[s] ??= live;
      return {
        symbol: s,
        inMandate: allowed.has(token.toLowerCase()),
        lastClose: fromWad(q.reference_),
        live,
        changeFromClose: +(((live / fromWad(q.reference_)) - 1) * 100).toFixed(2),
        changeSinceAgentStart: +(((live / anchors[s]!) - 1) * 100).toFixed(2),
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

async function decideWithClaude(s: Snapshot): Promise<{ reasoning: string; trades: Trade[] }> {
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

/** Deterministic fallback: buy mandate dips, trim winners, cut risk when the facility is stressed. */
function decideWithRules(s: Snapshot): { reasoning: string; trades: Trade[] } {
  const trades: Trade[] = [];
  if (s.state !== "ACTIVE") {
    if (s.idleUsdg > 1 && s.debtUsd > 0) trades.push({ action: "repay", symbol: "USDG", usd: Math.min(s.idleUsdg, s.debtUsd) });
    for (const st of s.stocks) if (st.positionUsd > 1) trades.push({ action: "sell", symbol: st.symbol, usd: st.positionUsd / 2 });
    return { reasoning: `Facility is ${s.state}; repaying from idle USDG and halving positions to cut risk.`, trades: trades.slice(0, 3) };
  }
  let budget = s.idleUsdg * 0.8;
  for (const st of s.stocks) {
    // Weekend: measure from the last close. Market open: the reference follows the price, so use the agent's anchor.
    const move = st.marketClosed ? st.changeFromClose : st.changeSinceAgentStart;
    if (move >= 5 && st.positionUsd > 1) {
      trades.push({ action: "sell", symbol: st.symbol, usd: st.positionUsd / 2 });
    } else if (st.inMandate && move <= -3 && budget > 100) {
      const room = s.mandate.maxPositionUsd > 0 ? s.mandate.maxPositionUsd * 0.98 - st.positionUsd : budget;
      const usd = Math.min(budget / 2, room);
      if (usd > 100) {
        trades.push({ action: "buy", symbol: st.symbol, usd });
        budget -= usd;
      }
    }
  }
  return { reasoning: trades.length ? "Buying mandate dips and trimming winners." : "No signal; holding.", trades: trades.slice(0, 3) };
}

// ------------------------------------------------------------------ executing

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

async function execute(f: Address, s: Snapshot, t: Trade) {
  if (t.action === "repay") return repay(f, t);
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
      account: wallet.account,
      address: f,
      abi: facilityAbiWithRiskErrors,
      functionName: "trade",
      args: [d.venue, tokenIn, tokenOut, amountIn, minOut],
    });
    const tx = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: tx });
    return { status: "filled" as const, detail: `${t.action} ${t.symbol} ~$${t.usd.toFixed(0)}`, tx };
  } catch (err) {
    return { status: "refused" as const, detail: `contract refused: ${revertReason(err)}` };
  }
}

/** Repay from the facility's current idle USDG (read fresh: sells earlier in the same tick add to it). */
async function repay(f: Address, t: Trade) {
  try {
    const idle = await publicClient.readContract({ address: d.usdg, abi: mockERC20Abi, functionName: "balanceOf", args: [f] });
    const want = parseUnits(t.usd.toFixed(6), 6);
    const amount = want > idle ? idle : want;
    if (amount === 0n) return { status: "skipped" as const, detail: "no idle USDG" };
    const { request } = await publicClient.simulateContract({
      account: wallet.account,
      address: f,
      abi: facilityAbiWithRiskErrors,
      functionName: "repay",
      args: [amount],
    });
    const tx = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: tx });
    return { status: "filled" as const, detail: `repaid $${formatUnits(amount, 6)}`, tx };
  } catch (err) {
    return { status: "refused" as const, detail: `contract refused: ${revertReason(err)}` };
  }
}

async function run(source: Decision["source"], forced?: Trade[]) {
  if (!facility) throw new Error("No facility set. POST /facility { facility } or set AGENT_FACILITY.");
  const f = facility as Address;
  const s = await snapshot(f);
  if (!s.mandate.active) throw new Error("Agent mandate is not active on this facility (setAgent or expired).");

  let plan: { reasoning: string; trades: Trade[] };
  if (forced) plan = { reasoning: "Manual instruction from the operator console.", trades: forced };
  else if (claude) {
    try {
      plan = await decideWithClaude(s);
    } catch (err) {
      log(`claude unavailable (${err instanceof Error ? err.message : err}); using rules`);
      source = "rules";
      plan = decideWithRules(s);
    }
  } else plan = decideWithRules(s);

  const decision: Decision = { at: new Date().toISOString(), source, reasoning: plan.reasoning, trades: [] };
  for (const t of plan.trades.slice(0, 3)) {
    const r = await execute(f, s, t);
    decision.trades.push({ ...t, ...r });
    log(`${t.action.toUpperCase()} ${t.symbol} $${t.usd.toFixed(0)} -> ${r.status}: ${r.detail}`);
  }
  history.unshift(decision);
  history.splice(50);
  log(`[${source}] ${plan.reasoning}`);
  return decision;
}

// ------------------------------------------------------------------ API

serve("agent", Number(env("AGENT_PORT", "8789")), {
  "GET /agent": async () => ({
    agent: wallet.account.address,
    facility,
    model: claude ? MODEL : "rules (no ANTHROPIC_API_KEY)",
    instructions,
    snapshot: facility ? await snapshot(facility as Address).catch((e) => ({ error: e.message })) : null,
    history,
  }),
  /** Cheap poll for the dashboard: no chain reads. */
  "GET /history": () => ({
    agent: wallet.account.address,
    facility,
    model: claude ? MODEL : "rules",
    instructions,
    history,
  }),
  "POST /facility": (b: { facility: Address }) => {
    facility = b.facility;
    return { facility };
  },
  "POST /instructions": (b: { instructions: string }) => {
    instructions = b.instructions;
    return { instructions };
  },
  /** Run one decision cycle now. */
  "POST /tick": () => run(claude ? "claude" : "rules"),
  /** Force a specific trade, e.g. one outside the mandate, to show the contract refusing it. */
  "POST /try": (b: Trade) => run("manual", [b]),
});

log(
  `agent ${wallet.account.address}, ${claude ? `deciding with ${MODEL}` : "rules mode (no ANTHROPIC_API_KEY)"}, ` +
    (INTERVAL > 0 ? `every ${INTERVAL / 1000}s` : "autorun off (POST /tick to decide)"),
);
let busy = false;
if (INTERVAL > 0) setInterval(async () => {
  if (busy || !facility) return;
  busy = true;
  try {
    await run(claude ? "claude" : "rules");
  } catch (err) {
    log(`tick failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    busy = false;
  }
}, INTERVAL);
