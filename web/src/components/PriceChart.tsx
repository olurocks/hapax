import type { PricePoint } from "../lib/chain";
import { etClock, etTime } from "../lib/format";

export interface Level {
  name: string;
  price: number;
  tone: "warn" | "crit";
}

interface Props {
  points: PricePoint[];
  heartbeat: number; // seconds a reference print stays fresh
  now: number;
  levels: Level[];
}

const W = 760, H = 300, M = { l: 56, r: 156, t: 16, b: 34 };

/** Live (24/7) vs reference (24/5) prices for one stock, with market-closed periods shaded. */
export function PriceChart({ points, heartbeat, now, levels }: Props) {
  const live = points.filter((p) => p.feed === "live");
  if (live.length < 2) return <p className="empty">Waiting for price updates from the market operator…</p>;

  // Walk updates in order; a live print is "closed" when the latest reference is older than the heartbeat.
  let refAsOf = -Infinity;
  let refPrice: number | null = null;
  const refLine: Array<[number, number]> = [];
  const closed: Array<[number, number]> = [];
  let open: number | null = null;
  for (const p of points) {
    if (p.feed === "ref") {
      refAsOf = p.asOf;
      refPrice = p.price;
      continue;
    }
    if (refPrice !== null) refLine.push([p.time, refPrice]);
    const isClosed = p.time - refAsOf > heartbeat;
    if (isClosed && open === null) open = p.time;
    if (!isClosed && open !== null) {
      closed.push([open, p.time]);
      open = null;
    }
  }
  if (open !== null) closed.push([open, now]);

  const t0 = live[0].time, t1 = Math.max(now, live[live.length - 1].time);
  const prices = [...live.map((p) => p.price), ...refLine.map((r) => r[1])];
  const last = live[live.length - 1];
  const visible = levels.filter((l) => l.price > 0 && Math.abs(l.price / last.price - 1) < 0.35);
  let y0 = Math.min(...prices, ...visible.map((l) => l.price));
  let y1 = Math.max(...prices, ...visible.map((l) => l.price));
  const pad = Math.max((y1 - y0) * 0.12, last.price * 0.01);
  y0 -= pad;
  y1 += pad;

  const X = (t: number) => M.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - M.l - M.r);
  const Y = (p: number) => M.t + (1 - (p - y0) / (y1 - y0)) * (H - M.t - M.b);
  const path = (pts: Array<[number, number]>) =>
    pts.map(([t, p], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(p).toFixed(1)}`).join("");
  const livePts = live.map((p) => [p.time, p.price] as [number, number]);
  const area = `${path(livePts)}L${X(last.time).toFixed(1)},${Y(y0).toFixed(1)}L${X(t0).toFixed(1)},${Y(y0).toFixed(1)}Z`;

  const step = niceStep((y1 - y0) / 4);
  const yTicks: number[] = [];
  for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) yTicks.push(v);
  const xTicks = [t0, t0 + (t1 - t0) / 2, t1];
  const fmt = (p: number) => `$${p.toFixed(p < 100 ? 2 : 1)}`;

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Live price ${fmt(last.price)}`}>
      <defs>
        <linearGradient id="ga" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity=".22" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {closed.map(([a, b]) => (
        <rect key={a} x={X(a)} y={M.t} width={Math.max(1, X(b) - X(a))} height={H - M.t - M.b} fill="var(--frozen)" fillOpacity=".08" />
      ))}
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={M.l} x2={X(t1)} y1={Y(v)} y2={Y(v)} stroke="var(--line)" strokeWidth="1" />
          <text x={M.l - 10} y={Y(v) + 4} textAnchor="end" fontFamily="var(--mono)" fontSize="11" fill="var(--muted)">
            {fmt(v)}
          </text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <text key={i} x={X(t)} y={H - 10} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontFamily="var(--mono)" fontSize="11" fill="var(--muted)">
          {t1 - t0 < 3600 ? etClock(t) : etTime(t)}
        </text>
      ))}
      {visible.map((l) => (
        <g key={l.name}>
          <line x1={M.l} x2={X(t1)} y1={Y(l.price)} y2={Y(l.price)} stroke={`var(--${l.tone})`} strokeOpacity=".55" strokeDasharray="4 5" />
          <text x={X(t1) + 10} y={Y(l.price) + 4} fontFamily="var(--mono)" fontSize="11" fill={`var(--${l.tone})`}>
            {l.name} {fmt(l.price)}
          </text>
        </g>
      ))}
      {refLine.length > 1 && (
        <path d={path(refLine)} fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="2 4" />
      )}
      <path d={area} fill="url(#ga)" />
      <path d={path(livePts)} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      <line x1={X(last.time)} x2={X(last.time)} y1={Y(last.price)} y2={Y(y0)} stroke="var(--accent)" strokeOpacity=".5" strokeDasharray="2 3" />
      <circle className="glow" cx={X(last.time)} cy={Y(last.price)} r="9" fill="var(--accent)" fillOpacity=".25" />
      <circle cx={X(last.time)} cy={Y(last.price)} r="4" fill="var(--accent)" />
      <text x={X(last.time) - 14} y={Y(last.price) + 18} textAnchor="end" fontFamily="var(--mono)" fontSize="11" fill="var(--fg)">
        Live {fmt(last.price)}
      </text>
    </svg>
  );
}

function niceStep(raw: number) {
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}
