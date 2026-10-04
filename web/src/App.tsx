import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseUnits, type Abi, type Address } from "viem";
import { ATT_STATUSES, STATES, SYMBOLS, facilityFactoryAbi, type StockSymbol } from "@hapax/shared";
import {
  LOOKBACK,
  chainId,
  connectWallet,
  deployment,
  facilitiesFor,
  facilityAbiFull,
  publicClient,
  readEvents,
  readParams,
  readPrices,
  readSnapshot,
  send,
  sortPrices,
  type ChainEvent,
  type PricePoint,
  type RiskParams,
  type Snapshot,
  type Wallet,
} from "./lib/chain";
import { api, type AgentHistory } from "./lib/services";
import { ago, etTime, pct, pctNum, price, shares, short, stateLabel, stateTone, until, usd, usdUnits } from "./lib/format";
import { Meter, type Tone } from "./components/Meter";
import { PriceChart, type Level } from "./components/PriceChart";
import { Activity } from "./components/Activity";

const POLL_MS = Number(import.meta.env.VITE_POLL_MS ?? 2500);
const WAD = 10n ** 18n;
const bps = (x: number) => BigInt(x) * 10n ** 14n; // bps -> 1e18 fraction

type Toast = { kind: "ok" | "err"; title: string; detail?: string } | null;

export default function App() {
  if (!deployment) return <Setup />;
  return <Console />;
}

function Setup() {
  return (
    <div className="setup card">
      <h2>No Hapax deployment for chain {chainId}</h2>
      <p className="note">Deploy the contracts, then reload. The app reads contracts/deployments/{chainId}.json.</p>
      <pre>{`anvil\npnpm deploy:local   # or: pnpm deploy:testnet\npnpm abis`}</pre>
    </div>
  );
}

function Console() {
  const d = deployment!;
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [facility, setFacility] = useState<Address | null>(() => {
    const h = location.hash.slice(1);
    return /^0x[0-9a-fA-F]{40}$/.test(h) ? (h as Address) : null;
  });
  const [known, setKnown] = useState<readonly Address[]>([]);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [params, setParams] = useState<RiskParams | null>(null);
  const [events, setEvents] = useState<ChainEvent[]>([]);
  const [symbol, setSymbol] = useState<StockSymbol>("TSLA");
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [agentInfo, setAgentInfo] = useState<AgentHistory | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const cursor = useRef<{ events: bigint | null; prices: bigint | null }>({ events: null, prices: null });

  // ---------------------------------------------------------------- polling
  useEffect(() => {
    readParams().then(setParams).catch(() => {});
  }, []);

  useEffect(() => {
    if (facility) location.hash = facility;
    setSnap(null);
    setEvents([]);
    cursor.current.events = null;
  }, [facility]);

  useEffect(() => {
    setPrices([]);
    cursor.current.prices = null;
  }, [symbol]);

  const tick = useCallback(async () => {
    const latest = await publicClient.getBlockNumber();
    const start = latest > LOOKBACK ? latest - LOOKBACK : 0n;

    if (!facility) {
      const list = await facilitiesFor(wallet?.address);
      setKnown(list);
      if (list.length) setFacility(list[list.length - 1]);
      return;
    }

    const s = await readSnapshot(facility);
    setSnap(s);

    const evFrom = cursor.current.events ?? start;
    if (latest >= evFrom) {
      const fresh = await readEvents(facility, evFrom, latest);
      cursor.current.events = latest + 1n;
      if (fresh.length) setEvents((prev) => dedupe([...prev, ...fresh]));
    }
    const pxFrom = cursor.current.prices ?? start;
    if (latest >= pxFrom) {
      const fresh = await readPrices(symbol, pxFrom, latest);
      cursor.current.prices = latest + 1n;
      if (fresh.length)
        setPrices((prev) => {
          const byKey = new Map([...prev, ...fresh].map((p) => [p.key, p]));
          return sortPrices([...byKey.values()]).slice(-1500);
        });
    }

    api<AgentHistory>("agent", "/history").then(setAgentInfo, () => setAgentInfo(null));
  }, [facility, symbol, wallet]);

  useEffect(() => {
    let alive = true;
    let running = false;
    const run = async () => {
      if (running || !alive) return;
      running = true;
      try {
        await tick();
      } catch (err) {
        console.warn("poll failed", err);
      } finally {
        running = false;
      }
    };
    run();
    const id = setInterval(run, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [tick]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.kind === "err" ? 9000 : 4500);
    return () => clearTimeout(id);
  }, [toast]);

  // ---------------------------------------------------------------- actions
  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>, done?: string) => {
      setBusy(label);
      try {
        await fn();
        setToast({ kind: "ok", title: done ?? `${label}: done` });
        await tick().catch(() => {});
      } catch (err) {
        setToast({ kind: "err", title: `${label} failed`, detail: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(null);
      }
    },
    [tick],
  );

  const needWallet = async () => {
    if (wallet) return wallet;
    const w = await connectWallet();
    setWallet(w);
    return w;
  };
  const facilityWrite = async (functionName: string, args: readonly unknown[]) =>
    send(await needWallet(), { address: facility!, abi: facilityAbiFull as Abi, functionName, args });

  const openFacility = () =>
    act("Open facility", async () => {
      const w = await needWallet();
      await send(w, { address: d.factory, abi: facilityFactoryAbi as Abi, functionName: "openFacility" });
      const mine = await facilitiesFor(w.address);
      setFacility(mine[mine.length - 1]);
    }, "Facility opened");

  const isOwner = !!(wallet && snap && wallet.address.toLowerCase() === snap.owner.toLowerCase());

  // ---------------------------------------------------------------- derived
  const state = snap ? STATES[snap.e.state] : null;
  const tone: Tone = state ? stateTone[state] : "muted";
  const anyClosed = snap?.e.anyClosed ?? false;
  const now = snap ? Number(snap.block.timestamp) : Math.floor(Date.now() / 1000);
  const sel = snap?.stocks.find((s) => s.symbol === symbol);

  const levels: Level[] = useMemo(() => {
    if (!snap || !params || !sel || sel.balance === 0n || snap.e.debt === 0n) return [];
    // Price of the selected stock at which position health crosses each threshold, other holdings fixed.
    const debt = Number(snap.e.debt) / 1e18;
    const held = Number(sel.balance) / 1e18;
    const other = Number(snap.e.assets) / 1e18 - held * (Number(sel.mark) / 1e18);
    const at = (hBps: number) => ((hBps / 1e4) * debt - other) / held;
    const levels: Level[] = [
      { name: "Warning", price: at(params.hWarnBps), tone: "warn" },
      { name: "Margin call", price: at(params.hCallBps), tone: "crit" },
      { name: "Keeper sells", price: at(params.hDelevBps), tone: "crit" },
    ];
    // Only levels still ahead: a level above the live price has already been crossed.
    const live = Number(sel.live) / 1e18;
    return levels.filter((l) => l.price < live);
  }, [snap, params, sel]);

  return (
    <div className="wrap">
      <Header snap={snap} wallet={wallet} onConnect={() => act("Connect wallet", needWallet, "Wallet connected")} symbol={symbol} />

      {!facility || !snap ? (
        <section className="card">
          <h2>{facility ? "Loading facility…" : "No facility yet"}</h2>
          {!facility && (
            <>
              <p className="note">A facility is your credit account on Robinhood Chain. Your broker vouches for your holdings; your agent trades inside it.</p>
              <div className="actions">
                <button className="primary" disabled={!!busy} onClick={openFacility}>Open a facility</button>
                {known.map((f) => (
                  <button key={f} onClick={() => setFacility(f)}>View {short(f)}</button>
                ))}
              </div>
            </>
          )}
        </section>
      ) : (
        <>
          <Scene snap={snap} />

          <div className="row">
            <BuyingPower snap={snap} isOwner={isOwner} busy={busy} act={act} facilityWrite={facilityWrite} />
            <section className="card c4" aria-labelledby="risk">
              <div className="head">
                <span className="label" id="risk">Risk</span>
                <span className="label num">debt {usd(snap.e.debt)}</span>
              </div>
              {params && <RiskMeters snap={snap} params={params} />}
            </section>
            <Positions snap={snap} />
          </div>

          <div className="row">
            <section className="card c8" aria-labelledby="chartTitle">
              <div className="head">
                <h2 id="chartTitle">{symbol}: live market vs reference feed</h2>
                <div className="tabs" role="group" aria-label="Stock">
                  {SYMBOLS.map((s) => (
                    <button key={s} aria-pressed={s === symbol} onClick={() => setSymbol(s)}>{s}</button>
                  ))}
                </div>
              </div>
              <PriceChart points={prices} heartbeat={sel?.refHeartbeat ?? 300} now={now} levels={levels} />
              <div className="legend">
                <span><i style={{ background: "var(--accent)" }} />Live market (24/7)</span>
                <span><i style={{ background: "var(--muted)" }} />Reference feed (24/5)</span>
                <span><i style={{ background: "color-mix(in srgb, var(--frozen) 30%, transparent)", height: 10 }} />Stock market closed</span>
                {levels.length > 0 && <span>Dashed lines: where this position's health crosses each level</span>}
              </div>
            </section>
            <Mandate snap={snap} isOwner={isOwner} busy={busy} act={act} facilityWrite={facilityWrite} agentInfo={agentInfo} />
          </div>

          <div className="row">
            <section className="card c7" aria-labelledby="feedTitle">
              <div className="head">
                <h2 id="feedTitle">Agent and risk activity</h2>
                <span className="label">{agentInfo ? `agent: ${agentInfo.model}` : "agent service offline"}</span>
              </div>
              <Activity events={events} decisions={agentInfo?.facility?.toLowerCase() === facility.toLowerCase() ? agentInfo.history : []} agent={snap.agent} deployment={d} />
            </section>
            <Collateral snap={snap} busy={busy} act={act} />
          </div>

          <DemoConsole snap={snap} busy={busy} act={act} />
        </>
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <b>{toast.title}</b>
          {toast.detail && <div><code>{toast.detail}</code></div>}
        </div>
      )}
    </div>
  );
}

type Act = (label: string, fn: () => Promise<unknown>, done?: string) => Promise<void>;
type FacilityWrite = (fn: string, args: readonly unknown[]) => Promise<unknown>;

function dedupe(list: ChainEvent[]) {
  const seen = new Map(list.map((e) => [e.key, e]));
  return [...seen.values()];
}

// ==================================================================== header and scene

function Header({ snap, wallet, onConnect, symbol }: { snap: Snapshot | null; wallet: Wallet | null; onConnect: () => void; symbol: StockSymbol }) {
  const now = snap ? Number(snap.block.timestamp) : 0;
  const s = snap?.stocks.find((x) => x.symbol === symbol);
  return (
    <header className="strip">
      <div className="brand">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 4v16M20 4v16M4 12h16" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="12" r="2.4" fill="var(--accent)" />
        </svg>
        <b>hapax</b>
        {snap && <span>facility {short(snap.facility)}</span>}
      </div>
      {snap && (
        <div className="micro" aria-label="Chain status">
          <div>Chain<em>{chainId === 46630 ? "Robinhood testnet" : chainId === 4663 ? "Robinhood" : "Local"} · {chainId}</em></div>
          <div>Block<em className="num">#{snap.block.number?.toLocaleString("en-US")}</em></div>
          {s && <div>{symbol} live<em className="num">{ago(now - Number(s.liveUpdatedAt))}</em></div>}
          {s && <div>{symbol} reference<em className={`num ${s.closed ? "stale" : ""}`}>{s.closed ? "closed · " : ""}{ago(now - Number(s.refUpdatedAt))}</em></div>}
          <div>Attestation<em className="num">{ATT_STATUSES[snap.collateral.status] === "NONE" ? "none" : `#${snap.collateral.nonce} · ${until(Number(snap.collateral.expiresAt) - now)}`}</em></div>
        </div>
      )}
      <div className="who">
        {deployment!.mocks && <span className="badge">mock tokens</span>}
        <span className="badge">demo feeds</span>
        <button onClick={onConnect}>{wallet ? `${short(wallet.address)} · ${wallet.kind}` : "Connect wallet"}</button>
      </div>
    </header>
  );
}

function Scene({ snap }: { snap: Snapshot }) {
  const state = STATES[snap.e.state];
  const now = Number(snap.block.timestamp);
  const closed = snap.e.anyClosed;
  const residual = usd(snap.e.debt);
  const text: Record<typeof state, string> = {
    ACTIVE: closed
      ? "The stock market is closed, so Hapax prices everything from the 24/7 Robinhood Chain market. Weekend haircuts apply."
      : "The market is open. Your agent can trade within its mandate.",
    WARNING: "Risk is rising. Your agent can still trade, but every buy is re-checked against the margin limit.",
    MARGIN_CALL: "New risk is blocked. Your agent can sell and repay, but it cannot buy.",
    DELEVERAGING: "The facility is past its limit. Anyone can trigger the sell-down, and the keeper will.",
    FROZEN: "The broker stopped vouching for your collateral. Only selling and repaying are allowed.",
    CURE: `Positions were sold and most of the debt repaid. Repay the remaining ${residual} to avoid default.`,
    DEFAULT: `The cure window passed. The broker has been asked to sell pledged shares to settle ${residual}.`,
    CLOSED: "Settled and closed.",
  };
  return (
    <section className={`scene tone-${stateTone[state]}`} aria-label="Current state">
      <p>
        <strong>{etTime(now)} ET.</strong> {text[state]}
        {snap.e.degraded && " Live prices are stale, so borrowing and buying are paused."}
      </p>
      <div className="chips">
        <span className={`pill tone-${closed ? "frozen" : "ok"}`}>{closed ? "Market closed" : "Market open"}</span>
        <span className={`pill tone-${stateTone[state]}`}>{stateLabel[state]}</span>
      </div>
    </section>
  );
}

// ==================================================================== summary row

function BuyingPower({ snap, isOwner, busy, act, facilityWrite }: { snap: Snapshot; isOwner: boolean; busy: string | null; act: Act; facilityWrite: FacilityWrite }) {
  const [amount, setAmount] = useState("");
  const state = STATES[snap.e.state];
  const cashOut = (snap.e.creditLimit * 7000n) / 10000n;
  const value = amount ? parseUnits(amount, 6) : 0n;
  return (
    <section className="card c4" aria-labelledby="bp">
      <div className="head">
        <span className="label" id="bp">Buying power</span>
        {snap.buyingPower === 0n && snap.e.debt > 0n && <span className="badge">paused</span>}
      </div>
      <div className="big num">{usdUnits(snap.buyingPower)}<small> available</small></div>
      <p className="note">
        {state === "ACTIVE"
          ? "How much more USDG you can draw for your agent right now."
          : state === "CLOSED"
            ? "This facility is settled and closed."
            : state === "DEFAULT"
              ? "In default. The broker settles the remaining debt from your pledged shares."
              : "New borrowing is paused until the facility is healthy again."}
      </p>
      <dl className="compare">
        <div><dt>Credit limit (broker-backed)</dt><dd className="num">{usd(snap.e.creditLimit)}</dd></div>
        <div><dt>Cash-out margin, same account</dt><dd className="num">{usd(cashOut)}</dd></div>
        <div><dt>Borrowed so far</dt><dd className="num hi">{usd(snap.e.debt)}</dd></div>
        <div><dt>Idle USDG in the facility</dt><dd className="num">{usdUnits(snap.idle)}</dd></div>
      </dl>
      {isOwner && (
        <div className="inline">
          <label className="field">
            <span>USDG amount</span>
            <input id="borrowAmount" inputMode="decimal" placeholder="300000" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
          </label>
          <div className="actions">
            <button className="primary" disabled={!!busy || !value} onClick={() => act("Borrow", () => facilityWrite("borrow", [value]), `Borrowed ${amount} USDG`)}>Borrow</button>
            <button disabled={!!busy || !value} onClick={() => act("Repay", () => facilityWrite("repay", [value]), `Repaid ${amount} USDG`)}>Repay</button>
          </div>
        </div>
      )}
    </section>
  );
}

function RiskMeters({ snap, params }: { snap: Snapshot; params: RiskParams }) {
  const u = snap.e.debt === 0n ? 0 : Math.min(pctNum(snap.e.U), 130);
  const h = snap.e.debt === 0n ? null : Math.min(pctNum(snap.e.H), 130);
  const p = (b: number) => b / 100;
  const uTone: Tone =
    snap.e.U >= bps(params.uCallBps) ? "crit" : snap.e.U >= bps(params.uWarnBps) ? "warn" : snap.e.U > bps(params.maxBorrowUtilBps) ? "warn" : "ok";
  const hTone: Tone =
    h === null ? "muted" : snap.e.H < bps(params.hCallBps) ? "crit" : snap.e.H < bps(params.hWarnBps) ? "warn" : "ok";
  return (
    <>
      <Meter
        label="Credit used"
        value={u}
        min={0}
        max={110}
        ticks={[p(params.maxBorrowUtilBps), p(params.uWarnBps), p(params.uCallBps), p(params.uDelevBps)]}
        tone={uTone}
        note={`Stressed loss ${usd(snap.e.exposure)} of a ${usd(snap.e.creditLimit)} limit. Above ${p(params.maxBorrowUtilBps)}% no new risk is allowed; at ${p(params.uDelevBps)}% the keeper sells.`}
      />
      <Meter
        label="Position health"
        value={h}
        min={75}
        max={105}
        ticks={[p(params.hDelevBps), p(params.hCallBps), p(params.hWarnBps), 100]}
        tone={hTone}
        invert
        note={
          h === null
            ? "No debt, nothing at risk."
            : `Holdings cover ${pct(snap.e.H)} of the debt. Margin call below ${p(params.hCallBps)}%; below ${p(params.hDelevBps)}% the keeper sells.`
        }
      />
    </>
  );
}

function Positions({ snap }: { snap: Snapshot }) {
  const held = snap.stocks.filter((s) => s.balance > 0n);
  const total = held.reduce((acc, s) => acc + (s.balance * s.mark) / WAD, 0n);
  return (
    <section className="card c4" aria-labelledby="pos">
      <div className="head"><span className="label" id="pos">Positions</span><span className="label">held in the facility</span></div>
      <div className="tbl">
        <table>
          <thead><tr><th>Asset</th><th>Shares</th><th>Mark</th><th>Value</th></tr></thead>
          <tbody>
            {held.map((s) => {
              const move = Number(s.live) / Number(s.reference) - 1;
              return (
                <tr key={s.symbol}>
                  <td>{s.symbol} <span className={move < 0 ? "neg" : "pos"}>{(move * 100).toFixed(1)}%</span></td>
                  <td>{shares(s.balance)}</td>
                  <td>{price(s.mark)}</td>
                  <td>{usd((s.balance * s.mark) / WAD)}</td>
                </tr>
              );
            })}
            <tr><td>USDG idle</td><td>–</td><td>$1.00</td><td>{usdUnits(snap.idle)}</td></tr>
          </tbody>
          <tfoot><tr><td>Total</td><td></td><td></td><td>{usd(total + snap.idle * 10n ** 12n)}</td></tr></tfoot>
        </table>
      </div>
      <p className="note">Percent is the move since the last reference price. Marks use the lower of reference and live while the market is closed.</p>
    </section>
  );
}

// ==================================================================== mandate

function Mandate({ snap, isOwner, busy, act, facilityWrite, agentInfo }: { snap: Snapshot; isOwner: boolean; busy: string | null; act: Act; facilityWrite: FacilityWrite; agentInfo: AgentHistory | null }) {
  const d = deployment!;
  const now = Number(snap.block.timestamp);
  const m = snap.mandate;
  const [agentAddr, setAgentAddr] = useState("");
  const [picked, setPicked] = useState<StockSymbol[]>(["TSLA", "NFLX"]);
  const [cap, setCap] = useState("300000");
  const [hours, setHours] = useState("24");
  const [instructions, setInstructions] = useState("");
  const agentKey = agentAddr || agentInfo?.agent || "";

  const appoint = () =>
    act("Appoint agent", async () => {
      const expires = BigInt(now + Math.round(Number(hours) * 3600));
      await facilityWrite("setAgent", [agentKey as Address, expires, parseUnits(cap || "0", 18), picked.map((s) => d.stocks[s].token)]);
      await api("agent", "/facility", { facility: snap.facility }).catch(() => {});
      if (instructions.trim()) await api("agent", "/instructions", { instructions }).catch(() => {});
    }, "Agent appointed");

  return (
    <section className="card c4" aria-labelledby="mandate">
      <div className="head">
        <span className="label" id="mandate">Agent mandate</span>
        <span className="badge">{m.active ? "enforced onchain" : "no active agent"}</span>
      </div>

      {m.active && snap.agent ? (
        <>
          <div>
            <h2>{agentInfo?.agent?.toLowerCase() === snap.agent.toLowerCase() ? (agentInfo.model.startsWith("claude") ? "Claude" : "Rules agent") : "Agent"}, trading as {short(snap.agent)}</h2>
            {agentInfo?.instructions && <p className="note">“{agentInfo.instructions}”</p>}
          </div>
          <div className="chips" aria-label="Stocks the agent may buy">
            {SYMBOLS.map((s) => (
              <span key={s} className={`chip ${m.symbols.includes(s) ? "yes" : "no"}`}>{s}</span>
            ))}
          </div>
          <dl className="kv">
            <dt>Max per position</dt><dd className="num">{m.maxPositionUsd === 0n ? "global cap" : usd(m.maxPositionUsd)}</dd>
            <dt>Expires</dt><dd>{etTime(m.expiresAt)} · {until(Number(m.expiresAt) - now)}</dd>
          </dl>
          <div className="rights">
            <div className="can"><b>Can</b>Buy listed stocks, sell anything, repay</div>
            <div className="cannot"><b>Cannot</b>Borrow, withdraw, change its mandate</div>
          </div>
          {isOwner && (
            <button className="danger" disabled={!!busy} onClick={() => act("Revoke agent", () => facilityWrite("revokeAgent", []), "Agent revoked")}>
              Revoke agent
            </button>
          )}
        </>
      ) : isOwner ? (
        <>
          <p className="note">Give an AI agent buying power, not keys. It can trade only what you allow here, and the contract enforces it.</p>
          <label className="field"><span>Agent address</span>
            <input id="agentAddr" placeholder={agentInfo?.agent ?? "0x…"} value={agentAddr} onChange={(e) => setAgentAddr(e.target.value.trim())} />
          </label>
          <div className="field"><span>May buy</span>
            <div className="checks">
              {SYMBOLS.map((s) => (
                <label key={s}>
                  <input type="checkbox" id={`may-${s}`} checked={picked.includes(s)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s] : p.filter((x) => x !== s)))} />
                  {s}
                </label>
              ))}
            </div>
          </div>
          <div className="grid3">
            <label className="field"><span>Max / position $</span><input id="cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ""))} /></label>
            <label className="field"><span>Hours</span><input id="hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value.replace(/[^0-9.]/g, ""))} /></label>
          </div>
          <label className="field"><span>Instructions for the agent</span>
            <textarea id="instructions" placeholder="Trade large-cap tech. Buy dips, keep a reserve." value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </label>
          <button className="primary" disabled={!!busy || !/^0x[0-9a-fA-F]{40}$/.test(agentKey) || !picked.length} onClick={appoint}>
            Appoint agent
          </button>
        </>
      ) : (
        <p className="note">No active agent. Connect the owner's wallet to appoint one.</p>
      )}
    </section>
  );
}

// ==================================================================== collateral

function Collateral({ snap, busy, act }: { snap: Snapshot; busy: string | null; act: Act }) {
  const status = ATT_STATUSES[snap.collateral.status];
  const [tsla, setTsla] = useState("1000");
  const [amzn, setAmzn] = useState("500");
  const [cash, setCash] = useState("50000");
  const rows = snap.collateral.positions.map((p) => {
    const s = snap.stocks.find((x) => x.symbol === p.symbol)!;
    const value = (p.shares * s.mark) / WAD;
    const hc = s.closed ? s.haircutClosedBps : s.haircutOpenBps;
    return { symbol: p.symbol!, shares: p.shares, mark: s.mark, value, counts: (value * BigInt(10000 - hc)) / 10000n, hc };
  });
  const eligible = rows.reduce((a, r) => a + r.counts, 0n) + snap.collateral.cashUsd - snap.collateral.encumberedUsd;
  const tone = status === "VALID" ? "ok" : status === "NONE" ? "muted" : "crit";

  return (
    <section className="card c5" aria-labelledby="coll">
      <div className="head">
        <span className="label" id="coll">Collateral at the broker</span>
        <span className={`badge`} style={{ color: `var(--${tone})` }}>
          {status === "NONE" ? "not linked" : status === "VALID" ? `signed · nonce ${snap.collateral.nonce}` : status.toLowerCase()}
        </span>
      </div>
      {status === "NONE" ? (
        <>
          <p className="note">Link a brokerage account. The broker signs what you hold; your shares never move.</p>
          <div className="grid3">
            <label className="field"><span>TSLA shares</span><input id="hTsla" value={tsla} onChange={(e) => setTsla(e.target.value.replace(/[^0-9.]/g, ""))} /></label>
            <label className="field"><span>AMZN shares</span><input id="hAmzn" value={amzn} onChange={(e) => setAmzn(e.target.value.replace(/[^0-9.]/g, ""))} /></label>
            <label className="field"><span>Cash $</span><input id="hCash" value={cash} onChange={(e) => setCash(e.target.value.replace(/[^0-9.]/g, ""))} /></label>
          </div>
          <button className="primary" disabled={!!busy} onClick={() =>
            act("Link brokerage account", () => api("broker", "/accounts", { facility: snap.facility, holdings: { TSLA: Number(tsla), AMZN: Number(amzn) }, cashUsd: Number(cash) }), "Broker attested your holdings")}>
            Link brokerage account
          </button>
        </>
      ) : (
        <>
          <p className="note">Your shares stay in your brokerage account. The broker signs what you hold; Hapax prices it.</p>
          <div className="tbl">
            <table>
              <thead><tr><th>Holding</th><th>Price</th><th>Value</th><th>Counts</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol}>
                    <td>{shares(r.shares).replace(/\.00$/, "")} {r.symbol}</td>
                    <td>{price(r.mark)}</td>
                    <td>{usd(r.value)}</td>
                    <td>{usd(r.counts)}</td>
                  </tr>
                ))}
                <tr><td>Cash</td><td>–</td><td>{usd(snap.collateral.cashUsd)}</td><td>{usd(snap.collateral.cashUsd)}</td></tr>
                {snap.collateral.encumberedUsd > 0n && (
                  <tr><td>Encumbered</td><td>–</td><td></td><td className="neg">−{usd(snap.collateral.encumberedUsd)}</td></tr>
                )}
              </tbody>
              <tfoot>
                <tr><td>Eligible</td><td></td><td></td><td>{usd(eligible > 0n ? eligible : 0n)}</td></tr>
                <tr><td>Credit limit</td><td></td><td></td><td>{usd(snap.e.creditLimit)}</td></tr>
              </tfoot>
            </table>
          </div>
          <p className="note">
            {snap.e.anyClosed
              ? "The market is closed: stocks count at 60% and are priced at the lower of Friday's close and the live market."
              : "The market is open: stocks count at 75% of their reference price."}{" "}
            If the broker stops signing, the facility freezes in the same block.
          </p>
        </>
      )}
    </section>
  );
}

// ==================================================================== demo console

function DemoConsole({ snap, busy, act }: { snap: Snapshot; busy: string | null; act: Act }) {
  const [shockSym, setShockSym] = useState<StockSymbol>("TSLA");
  const [pctMove, setPctMove] = useState("-16");
  const residualUsd = Math.ceil(Number(snap.e.debt) / 1e18);
  const f = snap.facility;
  // A TSLA buy that lands $30k past the agent's per-position cap, if the facility holds enough idle USDG to try it.
  const tsla = snap.stocks.find((s) => s.symbol === "TSLA")!;
  const capUsd = Number(snap.mandate.maxPositionUsd) / 1e18;
  const heldUsd = (Number(tsla.balance) / 1e18) * (Number(tsla.mark) / 1e18);
  const want = capUsd - heldUsd + 30_000;
  const overCap = snap.mandate.active && capUsd > 0 && want <= Number(snap.idle) / 1e6 ? want : null;
  return (
    <section className="card c12 console" aria-label="Demo controls">
      <div className="head">
        <h2>Demo console</h2>
        <span className="label">drives the demo services, not part of the product</span>
      </div>
      <div className="group">
        <span className="label">Market</span>
        <button disabled={!!busy} onClick={() => act("Open market", () => api("market", "/session", { open: true }), "Market open")}>Open market</button>
        <button disabled={!!busy} onClick={() => act("Close market", () => api("market", "/session", { open: false }), "Market closed: reference feeds stopped")}>Close market</button>
        <select id="shockSym" value={shockSym} onChange={(e) => setShockSym(e.target.value as StockSymbol)} style={{ width: "auto" }}>
          {SYMBOLS.map((s) => <option key={s}>{s}</option>)}
        </select>
        <input id="shockPct" value={pctMove} onChange={(e) => setPctMove(e.target.value.replace(/[^0-9.-]/g, ""))} style={{ width: 80 }} aria-label="Percent move" />
        <button disabled={!!busy} onClick={() => act("Move price", () => api("market", "/shock", { symbol: shockSym, pct: Number(pctMove) }), `${shockSym} ${pctMove}% from the last reference`)}>Move price</button>
      </div>
      <div className="group">
        <span className="label">Agent</span>
        <button disabled={!!busy} onClick={() => act("Connect agent", () => api("agent", "/facility", { facility: f }), "Agent watching this facility")}>Point agent here</button>
        <button className="primary" disabled={!!busy} onClick={() => act("Agent decision", () => api("agent", "/tick", {}), "Agent decided")}>Run agent now</button>
        <button disabled={!!busy} onClick={() => act("Off-mandate buy", () => api("agent", "/try", { action: "buy", symbol: "AMZN", usd: 10000 }), "Sent; see the activity feed")}>Try AMZN buy</button>
        <button disabled={!!busy || overCap === null} onClick={() => act("Over-cap buy", () => api("agent", "/try", { action: "buy", symbol: "TSLA", usd: overCap }), "Sent; see the activity feed")}>
          {overCap === null ? "Try TSLA over cap" : `Try $${Math.round(overCap / 1000)}k TSLA (over cap)`}
        </button>
      </div>
      <div className="group">
        <span className="label">Broker</span>
        <button className="danger" disabled={!!busy} onClick={() => act("Broker revokes", () => api("broker", "/revoke", { facility: f }), "Attestation revoked")}>Revoke attestation</button>
        <button disabled={!!busy} onClick={() => act("Broker goes silent", () => api("broker", "/silence", { facility: f }), "Broker stopped signing; the attestation will expire")}>Stop signing</button>
        <button disabled={!!busy} onClick={() => act("Broker reinstates", () => api("broker", "/reinstate", { facility: f }), "Fresh attestation signed")}>Reinstate</button>
        <button disabled={!!busy || STATES[snap.e.state] !== "DEFAULT"} onClick={() => act("Settle", () => api("broker", "/settle", { facility: f, amountUsd: residualUsd }), "Broker settled the default")}>
          Settle default ({usd(snap.e.debt)})
        </button>
      </div>
    </section>
  );
}
