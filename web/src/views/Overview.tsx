import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { ATT_STATUSES, STATES, SYMBOLS } from "@hapax/shared";
import { useAccount } from "../lib/account";
import type { RiskParams, Snapshot } from "../lib/chain";
import * as act from "../lib/actions";
import { etTime, pct, pctNum, price, shares, signedUsd, stateLabel, stateTone, usd, usdUnits } from "../lib/format";
import { Meter, type Tone } from "../components/Meter";
import { PriceChart, type Level } from "../components/PriceChart";
import { Modal } from "../components/Modal";

type Go = (t: "overview" | "agent" | "collateral" | "activity") => void;
const WAD = 10n ** 18n;
const SCALE = 10n ** 12n; // USDG units (6) -> WAD (18)
const bps = (x: number) => BigInt(x) * 10n ** 14n;

/** Money figures every view needs, derived once from the snapshot. */
export function money(snap: Snapshot) {
  const equity = snap.e.assets - snap.e.debt; // WAD, may be negative
  const netIn = (snap.flows.contributed - snap.flows.distributed) * SCALE;
  const debtUnits = snap.e.debt / SCALE;
  const state = STATES[snap.e.state];
  const att = ATT_STATUSES[snap.collateral.status];
  const canWithdraw = state === "ACTIVE" && (snap.e.debt === 0n || att === "VALID");
  const surplusUnits = equity > 0n ? equity / SCALE : 0n;
  const withdrawable = canWithdraw ? (snap.idle < surplusUnits ? snap.idle : surplusUnits) : 0n;
  const holdingsLive = snap.stocks.reduce((a, s) => a + (s.balance * s.live) / WAD, 0n);
  return { equity, profit: equity - netIn, debtUnits, withdrawable, canWithdraw, holdingsLive, state, att };
}

export function Overview({ go }: { go: Go }) {
  const a = useAccount();
  const snap = a.snap!;
  return (
    <>
      <StatusBanner />
      <Setup key={a.facility} go={go} />
      <div className="row">
        <Summary />
        <Funds />
        <section className="card c4" aria-labelledby="risk">
          <div className="head">
            <span className="label" id="risk">Risk</span>
            <span className={`pill tone-${stateTone[STATES[snap.e.state]]}`}>{stateLabel[STATES[snap.e.state]]}</span>
          </div>
          {a.params && <RiskMeters snap={snap} params={a.params} />}
        </section>
      </div>
      <div className="row">
        <Positions />
        <Chart />
      </div>
    </>
  );
}

// ==================================================================== status and setup

function StatusBanner() {
  const { snap, link } = useAccount();
  const s = snap!;
  const state = STATES[s.e.state];
  const closed = s.e.anyClosed;
  const now = Number(s.block.timestamp);
  const debt = usd(s.e.debt);
  const disconnected = state === "FROZEN" && s.e.debt === 0n && link && !link.linked;
  const text: Record<typeof state, string> = {
    ACTIVE: closed
      ? "The stock market is closed. Hapax is pricing your holdings from the 24/7 onchain market, with weekend haircuts."
      : "The stock market is open. Your account is in good standing.",
    WARNING: "Risk is rising. Your agent can still trade, but every buy is checked against your margin.",
    MARGIN_CALL: "Margin call: new buys are blocked. Repay or sell to bring your account back to health.",
    DELEVERAGING: "Your account is past its limit. Positions are being sold automatically to repay debt.",
    FROZEN: disconnected
      ? "Your brokerage is disconnected. Connect it again to borrow."
      : "Your broker stopped vouching for your holdings. Only selling and repaying are allowed.",
    CURE: `Your positions were sold and most of the debt repaid. Repay the remaining ${debt} to avoid default.`,
    DEFAULT: `Your account is in default. Your broker has been asked to sell pledged shares to settle ${debt}.`,
    CLOSED: "This account was settled and closed.",
  };
  const tone = disconnected ? "muted" : stateTone[state];
  return (
    <section className={`scene tone-${tone}`} aria-label="Account status">
      <p>
        <strong>{etTime(now)} ET.</strong> {text[state]}
        {s.e.degraded && " Market prices are delayed, so borrowing and buying are paused."}
      </p>
      <div className="chips">
        <span className={`pill tone-${closed ? "frozen" : "ok"}`}>{closed ? "Market closed" : "Market open"}</span>
      </div>
    </section>
  );
}

function Setup({ go }: { go: Go }) {
  const { snap, link, assignment, facility } = useAccount();
  const s = snap!;
  const key = `hapax.setup.${facility}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const steps = [
    { label: "Open your credit account", done: true },
    { label: "Connect your brokerage", done: ATT_STATUSES[s.collateral.status] !== "NONE" || !!link?.linked, go: () => go("collateral") },
    { label: "Borrow USDG", done: s.e.debt > 0n || s.flows.contributed > 0n, go: () => document.getElementById("funds")?.scrollIntoView({ behavior: "smooth" }) },
    { label: "Hire an agent", done: !!assignment || !!s.agent, go: () => go("agent") },
  ];
  if (hidden || steps.every((x) => x.done)) return null;
  const next = steps.find((x) => !x.done)!;
  return (
    <section className="card setup" aria-labelledby="setupTitle">
      <div className="head">
        <h2 id="setupTitle">Get started</h2>
        <button className="ghost small" onClick={() => {
          setHidden(true);
          try { localStorage.setItem(key, "1"); } catch { /* storage unavailable */ }
        }}>Hide</button>
      </div>
      <ol className="checklist">
        {steps.map((x) => (
          <li key={x.label} className={x.done ? "done" : x === next ? "next" : ""}>
            <span className="dot" aria-hidden="true">{x.done ? "✓" : ""}</span>
            <span>{x.label}</span>
            {x === next && x.go && <button className="primary small" onClick={x.go}>Continue</button>}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ==================================================================== summary and funds

function Summary() {
  const { snap, aprBps } = useAccount();
  const s = snap!;
  const m = money(s);
  return (
    <section className="card c4" aria-labelledby="value">
      <div className="head"><span className="label" id="value">Account value</span></div>
      <div className="big num">{signedUsd(m.equity)}</div>
      <p className="note">What your account holds minus what it owes, at today's prices.</p>
      <dl className="compare">
        <div><dt>Profit and loss</dt><dd className={`num ${!s.current ? "" : m.profit < 0n ? "neg" : m.profit > 0n ? "pos" : ""}`}>{s.current ? signedUsd(m.profit, true) : "–"}</dd></div>
        <div><dt>Borrowed</dt><dd className="num">{usd(s.e.debt)}{aprBps !== null && <small> · {(aprBps / 100).toFixed(2)}% APR</small>}</dd></div>
        <div><dt>Available to borrow</dt><dd className="num hi">{usdUnits(s.buyingPower)}</dd></div>
        <div><dt>Withdrawable now</dt><dd className="num">{usdUnits(m.withdrawable)}</dd></div>
      </dl>
    </section>
  );
}

type FundsTab = "borrow" | "repay" | "add" | "withdraw";

function Funds() {
  const a = useAccount();
  const s = a.snap!;
  const m = money(s);
  const [tab, setTab] = useState<FundsTab>("borrow");
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState<"account" | "wallet">("account");
  const walletUsdg = a.balances?.usdg ?? 0n;
  const linked = ATT_STATUSES[s.collateral.status] !== "NONE";

  let value = 0n;
  try {
    value = amount ? parseUnits(amount, 6) : 0n;
  } catch {
    value = 0n;
  }

  const max: Record<FundsTab, bigint> = {
    borrow: s.buyingPower,
    repay: source === "account" ? (s.idle < m.debtUnits ? s.idle : m.debtUnits) : walletUsdg < m.debtUnits + 1_000_000n ? walletUsdg : m.debtUnits + 1_000_000n,
    add: walletUsdg,
    // Interest accrues every second, so leave a dollar of headroom while there is debt.
    withdraw: s.e.debt > 0n ? (m.withdrawable > 1_000_000n ? m.withdrawable - 1_000_000n : 0n) : m.withdrawable,
  };
  const over = value > max[tab];
  const fmt = (u: bigint) => String(Number(u / 10_000n) / 100); // whole cents, rounded down so Max never overshoots

  const submit = async () => {
    const w = a.wallet, f = a.facility!;
    const ok =
      tab === "borrow"
        ? await a.run("Borrow", act.borrow(w, f, value), `Borrowed ${usdUnits(value)} USDG`)
        : tab === "repay"
          ? await a.run(
              "Repay",
              source === "account" ? act.repayFromAccount(w, f, value) : act.repayFromWallet(w, f, value),
              `Repaid ${usdUnits(value < m.debtUnits ? value : m.debtUnits)} USDG`,
            )
          : tab === "add"
            ? await a.run("Add funds", act.addFunds(w, f, value), `Added ${usdUnits(value)} USDG`)
            : await a.run("Withdraw", act.withdraw(w, f, value), `Sent ${usdUnits(value)} USDG to your wallet`);
    if (ok) setAmount("");
  };

  const hint: Record<FundsTab, string> = {
    borrow: linked
      ? "Borrowed USDG stays in your account for your agent to trade. It can't be withdrawn."
      : "Connect your brokerage first: your holdings set your credit limit.",
    repay:
      source === "account"
        ? `Uses USDG sitting in your account. You owe ${usdUnits(m.debtUnits)}.`
        : `Pays from your wallet (${usdUnits(walletUsdg)} USDG). Repaying is always allowed, whatever the account state.`,
    add: `Moves USDG from your wallet into the account. Wallet balance ${usdUnits(walletUsdg)}.`,
    withdraw: m.canWithdraw
      ? "You can withdraw what the account holds above its debt: your profits and anything you added."
      : "Withdrawals open once the account is active and your brokerage attestation is current.",
  };
  const labels: Record<FundsTab, string> = { borrow: "Borrow", repay: "Repay", add: "Add funds", withdraw: "Withdraw" };

  return (
    <section className="card c4" id="funds" aria-labelledby="fundsTitle">
      <div className="head"><span className="label" id="fundsTitle">Move money</span></div>
      <div className="seg" role="tablist" aria-label="Action">
        {(Object.keys(labels) as FundsTab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setAmount(""); }}>{labels[t]}</button>
        ))}
      </div>
      {tab === "repay" && s.current && (
        <div className="seg small" role="radiogroup" aria-label="Pay from">
          <button role="radio" aria-checked={source === "account"} onClick={() => setSource("account")}>From account cash</button>
          <button role="radio" aria-checked={source === "wallet"} onClick={() => setSource("wallet")}>From my wallet</button>
        </div>
      )}
      <label className="field">
        <span>Amount (USDG)</span>
        <div className="withmax">
          <input inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
          <button className="small" disabled={max[tab] === 0n} onClick={() => setAmount(fmt(max[tab]))}>Max</button>
        </div>
      </label>
      <p className={`note ${over ? "negtext" : ""}`}>{over ? `More than the ${usdUnits(max[tab])} available.` : hint[tab]}</p>
      <button className="primary" disabled={a.busy || value === 0n || over || (tab === "borrow" && !linked)} onClick={submit}>
        {labels[tab]}{value > 0n ? ` ${usdUnits(value)}` : ""}
      </button>
    </section>
  );
}

// ==================================================================== risk

function RiskMeters({ snap, params }: { snap: Snapshot; params: RiskParams }) {
  const u = snap.e.debt === 0n ? 0 : Math.min(pctNum(snap.e.U), 130);
  const h = snap.e.debt === 0n ? null : Math.min(pctNum(snap.e.H), 130);
  const p = (b: number) => b / 100;
  const uTone: Tone =
    snap.e.U >= bps(params.uCallBps) ? "crit" : snap.e.U >= bps(params.uWarnBps) ? "warn" : snap.e.U > bps(params.maxBorrowUtilBps) ? "warn" : "ok";
  const hTone: Tone = h === null ? "muted" : snap.e.H < bps(params.hCallBps) ? "crit" : snap.e.H < bps(params.hWarnBps) ? "warn" : "ok";
  return (
    <>
      <Meter
        label="Credit used"
        value={u}
        min={0}
        max={110}
        ticks={[p(params.maxBorrowUtilBps), p(params.uWarnBps), p(params.uCallBps), p(params.uDelevBps)]}
        tone={uTone}
        note={`Worst-case loss ${usd(snap.e.exposure)} of your ${usd(snap.e.creditLimit)} limit. Above ${p(params.maxBorrowUtilBps)}% no new risk is allowed; at ${p(params.uDelevBps)}% positions are sold.`}
      />
      <Meter
        label="Position health"
        value={h}
        min={75}
        max={105}
        ticks={[p(params.hDelevBps), p(params.hCallBps), p(params.hWarnBps), 100]}
        tone={hTone}
        invert
        note={h === null ? "No debt, nothing at risk." : `Your account covers ${pct(snap.e.H)} of its debt. Margin call below ${p(params.hCallBps)}%; below ${p(params.hDelevBps)}% positions are sold.`}
      />
    </>
  );
}

// ==================================================================== positions

function Positions() {
  const a = useAccount();
  const s = a.snap!;
  const m = money(s);
  const [selling, setSelling] = useState<(typeof s.stocks)[number] | null>(null);
  const [closing, setClosing] = useState(false);
  const held = s.stocks.filter((x) => x.balance > 0n);
  const total = held.reduce((acc, x) => acc + (x.balance * x.mark) / WAD, 0n) + s.idle * SCALE;
  const canTrade = !["DEFAULT", "CLOSED"].includes(m.state);
  const empty = held.length === 0 && s.idle === 0n && s.e.debt === 0n;
  return (
    <section className="card c4" aria-labelledby="pos">
      <div className="head"><span className="label" id="pos">Holdings</span><span className="label">inside your account</span></div>
      <div className="tbl">
        <table>
          <thead><tr><th>Asset</th><th>Shares</th><th>Value</th><th></th></tr></thead>
          <tbody>
            {held.map((x) => {
              const move = Number(x.live) / Number(x.reference) - 1;
              return (
                <tr key={x.symbol}>
                  <td>{x.symbol} <span className={move < 0 ? "neg" : "pos"}>{(move * 100).toFixed(1)}%</span></td>
                  <td>{shares(x.balance)}</td>
                  <td>{usd((x.balance * x.mark) / WAD)}</td>
                  <td><button className="small" disabled={a.busy || !canTrade} onClick={() => setSelling(x)}>Sell</button></td>
                </tr>
              );
            })}
            <tr><td>USDG cash</td><td>–</td><td>{usdUnits(s.idle)}</td><td></td></tr>
          </tbody>
          <tfoot><tr><td>Total</td><td></td><td>{usd(total)}</td><td></td></tr></tfoot>
        </table>
      </div>
      <p className="note">Percent is the move since the last market close. While the market is closed, holdings are valued at the lower of the close and the live price.</p>
      {!empty && s.current && (
        <button className="danger" disabled={a.busy || !canTrade} onClick={() => setClosing(true)}>Close out account</button>
      )}
      {selling && <SellDialog stock={selling} onClose={() => setSelling(null)} />}
      {closing && <CashOutDialog onClose={() => setClosing(false)} />}
    </section>
  );
}

function SellDialog({ stock, onClose }: { stock: Snapshot["stocks"][number]; onClose: () => void }) {
  const a = useAccount();
  const [part, setPart] = useState(100);
  const amount = (stock.balance * BigInt(part)) / 100n;
  const proceeds = (amount * stock.live) / WAD;
  return (
    <Modal title={`Sell ${stock.symbol}`} onClose={onClose}>
      <div className="seg" role="radiogroup" aria-label="How much">
        {[25, 50, 100].map((p) => (
          <button key={p} role="radio" aria-checked={part === p} onClick={() => setPart(p)}>{p === 100 ? "All" : `${p}%`}</button>
        ))}
      </div>
      <dl className="kv">
        <dt>Shares</dt><dd>{shares(amount)} {stock.symbol}</dd>
        <dt>Live price</dt><dd>{price(stock.live)}</dd>
        <dt>About</dt><dd>{usd(proceeds)} USDG</dd>
      </dl>
      <p className="note">Proceeds stay in your account as USDG. Use them to repay, or withdraw what's above your debt.</p>
      <button className="primary" disabled={a.busy || amount === 0n} onClick={async () => {
        if (await a.run(`Sell ${stock.symbol}`, act.sell(a.wallet, a.facility!, stock.token, amount), `Sold ${stock.symbol}`)) onClose();
      }}>Sell {part === 100 ? "all" : `${part}%`}</button>
    </Modal>
  );
}

function CashOutDialog({ onClose }: { onClose: () => void }) {
  const a = useAccount();
  const s = a.snap!;
  const m = money(s);
  const spread = 0.001; // venue spread, 10 bps
  const sale = Number(m.holdingsLive) / 1e18 * (1 - spread);
  const est = sale + Number(s.idle) / 1e6 - Number(s.e.debt) / 1e18;
  const short = est < 0;
  return (
    <Modal title="Close out account" onClose={onClose}>
      <p className="note">In one transaction Hapax will:</p>
      <ol className="plain">
        <li>Sell every position at the live market price (about {usd(BigInt(Math.round(sale)) * WAD)})</li>
        <li>Repay your {usd(s.e.debt)} of debt</li>
        <li>Stop your agent</li>
        <li>Send what's left to your wallet</li>
      </ol>
      {short ? (
        <p className="negtext">
          The sale won't cover your debt by about {usd(BigInt(Math.ceil(-est)) * WAD)}. Repay that from your wallet first, then close out.
        </p>
      ) : (
        <div className="big num">≈ {usd(BigInt(Math.floor(est)) * WAD)}<small> to your wallet</small></div>
      )}
      <p className="note">Your credit account stays open and linked; you can borrow and hire an agent again later.</p>
      <button className="danger" disabled={a.busy || short} onClick={async () => {
        if (await a.run("Close out account", act.cashOut(a.wallet, a.facility!), "Account closed out. Funds sent to your wallet.")) onClose();
      }}>Close out</button>
    </Modal>
  );
}

// ==================================================================== chart

function Chart() {
  const a = useAccount();
  const s = a.snap!;
  const sel = s.stocks.find((x) => x.symbol === a.symbol);
  const now = Number(s.block.timestamp);
  const levels: Level[] = useMemo(() => {
    const params = a.params;
    if (!params || !sel || sel.balance === 0n || s.e.debt === 0n) return [];
    // Price of the selected stock at which position health crosses each threshold, other holdings fixed.
    const debt = Number(s.e.debt) / 1e18;
    const held = Number(sel.balance) / 1e18;
    const other = Number(s.e.assets) / 1e18 - held * (Number(sel.mark) / 1e18);
    const at = (hBps: number) => ((hBps / 1e4) * debt - other) / held;
    const live = Number(sel.live) / 1e18;
    return ([
      { name: "Warning", price: at(params.hWarnBps), tone: "warn" },
      { name: "Margin call", price: at(params.hCallBps), tone: "crit" },
      { name: "Auto-sell", price: at(params.hDelevBps), tone: "crit" },
    ] as Level[]).filter((l) => l.price < live);
  }, [s, a.params, sel]);
  return (
    <section className="card c8" aria-labelledby="chartTitle">
      <div className="head">
        <h2 id="chartTitle">{a.symbol}: live market and last close</h2>
        <div className="tabs" role="group" aria-label="Stock">
          {SYMBOLS.map((x) => (
            <button key={x} aria-pressed={x === a.symbol} onClick={() => a.setSymbol(x)}>{x}</button>
          ))}
        </div>
      </div>
      <PriceChart points={a.prices} heartbeat={sel?.refHeartbeat ?? 300} now={now} levels={levels} />
      <div className="legend">
        <span><i style={{ background: "var(--accent)" }} />Live market (24/7)</span>
        <span><i style={{ background: "var(--muted)" }} />Exchange price (market hours)</span>
        <span><i style={{ background: "color-mix(in srgb, var(--frozen) 30%, transparent)", height: 10 }} />Stock market closed</span>
        {levels.length > 0 && <span>Dashed lines: where your account crosses each risk level</span>}
      </div>
    </section>
  );
}
