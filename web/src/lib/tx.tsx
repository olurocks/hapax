// Multi-step actions (approve → repay, appoint → sign → start) with one progress panel.
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { revertReason, txUrl, type TxStage } from "./chain";

export interface Step {
  label: string;
  /** "tx" waits on the wallet then the chain; "sign" waits on the wallet; "call" is a backend request. */
  kind: "tx" | "sign" | "call";
  run: (onStage: (stage: TxStage, hash?: Hex) => void) => Promise<unknown>;
  /** Skip this step when it returns true at the moment it would run (e.g. allowance already enough). */
  skip?: () => Promise<boolean> | boolean;
}

interface Progress {
  title: string;
  labels: string[];
  index: number;
  stage: "wallet" | "pending" | "working" | "done" | "error";
  hash?: Hex;
  error?: string;
  done?: string;
}

export function useTx(onSettled?: () => void) {
  const [p, setP] = useState<Progress | null>(null);
  const busy = !!p && p.stage !== "done" && p.stage !== "error";

  const run = useCallback(
    async (title: string, steps: Step[], done?: string): Promise<boolean> => {
      const labels = steps.map((s) => s.label);
      setP({ title, labels, index: 0, stage: "working" });
      try {
        for (const [index, step] of steps.entries()) {
          if (step.skip && (await step.skip())) continue;
          setP({ title, labels, index, stage: step.kind === "call" ? "working" : "wallet" });
          await step.run((stage, hash) => setP({ title, labels, index, stage, hash }));
        }
        setP({ title, labels, index: steps.length - 1, stage: "done", done });
        return true;
      } catch (err) {
        setP((cur) => ({ ...(cur ?? { title, labels, index: 0 }), stage: "error", error: revertReason(err) }));
        return false;
      } finally {
        onSettled?.();
      }
    },
    [onSettled],
  );

  useEffect(() => {
    if (p?.stage !== "done") return;
    const t = setTimeout(() => setP(null), 5000);
    return () => clearTimeout(t);
  }, [p]);

  return { progress: p, busy, run, dismiss: () => setP(null) };
}

export function TxPanel({ progress: p, onClose }: { progress: Progress | null; onClose: () => void }) {
  if (!p) return null;
  const many = p.labels.length > 1;
  const link = p.hash ? txUrl(p.hash) : null;
  const status =
    p.stage === "wallet"
      ? "Confirm in your wallet"
      : p.stage === "pending"
        ? "Waiting for confirmation"
        : p.stage === "working"
          ? "Working"
          : p.stage === "done"
            ? (p.done ?? "Done")
            : "Failed";
  return (
    <div className={`txpanel ${p.stage}`} role="status" aria-live="polite">
      <div className="txhead">
        <b>{p.title}</b>
        {(p.stage === "done" || p.stage === "error") && (
          <button className="ghost" aria-label="Dismiss" onClick={onClose}>✕</button>
        )}
      </div>
      {many && (
        <ol className="txsteps">
          {p.labels.map((l, i) => (
            <li key={l} className={i < p.index || p.stage === "done" ? "ok" : i === p.index ? "now" : ""}>{l}</li>
          ))}
        </ol>
      )}
      <div className="txstatus">
        {p.stage !== "done" && p.stage !== "error" && <span className="spin" aria-hidden="true" />}
        <span>{status}</span>
        {link && p.stage === "pending" && <a href={link} target="_blank" rel="noreferrer">View transaction</a>}
      </div>
      {p.error && <p className="txerr">{p.error}</p>}
    </div>
  );
}
