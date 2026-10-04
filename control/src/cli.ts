// `pnpm demo <command>`: a thin client for the control service. Run `pnpm demo help` for the list.
const BASE = `http://127.0.0.1:${process.env.CONTROL_PORT ?? "8791"}`;

const HELP = `Hapax demo control (talks to the control service at ${BASE})

  status                                    facilities, states, brokerage links, agents, market
  seed <username> <passcode> [TSLA=1000] [AMZN=500] [NFLX=0] [cash=50000] [holder="Alex Rivera"]
                                            create or update a brokerage customer (re-attests if linked)
  customers                                 list brokerage customers and links
  faucet <wallet> [usdg=100000] [eth=1]     gas and USDG for a user's wallet
  liquidity <usd>                           the lender supplies more USDG to the pool

  open | close                              stock market session (close = Friday 4pm)
  price <SYM> <usd>                         set the 24/7 live price
  shock <SYM> <pct>                         move live price by pct from the last close, e.g. shock TSLA -16
  market                                    current feed state

  revoke [facility]                         broker revokes the attestation (facility freezes in the same block)
  silence [facility] | reinstate [facility] broker stops / resumes signing
  encumber [facility] <usd>                 margin used elsewhere at the broker
  settle [facility] [usd]                   broker settles a defaulted facility (default: full debt)

  agents                                    hired agents and their status
  tick [facility]                           force one agent decision now
  try [facility] <buy|sell|repay> <SYM> <usd>   force a specific agent trade (e.g. outside the mandate)

  advance <seconds>                         jump the chain clock (local Anvil only)

[facility] is a facility address, an owner wallet (their newest facility), or omitted (newest facility).`;

const isAddr = (x?: string) => !!x && /^0x[0-9a-fA-F]{40}$/.test(x);

async function call(path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Control service not reachable at ${BASE}. Start it with "pnpm control".`);
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((out as { error?: string }).error ?? `HTTP ${res.status}`);
  return out;
}

/** Split leading optional facility from the remaining positional args. */
function withFacility(args: string[]) {
  return isAddr(args[0]) ? { facility: args[0], rest: args.slice(1) } : { facility: undefined, rest: args };
}

function kv(args: string[]) {
  const out: Record<string, string> = {};
  for (const a of args) {
    const i = a.indexOf("=");
    if (i > 0) out[a.slice(0, i)] = a.slice(i + 1);
  }
  return out;
}

const num = (x: string | undefined, name: string) => {
  const n = Number(x);
  if (x === undefined || Number.isNaN(n)) throw new Error(`${name} must be a number`);
  return n;
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2).filter((a) => a !== "--");
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      return HELP;
    case "status":
      return call("/status");
    case "customers":
      return call("/brokerage");
    case "seed": {
      const [username, passcode, ...rest] = args;
      if (!username || !passcode) throw new Error("usage: seed <username> <passcode> [TSLA=1000] [AMZN=500] [NFLX=0] [cash=50000] [holder=...]");
      const o = kv(rest);
      const holdings = Object.fromEntries(
        ["TSLA", "AMZN", "NFLX"].map((s) => [s, Number(o[s] ?? o[s.toLowerCase()] ?? (s === "TSLA" ? 1000 : s === "AMZN" ? 500 : 0))]),
      );
      return call("/brokerage", { username, passcode, holder: o.holder, holdings, cashUsd: Number(o.cash ?? 50000) });
    }
    case "faucet": {
      const [wallet, ...rest] = args;
      if (!isAddr(wallet)) throw new Error("usage: faucet <wallet> [usdg=100000] [eth=1]");
      const o = kv(rest);
      return call("/faucet", { wallet, usdg: o.usdg ? Number(o.usdg) : undefined, eth: o.eth ? Number(o.eth) : undefined });
    }
    case "liquidity":
      return call("/pool/supply", { usd: num(args[0], "usd") });
    case "open":
      return call("/market/open", {});
    case "close":
      return call("/market/close", {});
    case "market":
      return call("/market");
    case "price":
      return call("/market/price", { symbol: args[0]?.toUpperCase(), price: num(args[1], "price") });
    case "shock":
      return call("/market/shock", { symbol: args[0]?.toUpperCase(), pct: num(args[1], "pct") });
    case "revoke":
    case "silence":
    case "reinstate":
      return call(`/broker/${cmd}`, { facility: withFacility(args).facility });
    case "encumber": {
      const { facility, rest } = withFacility(args);
      return call("/broker/encumber", { facility, usd: num(rest[0], "usd") });
    }
    case "settle": {
      const { facility, rest } = withFacility(args);
      return call("/broker/settle", { facility, usd: rest[0] === undefined ? undefined : num(rest[0], "usd") });
    }
    case "agents":
      return call("/agents");
    case "tick":
      return call("/agent/tick", { facility: withFacility(args).facility });
    case "try": {
      const { facility, rest } = withFacility(args);
      const [action, symbol, usd] = rest;
      if (!["buy", "sell", "repay"].includes(action)) throw new Error("usage: try [facility] <buy|sell|repay> <SYM> <usd>");
      return call("/agent/try", { facility, action, symbol: symbol?.toUpperCase(), usd: num(usd, "usd") });
    }
    case "advance":
      return call("/time/advance", { seconds: num(args[0], "seconds") });
    default:
      throw new Error(`Unknown command "${cmd}". Run "pnpm demo help".`);
  }
}

main().then(
  (out) => console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2)),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
