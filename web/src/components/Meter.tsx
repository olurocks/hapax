export type Tone = "ok" | "warn" | "crit" | "frozen" | "muted" | "accent";

interface Props {
  label: string;
  value: number | null; // percent; null renders as "–"
  min: number;
  max: number;
  ticks: number[];
  tone: Tone;
  invert?: boolean; // fill from the right (lower is worse)
  note: string;
}

export function Meter({ label, value, min, max, ticks, tone, invert, note }: Props) {
  const pos = (x: number) => Math.min(100, Math.max(0, ((x - min) / (max - min)) * 100));
  const v = value ?? (invert ? max : min);
  const left = invert ? pos(v) : 0;
  const width = invert ? 100 - pos(v) : pos(v);
  return (
    <div className="meter">
      <div className="top">
        <span className="label">{label}</span>
        <span className="val num" style={{ color: `var(--${tone})` }}>
          {value === null ? "–" : `${value.toFixed(1)}%`}
        </span>
      </div>
      <div className="track">
        {value !== null && (
          <div className="fill" style={{ left: `${left}%`, width: `${width}%`, background: `var(--${tone})` }} />
        )}
        {ticks.map((t) => (
          <span key={t} className="tick" style={{ left: `${pos(t)}%` }} />
        ))}
      </div>
      <div className="ticklabels">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${pos(t)}%` }}>
            {t}
          </span>
        ))}
      </div>
      <p>{note}</p>
    </div>
  );
}
