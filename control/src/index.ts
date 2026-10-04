// Demo control plane. Everything Hapax simulates (the brokerage's customers, the price feeds, the broker's
// revoke/settle decisions, the clock, test funds, forcing an agent decision) is set from here, never from the app.
// It listens on localhost only and forwards to the other services' /admin routes with the shared admin token.
//
// Drive it with plain HTTP or with the CLI: `pnpm demo help`.
import { formatEther, parseEther, parseUnits, type Address } from "viem";
import {
  ATT_STATUSES,
  STATES,
  SYMBOLS,
  collateralRegistryAbi,
  creditFacilityAbi,
  facilityFactoryAbi,
  fromWad,
  liquidityPoolAbi,
  mockERC20Abi,
  riskManagerAbi,
  type StockSymbol,
} from "@hapax/shared";
import { chainId, env, loadDeployment, publicClient, walletFor } from "@hapax/shared/env";
import { adminCall, log as mkLog, serve } from "@hapax/shared/http";

const log = mkLog("control");
const d = loadDeployment();
const funder = walletFor("DEPLOYER_PK");
const local = chainId === 31337;

const url = (port: string, fallback: string) => `http://127.0.0.1:${env(port, fallback)}`;
const svc = {
  broker: url("BROKER_PORT", "8787"),
  market: url("MARKET_PORT", "8788"),
  agent: url("AGENT_PORT", "8789"),
};

const isAddr = (x: unknown): x is Address => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);

/**
 * Accepts a facility address, an owner wallet (→ their newest facility), or nothing / "latest"
 * (→ the newest facility on the deployment), so demo commands don't need addresses copied around.
 */
async function facilityFrom(x?: string): Promise<Address> {
  if (isAddr(x)) {
    const isFacility = await publicClient.readContract({ address: d.factory, abi: facilityFactoryAbi, functionName: "isFacility", args: [x] });
    if (isFacility) return x;
    const mine = await publicClient.readContract({ address: d.factory, abi: facilityFactoryAbi, functionName: "facilitiesOf", args: [x] });
    if (!mine.length) throw new Error(`${x} is neither a facility nor the owner of one`);
    return mine[mine.length - 1];
  }
  if (x && x !== "latest") throw new Error(`Not an address: ${x}`);
  const all = await publicClient.readContract({ address: d.factory, abi: facilityFactoryAbi, functionName: "facilities" });
  if (!all.length) throw new Error("No facilities yet");
  return all[all.length - 1];
}

let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

async function overview() {
  const facilities = await publicClient.readContract({ address: d.factory, abi: facilityFactoryAbi, functionName: "facilities" });
  const [block, broker, agents, market] = await Promise.all([
    publicClient.getBlock(),
    adminCall<{ links: Array<{ facility: string; username: string; active: boolean; attesting: boolean }> }>(svc.broker, "/admin/accounts").catch(() => null),
    adminCall<{ assignments: Array<{ facility: string; agentName: string; status: string }> }>(svc.agent, "/admin/assignments").catch(() => null),
    adminCall<{ open: boolean; live: Record<string, number> }>(svc.market, "/admin/market").catch(() => null),
  ]);
  const rows = await Promise.all(
    facilities.map(async (f) => {
      const [owner, e, att, debt] = await Promise.all([
        publicClient.readContract({ address: f, abi: creditFacilityAbi, functionName: "owner" }),
        publicClient.readContract({ address: d.risk, abi: riskManagerAbi, functionName: "evaluate", args: [f] }),
        publicClient.readContract({ address: d.registry, abi: collateralRegistryAbi, functionName: "status", args: [f] }),
        publicClient.readContract({ address: d.pool, abi: liquidityPoolAbi, functionName: "debtOf", args: [f] }),
      ]);
      const link = broker?.links.find((l) => l.facility.toLowerCase() === f.toLowerCase());
      const agent = agents?.assignments.find((a) => a.facility.toLowerCase() === f.toLowerCase());
      return {
        facility: f,
        owner,
        state: STATES[e.state],
        attestation: ATT_STATUSES[att],
        debtUsd: Number(debt) / 1e6,
        creditLimitUsd: fromWad(e.creditLimit),
        U: e.U > 10n ** 30n ? null : +(fromWad(e.U) * 100).toFixed(1),
        H: e.H > 10n ** 30n ? null : +(fromWad(e.H) * 100).toFixed(1),
        brokerage: link ? `${link.username}${link.active ? "" : " (disconnected)"}${link.active && !link.attesting ? " (not attesting)" : ""}` : null,
        agent: agent ? `${agent.agentName} (${agent.status})` : null,
      };
    }),
  );
  return {
    chainId,
    blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    services: { broker: !!broker, agent: !!agents, market: !!market },
    poolCashUsd: Number(await publicClient.readContract({ address: d.pool, abi: liquidityPoolAbi, functionName: "cash" })) / 1e6,
    market: market ? { open: market.open, live: market.live } : null,
    facilities: rows,
  };
}

serve(
  "control",
  Number(env("CONTROL_PORT", "8791")),
  {
    "GET /status": overview,

    // -------------------------------------------------------------- brokerage customers
    "GET /brokerage": () => adminCall(svc.broker, "/admin/accounts"),
    /** { username, passcode, holder?, holdings: { TSLA: 1000, AMZN: 500 }, cashUsd } create or update a customer */
    "POST /brokerage": (b) => adminCall(svc.broker, "/admin/accounts", b),

    // -------------------------------------------------------------- test funds
    /** { wallet, usdg?: 100000, eth?: 1 } gas and USDG for a user's wallet */
    "POST /faucet": (b: { wallet: Address; usdg?: number; eth?: number }) =>
      enqueue(async () => {
        if (!isAddr(b.wallet)) throw new Error("wallet address required");
        const out: Record<string, string> = {};
        const eth = b.eth ?? (local ? 1 : 0.02);
        if (eth > 0) {
          const hash = await funder.sendTransaction({ to: b.wallet, value: parseEther(String(eth)) });
          await publicClient.waitForTransactionReceipt({ hash });
          out.eth = hash;
        }
        const usdg = b.usdg ?? 100_000;
        if (usdg > 0) {
          if (!d.mocks) throw new Error("USDG is not mintable on this deployment; fund the wallet from the USDG faucet");
          const hash = await funder.writeContract({ address: d.usdg, abi: mockERC20Abi, functionName: "mint", args: [b.wallet, parseUnits(String(usdg), 6)] });
          await publicClient.waitForTransactionReceipt({ hash });
          out.usdg = hash;
        }
        const [ethBal, usdgBal] = await Promise.all([
          publicClient.getBalance({ address: b.wallet }),
          publicClient.readContract({ address: d.usdg, abi: mockERC20Abi, functionName: "balanceOf", args: [b.wallet] }),
        ]);
        log(`faucet ${b.wallet}: +${eth} ETH, +${usdg} USDG`);
        return { wallet: b.wallet, tx: out, balances: { eth: formatEther(ethBal), usdg: Number(usdgBal) / 1e6 } };
      }),

    // -------------------------------------------------------------- lender liquidity
    /** { usd } the lender supplies more USDG to the pool (mock USDG only) */
    "POST /pool/supply": (b: { usd: number }) =>
      enqueue(async () => {
        if (!d.mocks) throw new Error("USDG is not mintable on this deployment");
        const amount = parseUnits(String(b.usd), 6);
        for (const [address, abi, functionName, args] of [
          [d.usdg, mockERC20Abi, "mint", [funder.account.address, amount]],
          [d.usdg, mockERC20Abi, "approve", [d.pool, amount]],
          [d.pool, liquidityPoolAbi, "supply", [amount]],
        ] as const) {
          const hash = await funder.writeContract({ address, abi, functionName, args } as never);
          await publicClient.waitForTransactionReceipt({ hash });
        }
        const cash = await publicClient.readContract({ address: d.pool, abi: liquidityPoolAbi, functionName: "cash" });
        log(`pool +$${b.usd}`);
        return { cashUsd: Number(cash) / 1e6 };
      }),

    // -------------------------------------------------------------- market
    "GET /market": () => adminCall(svc.market, "/admin/market"),
    "POST /market/open": () => adminCall(svc.market, "/admin/session", { open: true }),
    "POST /market/close": () => adminCall(svc.market, "/admin/session", { open: false }),
    /** { symbol, price } */
    "POST /market/price": (b: { symbol: StockSymbol; price: number }) => adminCall(svc.market, "/admin/price", b),
    /** { symbol, pct } relative to the last reference price */
    "POST /market/shock": (b: { symbol: StockSymbol; pct: number }) => adminCall(svc.market, "/admin/shock", b),

    // -------------------------------------------------------------- broker decisions
    "POST /broker/revoke": async (b: { facility?: string; reason?: number }) =>
      adminCall(svc.broker, "/admin/revoke", { facility: await facilityFrom(b.facility), reason: b.reason }),
    "POST /broker/silence": async (b: { facility?: string }) => adminCall(svc.broker, "/admin/silence", { facility: await facilityFrom(b.facility) }),
    "POST /broker/reinstate": async (b: { facility?: string }) => adminCall(svc.broker, "/admin/reinstate", { facility: await facilityFrom(b.facility) }),
    /** { facility?, usd } margin used elsewhere at the broker */
    "POST /broker/encumber": async (b: { facility?: string; usd: number }) =>
      adminCall(svc.broker, "/admin/encumber", { facility: await facilityFrom(b.facility), encumberedUsd: Number(b.usd) }),
    /** { facility?, usd? } sale proceeds after DEFAULT; defaults to the full debt */
    "POST /broker/settle": async (b: { facility?: string; usd?: number }) =>
      adminCall(svc.broker, "/admin/settle", { facility: await facilityFrom(b.facility), amountUsd: b.usd === undefined ? undefined : Number(b.usd) }),

    // -------------------------------------------------------------- agents
    "GET /agents": () => adminCall(svc.agent, "/admin/assignments"),
    "POST /agent/tick": async (b: { facility?: string }) => adminCall(svc.agent, "/admin/tick", { facility: await facilityFrom(b.facility) }),
    /** { facility?, action: buy|sell|repay, symbol, usd } force a trade, e.g. outside the mandate */
    "POST /agent/try": async (b: { facility?: string; action: string; symbol: string; usd: number }) => {
      if (b.action !== "repay" && !SYMBOLS.includes(b.symbol as StockSymbol)) throw new Error(`Unknown symbol ${b.symbol}`);
      return adminCall(svc.agent, "/admin/try", { ...b, facility: await facilityFrom(b.facility) });
    },

    // -------------------------------------------------------------- time (local Anvil only)
    /** { seconds } jump the chain clock, e.g. past a cure window */
    "POST /time/advance": async (b: { seconds: number }) => {
      if (!local) throw new Error("Time travel is only available on local Anvil");
      await publicClient.request({ method: "evm_increaseTime" as never, params: [Number(b.seconds)] as never });
      await publicClient.request({ method: "evm_mine" as never, params: [] as never });
      const { timestamp } = await publicClient.getBlock();
      return { blockTime: new Date(Number(timestamp) * 1000).toISOString() };
    },
  },
  { host: "127.0.0.1" },
);

log(`chain ${chainId}; broker ${svc.broker}, market ${svc.market}, agent ${svc.agent}; funder ${funder.account.address}`);
