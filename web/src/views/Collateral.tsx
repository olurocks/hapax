import { ATT_STATUSES } from "@hapax/shared";
import { useAccount } from "../lib/account";
import * as act from "../lib/actions";
import { broker } from "../lib/services";
import { ago, price, shares, until, usd } from "../lib/format";
import type { Notice } from "../App";

const WAD = 10n ** 18n;

export function CollateralView({ setNotice }: { setNotice: (n: Notice) => void }) {
  const a = useAccount();
  const s = a.snap!;
  const status = ATT_STATUSES[s.collateral.status];
  const now = Number(s.block.timestamp);
  const linked = !!a.link?.linked;

  const connect = () => {
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    try {
      sessionStorage.setItem("hapax.oauth", JSON.stringify({ state, facility: a.facility }));
    } catch {
      setNotice({ kind: "err", text: "Your browser blocked session storage, which the brokerage sign-in needs." });
      return;
    }
    location.assign(broker.authorizeUrl(a.facility!, location.origin + location.pathname, state));
  };

  const rows = s.collateral.positions.map((p) => {
    const st = s.stocks.find((x) => x.symbol === p.symbol)!;
    const value = (p.shares * st.mark) / WAD;
    const hc = st.closed ? st.haircutClosedBps : st.haircutOpenBps;
    return { symbol: p.symbol!, shares: p.shares, mark: st.mark, value, counts: (value * BigInt(10000 - hc)) / 10000n };
  });
  const eligible = rows.reduce((x, r) => x + r.counts, 0n) + s.collateral.cashUsd - s.collateral.encumberedUsd;

  if (!linked && (status === "NONE" || a.link?.linked === false)) {
    return (
      <section className="card narrow" aria-labelledby="connTitle">
        <span className="label">Collateral</span>
        <h2 id="connTitle">Connect your brokerage account</h2>
        <p className="note">
          Sign in at {a.brokerName} and approve Hapax. Your broker then signs a statement of the shares you hold, and
          keeps it current. That statement sets your credit limit.
        </p>
        <ul className="plain">
          <li>Your shares stay in your brokerage account. Nothing is moved or sold.</li>
          <li>If your account ever defaults, your broker can sell pledged shares to repay it.</li>
          <li>You can disconnect once your balance is repaid.</li>
        </ul>
        {a.link === null && <div className="banner warn">The brokerage connection is unavailable right now. Try again in a moment.</div>}
        <div className="actions">
          <button className="primary lg" disabled={a.busy || a.link === null} onClick={connect}>Connect {a.brokerName}</button>
        </div>
      </section>
    );
  }

  const tone = status === "VALID" ? "ok" : "crit";
  const brokerStopped = linked && a.link?.attesting === false;
  return (
    <div className="row">
      <section className="card c7" aria-labelledby="collTitle">
        <div className="head">
          <h2 id="collTitle">{a.link?.accountName ?? "Brokerage account"}</h2>
          <span className={`pill tone-${tone}`}>
            {status === "VALID" ? "Verified" : status === "STALE" ? "Statement expired" : status === "REVOKED" ? "Revoked" : status.toLowerCase()}
          </span>
        </div>
        {a.link?.holder && <p className="note">{a.link.holder}</p>}
        {brokerStopped && (
          <div className="banner warn">
            Your broker has stopped vouching for this account. Borrowing and buying are paused; contact {a.brokerName}.
          </div>
        )}
        <div className="tbl">
          <table>
            <thead><tr><th>Holding</th><th>Price</th><th>Value</th><th>Counts toward credit</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol}>
                  <td>{shares(r.shares).replace(/\.00$/, "")} {r.symbol}</td>
                  <td>{price(r.mark)}</td>
                  <td>{usd(r.value)}</td>
                  <td>{usd(r.counts)}</td>
                </tr>
              ))}
              <tr><td>Cash</td><td>–</td><td>{usd(s.collateral.cashUsd)}</td><td>{usd(s.collateral.cashUsd)}</td></tr>
              {s.collateral.encumberedUsd > 0n && (
                <tr><td>Used elsewhere at the broker</td><td>–</td><td></td><td className="neg">−{usd(s.collateral.encumberedUsd)}</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr><td>Eligible</td><td></td><td></td><td>{usd(eligible > 0n ? eligible : 0n)}</td></tr>
              <tr><td>Credit limit</td><td></td><td></td><td>{usd(s.e.creditLimit)}</td></tr>
            </tfoot>
          </table>
        </div>
        <p className="note">
          {s.e.anyClosed
            ? "The stock market is closed: stocks count at 60% and are priced at the lower of the last close and the live market."
            : "The stock market is open: stocks count at 75% of their price."}
        </p>
      </section>

      <section className="card c5" aria-labelledby="attTitle">
        <span className="label" id="attTitle">Broker statement</span>
        <dl className="kv">
          <dt>Status</dt><dd>{status === "VALID" ? "Current" : status.toLowerCase()}</dd>
          <dt>Last signed</dt><dd>{a.link?.lastAttestedAt ? ago((Date.now() - Date.parse(a.link.lastAttestedAt)) / 1000) : "–"}</dd>
          <dt>Valid until</dt><dd>{status === "NONE" ? "–" : until(Number(s.collateral.expiresAt) - now)}</dd>
          <dt>Statement number</dt><dd>#{s.collateral.nonce.toString()}</dd>
        </dl>
        <p className="note">
          Your broker re-signs your holdings every few minutes. If it stops, or revokes, your account freezes in the same block:
          only selling and repaying are allowed until it's resolved.
        </p>
        {linked && (
          <button
            className="danger"
            disabled={a.busy || s.e.debt > 0n}
            title={s.e.debt > 0n ? "Repay your balance first" : undefined}
            onClick={() => a.run("Disconnect brokerage", act.disconnectBrokerage(a.wallet, a.facility!), "Brokerage disconnected")}
          >
            Disconnect brokerage
          </button>
        )}
        {linked && s.e.debt > 0n && <p className="note">You can disconnect once your balance is repaid.</p>}
      </section>
    </div>
  );
}
