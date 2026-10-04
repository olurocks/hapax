import type { StateName } from "@hapax/shared";

const BIG = 10n ** 30n;
const n = (x: bigint, decimals = 18) => Number(x) / 10 ** decimals;

export const usd = (wad: bigint, digits = 0) =>
  "$" + n(wad).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Signed USD from 1e18; `plus` adds "+" to gains (for P&L). */
export const signedUsd = (wad: bigint, plus = false) =>
  (wad < 0n ? "−" : plus && wad > 0n ? "+" : "") + usd(wad < 0n ? -wad : wad);
export const usdUnits = (units: bigint, decimals = 6) =>
  "$" + n(units, decimals).toLocaleString("en-US", { maximumFractionDigits: 0 });
export const price = (wad: bigint) =>
  "$" + n(wad).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const shares = (wad: bigint) =>
  n(wad).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const pct = (wad: bigint) => (wad > BIG ? "∞" : `${(n(wad) * 100).toFixed(1)}%`);
export const pctNum = (wad: bigint) => (wad > BIG ? Infinity : n(wad) * 100);
export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "–");

const et = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export const etTime = (unix: number | bigint) => et.format(new Date(Number(unix) * 1000));
const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
export const etClock = (unix: number | bigint) => clock.format(new Date(Number(unix) * 1000));

const hm = (s: number) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
export function ago(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${hm(s)} ago`;
}
export function until(seconds: number) {
  const s = Math.floor(seconds);
  if (s <= 0) return "expired";
  if (s < 3600) return `in ${Math.max(1, Math.floor(s / 60))}m`;
  return `in ${hm(s)}`;
}

export const stateLabel: Record<StateName, string> = {
  ACTIVE: "Active",
  WARNING: "Warning",
  MARGIN_CALL: "Margin call",
  DELEVERAGING: "Deleveraging",
  FROZEN: "Frozen",
  CURE: "Cure period",
  DEFAULT: "Default",
  CLOSED: "Closed",
};

export const stateTone: Record<StateName, "ok" | "warn" | "crit" | "frozen" | "muted"> = {
  ACTIVE: "ok",
  WARNING: "warn",
  MARGIN_CALL: "crit",
  DELEVERAGING: "crit",
  FROZEN: "frozen",
  CURE: "warn",
  DEFAULT: "crit",
  CLOSED: "muted",
};
