import type { ReactNode } from "react";
import { STATES, SYMBOLS, type Deployment } from "@hapax/shared";
import type { ChainEvent } from "../lib/chain";
import type { AgentDecision } from "@hapax/shared";
import { etTime, pct, short, stateLabel, usd, usdUnits } from "../lib/format";

type Kind = "ref" | "fill" | "hold" | "risk" | "mkt" | "owner";
const KIND_LABEL: Record<Kind, string> = {
  ref: "Refused",
  fill: "Filled",
  hold: "Hold",
  risk: "Risk",
  mkt: "Broker",
  owner: "You",
};

interface Item {
  key: string;
  time: number;
  kind: Kind;
  text: ReactNode;
  code?: string;
  quote?: string;
}

interface Props {
  events: ChainEvent[];
  decisions: AgentDecision[];
  agent: string | null;
  deployment: Deployment;
}

export function Activity({ events, decisions, agent, deployment }: Props) {
  const symbolOf = (a: unknown) =>
    SYMBOLS.find((s) => deployment.stocks[s].token.toLowerCase() === String(a).toLowerCase()) ??
    (String(a).toLowerCase() === deployment.usdg.toLowerCase() ? "USDG" : short(String(a)));

  const items: Item[] = [];
  // Agent trades the agent service already reports (with its reasoning). Anything else onchain is shown from events,
  // so nothing disappears if the agent restarts and loses its history.
  const reported = new Set(decisions.flatMap((d) => d.trades.map((t) => t.tx?.toLowerCase()).filter(Boolean)));
  const byAgent = (a: unknown) => !!agent && String(a).toLowerCase() === agent.toLowerCase();

  for (const ev of events) {
    const a = ev.args as Record<string, any>;
    const base = { key: ev.key, time: ev.time };
    switch (ev.name) {
      case "StateChanged":
        items.push({
          ...base,
          kind: "risk",
          text:
            `${stateLabel[STATES[a.from]]} → ${stateLabel[STATES[a.to]]}. ` +
            (a.H > 10n ** 30n ? "No debt left." : `Position health ${pct(a.H)}, credit used ${pct(a.U)}.`),
        });
        break;
      case "Deleveraged":
        items.push({
          ...base,
          kind: "risk",
          text: `Sold every position for ${usdUnits(a.proceeds)} and repaid ${usdUnits(a.repaid)}. Remaining debt ${usdUnits(a.residual)}.`,
          code: `keeper ${short(a.caller)} · tip ${usdUnits(a.tip)}`,
        });
        break;
      case "CureStarted":
        items.push({ ...base, kind: "risk", text: `Cure period started. Repay ${usdUnits(a.residualDebt)} by ${etTime(a.deadline)}.` });
        break;
      case "Cured":
        items.push({ ...base, kind: "owner", text: "Remaining debt repaid. Your account is back to normal." });
        break;
      case "Defaulted":
        items.push({ ...base, kind: "risk", text: `Default. Debt outstanding ${usdUnits(a.debt / 10n ** 12n)}.` });
        break;
      case "ResolutionRequested":
        items.push({ ...base, kind: "mkt", text: `Broker asked to sell pledged shares to settle ${usdUnits(a.residualDebt / 10n ** 12n)}.` });
        break;
      case "SettlementConfirmed":
        items.push({
          ...base,
          kind: "mkt",
          text: `Broker settled ${usdUnits(a.amount)} from pledged shares. Account closed.`,
        });
        break;
      case "FreezeStarted":
        items.push({ ...base, kind: "risk", text: "Account frozen. Only selling and repaying are allowed." });
        break;
      case "AttestationRevoked":
        items.push({
          ...base,
          kind: "mkt",
          text: Number(a.reasonCode) === 2 ? "You disconnected your brokerage account." : "Your broker stopped vouching for your holdings. The account froze in the same block.",
        });
        break;
      case "CashedOut":
        if (a.proceeds === undefined) break; // the facility's own event; the risk engine's carries the breakdown
        items.push({
          ...base,
          kind: "owner",
          text: `Closed out: sold positions for ${usdUnits(a.proceeds)}, repaid ${usdUnits(a.repaid)}, sent ${usdUnits(a.paidOut)} to your wallet.`,
        });
        break;
      case "Deposited":
        items.push({ ...base, kind: "owner", text: `Added ${usdUnits(a.amount)} USDG from your wallet.` });
        break;
      case "Withdrawn":
        items.push({ ...base, kind: "owner", text: `Withdrew ${usdUnits(a.amount)} USDG to your wallet.` });
        break;
      case "Borrowed":
        items.push({ ...base, kind: "owner", text: `Borrowed ${usdUnits(a.amount)} USDG into your account.` });
        break;
      case "Repaid":
        if (String(a.by).toLowerCase() === deployment.risk.toLowerCase()) break; // shown as part of Deleveraged / CashedOut
        if (ev.tx && reported.has(ev.tx.toLowerCase())) break;
        items.push({
          ...base,
          kind: byAgent(a.by) ? "fill" : "owner",
          text: `${byAgent(a.by) ? "Agent repaid" : "Repaid"} ${usdUnits(a.amount)} USDG.`,
        });
        break;
      case "Traded": {
        if (ev.tx && reported.has(ev.tx.toLowerCase())) break;
        const buy = String(a.tokenIn).toLowerCase() === deployment.usdg.toLowerCase();
        const who = byAgent(a.by) ? "Agent" : "You";
        items.push({
          ...base,
          kind: "fill",
          text: buy
            ? `${who} bought ${symbolOf(a.tokenOut)} for ${usdUnits(a.amountIn)}.`
            : `${who} sold ${symbolOf(a.tokenIn)} for ${usdUnits(a.amountOut)}.`,
          code: ev.tx ? `tx ${short(ev.tx)}` : undefined,
        });
        break;
      }
      case "AgentSet":
        items.push({
          ...base,
          kind: "owner",
          text: `Agent ${short(a.agent)} appointed: may buy ${(a.tokens as string[]).map(symbolOf).join(", ") || "nothing"}, up to ${usd(a.maxPositionUsd)} per position, until ${etTime(a.expiresAt)} ET.`,
        });
        break;
      case "AgentRevoked":
        items.push({ ...base, kind: "owner", text: `Agent ${short(a.agent)} stopped. It has no rights left.` });
        break;
    }
  }

  for (const [i, d] of decisions.entries()) {
    const time = Math.floor(Date.parse(d.at) / 1000);
    const by = d.source === "claude" ? "Claude" : "The agent";
    if (d.trades.length === 0) {
      items.push({ key: `d${i}`, time, kind: "hold", text: `${by} decided not to trade.`, quote: d.reasoning });
      continue;
    }
    d.trades.forEach((t, j) => {
      const amount = `$${Math.round(t.usd).toLocaleString("en-US")}`;
      const done = t.action === "buy" ? "bought" : t.action === "sell" ? "sold" : "repaid";
      const what = t.action === "repay" ? `${amount} of debt` : `${amount} of ${t.symbol}`;
      items.push({
        key: `d${i}-${j}`,
        time,
        kind: t.status === "filled" ? "fill" : t.status === "refused" ? "ref" : "hold",
        text:
          t.status === "filled"
            ? `Agent ${done} ${what}.`
            : t.status === "refused"
              ? `Agent tried to ${t.action} ${what}.`
              : `Agent skipped: ${t.detail}.`,
        code: t.status === "refused" ? t.detail.replace(/^contract refused: /, "") : t.tx ? `tx ${short(t.tx)}` : undefined,
        quote: j === 0 && d.source !== "operator" ? d.reasoning : undefined,
      });
    });
  }

  items.sort((x, y) => y.time - x.time || y.key.localeCompare(x.key));
  if (!items.length) return <p className="empty">No activity yet.</p>;

  return (
    <ol className="feed">
      {items.slice(0, 60).map((it) => (
        <li key={it.key}>
          <time>{etTime(it.time)}</time>
          <span className={`kind k-${it.kind}`}>{KIND_LABEL[it.kind]}</span>
          <div className="what">
            <p>{it.text}</p>
            {it.code && <code>{it.code}</code>}
            {it.quote && <q>{it.quote}</q>}
          </div>
        </li>
      ))}
    </ol>
  );
}
