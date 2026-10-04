import { useEffect, useState } from "react";
import { parseUnits, type Address } from "viem";
import { SYMBOLS, type AgentProfile, type StockSymbol } from "@hapax/shared";
import { useAccount } from "../lib/account";
import { addressUrl, deployment } from "../lib/chain";
import * as act from "../lib/actions";
import { agents } from "../lib/services";
import { etTime, short, until, usd } from "../lib/format";
import { Modal } from "../components/Modal";
import { Activity } from "../components/Activity";

type Go = (t: "overview" | "agent" | "collateral" | "activity") => void;

function useCatalog() {
  const [catalog, setCatalog] = useState<AgentProfile[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [intervalMs, setIntervalMs] = useState(0);
  const load = () => {
    setFailed(false);
    agents.catalog().then(
      (r) => {
        setCatalog(r.agents);
        setIntervalMs(r.intervalMs);
      },
      () => setFailed(true),
    );
  };
  useEffect(load, []);
  return { catalog, failed, intervalMs, retry: load };
}

export function AgentView({ go }: { go: Go }) {
  const a = useAccount();
  const s = a.snap!;
  const { catalog, failed, intervalMs, retry } = useCatalog();
  const [hiring, setHiring] = useState<AgentProfile | null>(null);
  const as = a.assignment;
  const onchainAgent = s.agent;
  const matches = !!as && !!onchainAgent && as.agent.toLowerCase() === onchainAgent.toLowerCase();
  const orphan = !!onchainAgent && s.mandate.active && !matches;
  const showManage = matches && (as!.status === "running" || as!.status === "expired");
  const noFunds = s.idle === 0n && s.stocks.every((x) => x.balance === 0n);

  return (
    <>
      {showManage ? (
        <ManageAgent catalog={catalog} intervalMs={intervalMs} />
      ) : orphan ? (
        <Orphan catalog={catalog} />
      ) : (
        <section className="card" aria-labelledby="hireTitle">
          <div className="head">
            <h2 id="hireTitle">Hire an agent</h2>
            <span className="label">it trades your account, never withdraws</span>
          </div>
          <p className="note">
            Pick an agent and give it a mandate: which stocks it may buy, how big each position can get, and for how long.
            The contract enforces the mandate on every trade. You can stop the agent at any time.
          </p>
          {noFunds && (
            <div className="banner">
              Your account has no USDG to trade yet. <button className="small" onClick={() => go("overview")}>Borrow first</button>
            </div>
          )}
          {failed ? (
            <div className="banner warn">
              Agents are unavailable right now. <button className="small" onClick={retry}>Try again</button>
            </div>
          ) : !catalog ? (
            <span className="spin" aria-label="Loading agents" />
          ) : (
            <div className="agents">
              {catalog.map((p) => (
                <article key={p.id} className={`agentcard ${p.available ? "" : "off"}`}>
                  <div className="head">
                    <h3>{p.name}</h3>
                    <span className="badge">{p.engine === "rules" ? "rules" : "Claude"}</span>
                  </div>
                  <p className="tagline">{p.tagline}</p>
                  <p className="note">{p.description}</p>
                  <button className="primary" disabled={!p.available || a.busy} onClick={() => setHiring(p)}>
                    {p.available ? `Hire ${p.name}` : (p.unavailableReason ?? "Unavailable")}
                  </button>
                </article>
              ))}
            </div>
          )}
          {as && as.status === "revoked" && (
            <p className="note">You stopped {as.agentName} on {etTime(Date.parse(as.hiredAt) / 1000)}. Its past decisions are below.</p>
          )}
        </section>
      )}

      {as && as.history.length > 0 && (
        <section className="card" aria-labelledby="decTitle">
          <div className="head">
            <h2 id="decTitle">{as.agentName}'s decisions</h2>
            <span className="label">{as.history.length} recent</span>
          </div>
          <Activity events={[]} decisions={as.history} agent={as.agent} deployment={deployment!} />
        </section>
      )}

      {hiring && <MandateDialog profile={hiring} onClose={() => setHiring(null)} />}
    </>
  );
}

// ==================================================================== running agent

function ManageAgent({ catalog, intervalMs }: { catalog: AgentProfile[] | null; intervalMs: number }) {
  const a = useAccount();
  const s = a.snap!;
  const as = a.assignment!;
  const now = Number(s.block.timestamp);
  const m = s.mandate;
  const [editing, setEditing] = useState(false);
  const [instr, setInstr] = useState<string | null>(null);
  const p = catalog?.find((x) => x.id === as.agentId);
  const link = addressUrl(as.agent);
  const expired = as.status === "expired";
  const statusText = expired
    ? "Mandate expired"
    : as.lastError
      ? `Running · last cycle: ${as.lastError}`
      : as.nextRunAt
        ? `Running · next decision ${until((Date.parse(as.nextRunAt) - Date.now()) / 1000).replace("expired", "now")}`
        : "Running";

  return (
    <section className="card" aria-labelledby="agentTitle">
      <div className="head">
        <h2 id="agentTitle">{as.agentName}</h2>
        <span className={`pill tone-${expired ? "warn" : "ok"}`}>{expired ? "Expired" : "Active"}</span>
      </div>
      <p className="note">
        {statusText}. Trades as{" "}
        {link ? <a href={link} target="_blank" rel="noreferrer"><code>{short(as.agent)}</code></a> : <code>{short(as.agent)}</code>}
        {p && <> · {p.engine === "rules" ? "rules strategy" : `Claude (${p.engine})`}</>}
        {intervalMs > 0 && <> · decides every {Math.round(intervalMs / 60000) || 1} min</>}
      </p>

      <div className="row inner">
        <div className="c6">
          <span className="label">Mandate, enforced onchain</span>
          <div className="chips" aria-label="Stocks the agent may buy">
            {SYMBOLS.map((x) => <span key={x} className={`chip ${m.symbols.includes(x) ? "yes" : "no"}`}>{x}</span>)}
          </div>
          <dl className="kv">
            <dt>Max per position</dt><dd className="num">{m.maxPositionUsd === 0n ? "account limit" : usd(m.maxPositionUsd)}</dd>
            <dt>Expires</dt><dd>{etTime(m.expiresAt)} ET · {until(Number(m.expiresAt) - now)}</dd>
          </dl>
          <div className="rights">
            <div className="can"><b>Can</b>Buy allowed stocks, sell anything, repay</div>
            <div className="cannot"><b>Cannot</b>Borrow, withdraw, change its mandate</div>
          </div>
        </div>
        <div className="c6">
          <span className="label">Instructions</span>
          {instr === null ? (
            <>
              <blockquote className="instr">{as.instructions}</blockquote>
              <button className="small" disabled={a.busy} onClick={() => setInstr(as.instructions)}>Edit instructions</button>
            </>
          ) : (
            <>
              <textarea value={instr} onChange={(e) => setInstr(e.target.value)} rows={4} aria-label="Instructions" />
              <div className="actions">
                <button className="primary small" disabled={a.busy || !instr.trim()} onClick={async () => {
                  if (await a.run("Update instructions", act.updateInstructions(a.wallet, a.facility!, instr.trim()), "Instructions updated")) setInstr(null);
                }}>Sign and save</button>
                <button className="small" onClick={() => setInstr(null)}>Cancel</button>
              </div>
              {p?.engine === "rules" && <p className="note">This agent follows fixed rules; your notes are kept but don't change them.</p>}
            </>
          )}
        </div>
      </div>

      <div className="actions">
        <button className={expired ? "primary" : ""} disabled={a.busy} onClick={() => setEditing(true)}>{expired ? "Renew mandate" : "Change limits"}</button>
        <button className="danger" disabled={a.busy} onClick={() => a.run("Stop agent", act.revokeAgent(a.wallet, a.facility!), "Agent stopped. It has no rights left.")}>
          Stop agent
        </button>
      </div>
      {editing && p && <MandateDialog profile={p} existing={as.agent} onClose={() => setEditing(false)} />}
    </section>
  );
}

/** Appointed onchain, but the agent service isn't running it (the last step of hiring didn't finish). */
function Orphan({ catalog }: { catalog: AgentProfile[] | null }) {
  const a = useAccount();
  const s = a.snap!;
  const [match, setMatch] = useState<AgentProfile | null | undefined>(undefined);
  useEffect(() => {
    if (!catalog) return;
    let alive = true;
    Promise.all(catalog.map(async (p) => ((await agents.addressFor(p.id, a.facility!)).toLowerCase() === s.agent!.toLowerCase() ? p : null)))
      .then((r) => alive && setMatch(r.find(Boolean) ?? null), () => alive && setMatch(null));
    return () => {
      alive = false;
    };
  }, [catalog, a.facility, s.agent]);
  return (
    <section className="card">
      <div className="head"><h2>Your agent isn't running</h2><span className="pill tone-warn">Paused</span></div>
      <p className="note">
        {short(s.agent)} is appointed on your account, but {match ? `${match.name} hasn't` : "no Hapax agent has"} been started for it.
        {match ? " Sign its instructions to start it." : " Stop it, then hire an agent."}
      </p>
      <div className="actions">
        {match && (
          <button className="primary" disabled={a.busy} onClick={() =>
            a.run("Start agent", act.resumeAgent(a.wallet, a.facility!, match.id, s.agent as Address, match.defaultInstructions), `${match.name} started`)}>
            Start {match.name}
          </button>
        )}
        <button className="danger" disabled={a.busy} onClick={() => a.run("Stop agent", act.revokeAgent(a.wallet, a.facility!), "Agent stopped")}>Stop agent</button>
      </div>
    </section>
  );
}

// ==================================================================== mandate form

const DURATIONS: Array<[string, number]> = [["24 hours", 24], ["3 days", 72], ["7 days", 168], ["30 days", 720]];

function MandateDialog({ profile, existing, onClose }: { profile: AgentProfile; existing?: Address; onClose: () => void }) {
  const a = useAccount();
  const s = a.snap!;
  const d = deployment!;
  const renewing = !!existing;
  const [picked, setPicked] = useState<StockSymbol[]>(renewing ? s.mandate.symbols : profile.suggested.symbols);
  const [cap, setCap] = useState(String(renewing && s.mandate.maxPositionUsd > 0n ? Number(s.mandate.maxPositionUsd / 10n ** 18n) : profile.suggested.maxPositionUsd));
  const [hours, setHours] = useState(profile.suggested.hours);
  const [instructions, setInstructions] = useState(profile.defaultInstructions);

  const submit = async () => {
    const m: act.MandateInput = {
      tokens: picked.map((x) => d.stocks[x].token),
      maxPositionUsd: parseUnits(cap || "0", 18),
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + hours * 3600),
    };
    const ok = renewing
      ? await a.run("Update mandate", act.updateMandate(a.wallet, a.facility!, existing!, m), "Mandate updated")
      : await a.run(`Hire ${profile.name}`, act.hireAgent(a.wallet, a.facility!, profile.id, m, instructions.trim()), `${profile.name} is trading your account`);
    if (ok) onClose();
  };

  return (
    <Modal title={renewing ? `${profile.name}: mandate` : `Hire ${profile.name}`} onClose={onClose}>
      <div className="field">
        <span>May buy</span>
        <div className="checks">
          {SYMBOLS.map((x) => (
            <label key={x}>
              <input type="checkbox" checked={picked.includes(x)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, x] : p.filter((y) => y !== x)))} />
              {x}
            </label>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Max per position (USD)</span>
        <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ""))} />
      </label>
      <div className="field">
        <span>Mandate lasts</span>
        <div className="seg" role="radiogroup" aria-label="Duration">
          {DURATIONS.map(([l, h]) => (
            <button key={h} role="radio" aria-checked={hours === h} onClick={() => setHours(h)}>{l}</button>
          ))}
        </div>
      </div>
      {!renewing && (
        <label className="field">
          <span>Instructions</span>
          <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </label>
      )}
      <p className="note">
        {renewing
          ? "One transaction updates the mandate. The agent keeps running."
          : "You'll confirm one transaction to appoint the agent onchain, then sign its instructions. Signing moves no funds."}
      </p>
      <button className="primary" disabled={a.busy || !picked.length || !Number(cap)} onClick={submit}>
        {renewing ? "Update mandate" : `Appoint ${profile.name}`}
      </button>
    </Modal>
  );
}
