import { ATT_STATUSES, STATES, SYMBOLS, type Deployment } from "./types.ts";

/** Errors whose bigint arguments are USD amounts in 1e18. */
const USD_ARGS = new Set(["PositionTooLarge", "ExceedsCredit", "NotSurplus"]);

/** Readable revert reason: enum numbers become state names, token addresses become symbols. */
export function formatRevert(name: string, args: readonly unknown[], d?: Deployment | null): string {
  const pretty = args.map((a) => {
    if (name === "StateNotAllowed" || name === "CannotDeleverage") return STATES[Number(a)] ?? String(a);
    if (name === "AttestationNotValid") return ATT_STATUSES[Number(a)] ?? String(a);
    if (typeof a === "string" && a.startsWith("0x") && a.length === 42 && d) {
      const sym = SYMBOLS.find((s) => d.stocks[s].token.toLowerCase() === a.toLowerCase());
      if (sym) return sym;
      if (a.toLowerCase() === d.usdg.toLowerCase()) return "USDG";
      return `${a.slice(0, 6)}…${a.slice(-4)}`;
    }
    if (typeof a === "bigint" && USD_ARGS.has(name)) return `$${Math.round(Number(a) / 1e18).toLocaleString("en-US")}`;
    return String(a);
  });
  return pretty.length ? `${name}(${pretty.join(", ")})` : name;
}
