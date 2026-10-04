// Market operator. Robinhood Chain's testnet stock feeds are mocks, so Hapax runs its own operator-controlled
// feeds to make "Friday close" and "Saturday crash" repeatable. Every route is part of the demo control plane
// (/admin/*, x-admin-token); the app only ever reads the feeds onchain.
//
//   session OPEN   : republish reference AND live prices every tick (reference stays fresh => market open)
//   session CLOSED : republish live prices only; the reference goes stale after its heartbeat => market closed
//
// Mainnet replaces all of this with Chainlink stock feeds (24/5) and an onchain TWAP (24/7).
import { parseUnits } from "viem";
import { SYMBOLS, demoFeedAbi, marketOracleAbi, type StockSymbol } from "@hapax/shared";
import { env, loadDeployment, publicClient, walletFor } from "@hapax/shared/env";
import { log as mkLog, serve } from "@hapax/shared/http";

const log = mkLog("market");
const d = loadDeployment();
const wallet = walletFor("DEPLOYER_PK");
const TICK = Number(env("MARKET_TICK_MS", "30000"));

const market = {
  open: true,
  reference: { TSLA: 250, AMZN: 200, NFLX: 100 } as Record<StockSymbol, number>,
  live: { TSLA: 250, AMZN: 200, NFLX: 100 } as Record<StockSymbol, number>,
};

const px = (usd: number) => parseUnits(usd.toFixed(8), 8);

async function publish(feed: `0x${string}`, usd: number) {
  const hash = await wallet.writeContract({
    address: feed,
    abi: demoFeedAbi,
    functionName: "setAnswer",
    args: [px(usd)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/** Publish every feed that should be fresh in the current session. */
const tick = () =>
  enqueue(async () => {
    for (const s of SYMBOLS) {
      if (market.open) {
        market.reference[s] = market.live[s];
        await publish(d.stocks[s].refFeed, market.reference[s]);
      }
      await publish(d.stocks[s].liveFeed, market.live[s]);
    }
  });

const backdateReference = () =>
  enqueue(async () => {
    const { timestamp } = await publicClient.getBlock();
    for (const s of SYMBOLS) {
      const cfg = await publicClient.readContract({
        address: d.oracle,
        abi: marketOracleAbi,
        functionName: "config",
        args: [d.stocks[s].token],
      });
      const hash = await wallet.writeContract({
        address: d.stocks[s].refFeed,
        abi: demoFeedAbi,
        functionName: "setRoundData",
        args: [px(market.reference[s]), timestamp - BigInt(cfg.refHeartbeat) - 1n],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  });

async function quotes() {
  const out: Record<string, unknown> = {};
  for (const s of SYMBOLS) {
    const q = await publicClient.readContract({
      address: d.oracle,
      abi: marketOracleAbi,
      functionName: "quote",
      args: [d.stocks[s].token],
    });
    out[s] = { ...q, onchainClosed: q.closed };
  }
  return out;
}

serve("market", Number(env("MARKET_PORT", "8788")), {
  "GET /admin/market": async () => ({ ...market, demoFeeds: true, quotes: await quotes() }),

  /**
   * { open: false } = Friday 4pm. The reference stops publishing and its last print is dated past the heartbeat,
   * so the oracle sees a closed session immediately instead of after the heartbeat lapses.
   */
  "POST /admin/session": async (b: { open: boolean }) => {
    market.open = b.open;
    log(`session ${b.open ? "OPEN" : "CLOSED"}`);
    if (!b.open) await backdateReference();
    await tick();
    return market;
  },

  /** { symbol: "TSLA", price: 210 } moves the 24/7 live market (and the reference too while open). */
  "POST /admin/price": async (b: { symbol: StockSymbol; price: number }) => {
    if (!SYMBOLS.includes(b.symbol)) throw new Error(`Unknown symbol ${b.symbol}`);
    market.live[b.symbol] = b.price;
    log(`${b.symbol} live -> $${b.price}`);
    await tick();
    return market;
  },

  /** { symbol: "TSLA", pct: -16 } relative move from the last reference price. */
  "POST /admin/shock": async (b: { symbol: StockSymbol; pct: number }) => {
    if (!SYMBOLS.includes(b.symbol)) throw new Error(`Unknown symbol ${b.symbol}`);
    market.live[b.symbol] = +(market.reference[b.symbol] * (1 + b.pct / 100)).toFixed(4);
    log(`${b.symbol} shock ${b.pct}% -> $${market.live[b.symbol]}`);
    await tick();
    return market;
  },
});

/** Resume from what is onchain, so a restart doesn't snap prices back to the deploy defaults. */
async function resume() {
  for (const s of SYMBOLS) {
    const [ref, live] = await Promise.all([
      publicClient.readContract({ address: d.stocks[s].refFeed, abi: demoFeedAbi, functionName: "latestRoundData" }),
      publicClient.readContract({ address: d.stocks[s].liveFeed, abi: demoFeedAbi, functionName: "latestRoundData" }),
    ]);
    market.reference[s] = Number(ref[1]) / 1e8;
    market.live[s] = Number(live[1]) / 1e8;
  }
  // A restart always reopens the session: a reference that went stale while the service was down is downtime,
  // not a Friday close. Close it deliberately with `pnpm demo close`.
  log(`resumed ${market.open ? "OPEN" : "CLOSED"} ${JSON.stringify(market.live)}`);
}

log(`operator ${wallet.account.address}, republishing every ${TICK / 1000}s`);
resume()
  .catch((e) => log(`resume failed, using defaults: ${e.message}`))
  .then(() => tick())
  .catch((e) => log(`initial publish failed: ${e.message}`));
setInterval(() => tick().catch((e) => log(`publish failed: ${e.message}`)), TICK);
