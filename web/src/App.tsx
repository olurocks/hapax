import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { addressUrl, chain, deployment, facilitiesFor } from "./lib/chain";
import { AccountProvider, useAccountData, type Account } from "./lib/account";
import { TxPanel, useTx } from "./lib/tx";
import { useDiscoveredWallets, useWallet, type Wallet } from "./lib/wallet";
import { openFacility } from "./lib/actions";
import { short, usdUnits } from "./lib/format";
import { WalletPicker } from "./components/WalletPicker";
import { Overview } from "./views/Overview";
import { AgentView } from "./views/Agent";
import { CollateralView } from "./views/Collateral";
import { ActivityView } from "./views/ActivityView";

type Tab = "overview" | "agent" | "collateral" | "activity";
const TABS: Array<[Tab, string]> = [
  ["overview", "Overview"],
  ["agent", "Agent"],
  ["collateral", "Collateral"],
  ["activity", "Activity"],
];
export type Notice = { kind: "ok" | "err"; text: string } | null;

export default function App() {
  if (!deployment) {
    return (
      <div className="center">
        <div className="card narrow">
          <Brand />
          <h2>Hapax isn't available on {chain.name} yet</h2>
          <p className="note">Check back soon, or switch to a network where Hapax is live.</p>
        </div>
      </div>
    );
  }
  return <Root />;
}

/** Result of returning from the broker's sign-in and consent pages. */
function useBrokerReturn() {
  const [ret] = useState(() => {
    const q = new URLSearchParams(location.search);
    const result = q.get("brokerage");
    if (!result) return null;
    let saved: { state: string; facility: Address } | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem("hapax.oauth") ?? "null");
      sessionStorage.removeItem("hapax.oauth");
    } catch {
      /* storage unavailable */
    }
    history.replaceState(null, "", location.pathname);
    if (!saved || saved.state !== q.get("state")) return { facility: null, notice: { kind: "err", text: "That brokerage sign-in expired. Try connecting again." } as Notice };
    const notice: Notice =
      result === "connected"
        ? { kind: "ok", text: "Brokerage connected. Your holdings now back your credit line." }
        : result === "denied"
          ? { kind: "err", text: "You cancelled the brokerage connection." }
          : { kind: "err", text: "The broker couldn't verify your holdings. Try again." };
    return { facility: saved.facility, notice };
  });
  return ret;
}

function Root() {
  const discovered = useDiscoveredWallets();
  const { wallet, restoring, connect, disconnect, switchNetwork } = useWallet(discovered);
  const [picker, setPicker] = useState(false);
  const brokerReturn = useBrokerReturn();
  const [notice, setNotice] = useState<Notice>(brokerReturn?.notice ?? null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.kind === "err" ? 9000 : 6000);
    return () => clearTimeout(t);
  }, [notice]);

  let body;
  if (restoring) body = <div className="center"><span className="spin big" aria-label="Loading" /></div>;
  else if (!wallet) body = <Landing onConnect={() => setPicker(true)} />;
  else if (wallet.chainId !== chain.id)
    body = (
      <>
        <Header wallet={wallet} onDisconnect={disconnect} />
        <div className="center">
          <div className="card narrow">
            <h2>Switch to {chain.name}</h2>
            <p className="note">Hapax runs on {chain.name}. Your wallet is on another network.</p>
            <div className="actions">
              <button className="primary" onClick={() => switchNetwork().catch(() => setNotice({ kind: "err", text: "Your wallet didn't switch networks." }))}>
                Switch network
              </button>
            </div>
          </div>
        </div>
      </>
    );
  else body = <SignedIn key={wallet.address} wallet={wallet} onDisconnect={disconnect} preferred={brokerReturn?.facility ?? null} setNotice={setNotice} />;

  return (
    <>
      {body}
      {picker && <WalletPicker wallets={discovered} onPick={connect} onClose={() => setPicker(false)} />}
      {notice && (
        <div className={`notice ${notice.kind}`} role="status">
          <span>{notice.text}</span>
          <button className="ghost" aria-label="Dismiss" onClick={() => setNotice(null)}>✕</button>
        </div>
      )}
    </>
  );
}

// ==================================================================== signed out

function Brand() {
  return (
    <div className="brand">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 4v16M20 4v16M4 12h16" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="12" r="2.4" fill="var(--accent)" />
      </svg>
      <b>hapax</b>
    </div>
  );
}

function Landing({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="wrap">
      <header className="strip">
        <Brand />
        <button className="primary" onClick={onConnect}>Connect wallet</button>
      </header>
      <section className="hero">
        <h1>Give your AI agent buying power, not your keys.</h1>
        <p>
          Your brokerage stocks back a USDG credit line on {chain.name}. An AI agent trades it around the clock,
          inside limits the contract enforces. Your shares never move.
        </p>
        <div className="actions">
          <button className="primary lg" onClick={onConnect}>Connect wallet</button>
        </div>
      </section>
      <section className="how" aria-label="How it works">
        {[
          ["Open a credit account", "A smart account on-chain that only you control. Borrowed USDG stays inside it."],
          ["Connect your brokerage", "Your broker signs what you hold. That sets your credit limit; nothing is sold or moved."],
          ["Borrow and hire an agent", "Pick an agent, choose which stocks it may buy and how much. It can trade, never withdraw."],
          ["Take profits any time", "Withdraw gains to your wallet, repay from anywhere, or close out in one step."],
        ].map(([t, d], i) => (
          <div key={t} className="card">
            <span className="label">Step {i + 1}</span>
            <h2>{t}</h2>
            <p className="note">{d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

// ==================================================================== signed in

function SignedIn({
  wallet,
  onDisconnect,
  preferred,
  setNotice,
}: {
  wallet: Wallet;
  onDisconnect: () => void;
  preferred: Address | null;
  setNotice: (n: Notice) => void;
}) {
  const data = useAccountData(wallet, preferred);
  const { progress, busy, run, dismiss } = useTx(data.refresh);
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem("hapax.tab") as Tab) || "overview";
    } catch {
      return "overview";
    }
  });
  const go = useCallback((t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem("hapax.tab", t);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const account: Account = { ...data, wallet, run, busy };
  const noGas = data.balances && data.balances.eth === 0n;

  const open = async () => {
    const before = data.facilities.length;
    if (await run("Open a credit account", openFacility(wallet), "Credit account opened")) {
      const mine = await facilitiesFor(wallet.address);
      if (mine.length > before) data.selectFacility(mine[mine.length - 1]);
    }
  };

  return (
    <AccountProvider value={account}>
      <div className="wrap">
        <Header wallet={wallet} onDisconnect={onDisconnect} account={account} onOpen={open} />
        {noGas && (
          <div className="banner warn">
            Your wallet has no ETH on {chain.name}. You need a little for transaction fees.{" "}
            <CopyAddress address={wallet.address} />
          </div>
        )}
        {data.snap && !data.snap.current && (
          <div className="banner warn">
            This account was opened on an older version of Hapax. Repaying from your wallet, closing out in one step and
            profit tracking aren't available on it.
          </div>
        )}
        {!data.facilitiesLoaded ? (
          data.loadError ? (
            <section className="card narrow">
              <h2>We couldn't reach {chain.name}</h2>
              <p className="note">{data.loadError}</p>
              <div className="actions"><button onClick={data.refresh}>Try again</button></div>
            </section>
          ) : (
            <div className="center"><span className="spin big" aria-label="Loading" /></div>
          )
        ) : !data.facility ? (
          <section className="card narrow welcome">
            <span className="label">Welcome</span>
            <h2>Open your credit account</h2>
            <p className="note">
              Your credit account is a smart account on {chain.name} that only your wallet controls. Borrowed USDG and
              everything your agent buys stay inside it. Opening one is free apart from network fees.
            </p>
            <div className="actions">
              <button className="primary lg" disabled={busy} onClick={open}>Open credit account</button>
            </div>
          </section>
        ) : (
          <>
            <nav className="nav" aria-label="Sections">
              {TABS.map(([id, label]) => (
                <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => go(id)}>
                  {label}
                </button>
              ))}
            </nav>
            {!data.snap ? (
              data.loadError ? (
                <section className="card narrow">
                  <h2>We couldn't load this account</h2>
                  <p className="note">{data.loadError}</p>
                  <div className="actions"><button onClick={data.refresh}>Try again</button></div>
                </section>
              ) : (
                <div className="center"><span className="spin big" aria-label="Loading" /></div>
              )
            ) : tab === "overview" ? (
              <Overview go={go} />
            ) : tab === "agent" ? (
              <AgentView go={go} />
            ) : tab === "collateral" ? (
              <CollateralView setNotice={setNotice} />
            ) : (
              <ActivityView />
            )}
          </>
        )}
      </div>
      <TxPanel progress={progress} onClose={dismiss} />
    </AccountProvider>
  );
}

function Header({
  wallet,
  onDisconnect,
  account,
  onOpen,
}: {
  wallet: Wallet;
  onDisconnect: () => void;
  account?: Account;
  onOpen?: () => void;
}) {
  return (
    <header className="strip">
      <Brand />
      <div className="who">
        {account && account.facilities.length > 0 && (
          <select
            aria-label="Credit account"
            className="facilitypick"
            value={account.facility ?? ""}
            onChange={(e) => (e.target.value === "new" ? onOpen?.() : account.selectFacility(e.target.value as Address))}
          >
            {account.facilities.map((f, i) => (
              <option key={f} value={f}>Account {i + 1} · {short(f)}</option>
            ))}
            <option value="new">+ Open another account</option>
          </select>
        )}
        <span className="badge">{chain.name}</span>
        <WalletMenu wallet={wallet} account={account} onDisconnect={onDisconnect} />
      </div>
    </header>
  );
}

function WalletMenu({ wallet, account, onDisconnect }: { wallet: Wallet; account?: Account; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const b = account?.balances;
  const link = addressUrl(wallet.address);
  return (
    <div className="menu" ref={ref}>
      <button aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((x) => !x)}>
        {wallet.info.icon && <img src={wallet.info.icon} alt="" width={16} height={16} />}
        {short(wallet.address)}
      </button>
      {open && (
        <div className="dropdown card" role="menu">
          <div className="kvs">
            <span className="label">Wallet</span>
            <code>{wallet.address}</code>
          </div>
          {b && (
            <dl className="kv">
              <dt>ETH (fees)</dt><dd>{(Number(b.eth) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 })}</dd>
              <dt>USDG</dt><dd>{usdUnits(b.usdg)}</dd>
            </dl>
          )}
          <div className="actions">
            <CopyAddress address={wallet.address} />
            {link && <a className="button" href={link} target="_blank" rel="noreferrer">Explorer</a>}
            <button className="danger" onClick={onDisconnect}>Disconnect</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="small"
      onClick={() =>
        navigator.clipboard.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "Copied" : "Copy address"}
    </button>
  );
}
