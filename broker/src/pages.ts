// Server-rendered pages for the broker's sign-in and consent flow. Self-contained: no scripts, no external assets.
import type { StockSymbol } from "@hapax/shared";
import { html } from "@hapax/shared/http";

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });

function shell(broker: string, title: string, body: string) {
  return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · ${esc(broker)}</title>
<style>
  :root { --bg: #F4F5F2; --panel: #FFFFFF; --fg: #15201B; --muted: #5E6B64; --line: #DCE1DC; --brand: #1F6B4A; --brand-ink: #FFFFFF; --crit: #B3261E; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0F1412; --panel: #161D1A; --fg: #E6ECE8; --muted: #94A39A; --line: #26302B; --brand: #4FBF8A; --brand-ink: #0F1412; --crit: #FF8A80; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; display: grid; place-items: start center; padding: 48px 16px; }
  main { width: 100%; max-width: 440px; display: grid; gap: 20px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: .01em; }
  .brand i { width: 26px; height: 26px; border-radius: 7px; background: var(--brand); display: inline-block; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 24px; display: grid; gap: 16px; }
  h1 { font-size: 20px; margin: 0; font-weight: 600; }
  p { margin: 0; color: var(--muted); }
  label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
  input { font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  button { font: 600 15px system-ui, sans-serif; border-radius: 10px; padding: 11px 16px; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--fg); }
  button.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); }
  .row { display: flex; gap: 10px; } .row button { flex: 1; }
  .err { color: var(--crit); font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 8px 0; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  td:last-child { text-align: right; }
  ul { margin: 0; padding-left: 18px; color: var(--muted); display: grid; gap: 4px; font-size: 14px; }
  code { font: 12.5px ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
  .fine { font-size: 12.5px; }
  a { color: var(--brand); }
</style>
</head>
<body><main>
<div class="brand"><i aria-hidden="true"></i>${esc(broker)}</div>
${body}
</main></body></html>`);
}

export function loginPage(broker: string, sid: string, error?: string) {
  return shell(
    broker,
    "Sign in",
    `<form class="card" method="post" action="/oauth/login">
  <h1>Sign in to continue to Hapax</h1>
  <p>Hapax is asking to verify the holdings in your ${esc(broker)} account.</p>
  ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
  <input type="hidden" name="sid" value="${esc(sid)}" />
  <label>Username<input name="username" autocomplete="username" required autofocus /></label>
  <label>Passcode<input name="passcode" type="password" autocomplete="current-password" required /></label>
  <button class="primary" type="submit">Sign in</button>
</form>
<p class="fine">You will review what Hapax can see before anything is shared.</p>`,
  );
}

export function consentPage(
  broker: string,
  sid: string,
  v: {
    holder: string;
    account: string;
    facility: string;
    owner: string;
    holdings: Partial<Record<StockSymbol, number>>;
    cashUsd: number;
    marks: Partial<Record<StockSymbol, number>>;
  },
) {
  const rows = Object.entries(v.holdings)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([s, n]) => {
      const px = v.marks[s as StockSymbol];
      return `<tr><td>${esc(s)}</td><td>${esc(n!.toLocaleString("en-US"))} shares</td><td>${px ? money(px * n!) : ""}</td></tr>`;
    })
    .join("");
  return shell(
    broker,
    "Allow access",
    `<form class="card" method="post" action="/oauth/consent">
  <h1>Pledge your holdings to Hapax?</h1>
  <p>${esc(v.holder)} · ${esc(v.account)}</p>
  <table>${rows}<tr><td>Cash</td><td></td><td>${money(v.cashUsd)}</td></tr></table>
  <ul>
    <li>${esc(broker)} will sign a statement of these holdings for your Hapax facility and keep it current.</li>
    <li>Your shares stay in this account. Nothing is moved or sold.</li>
    <li>If your facility defaults, ${esc(broker)} may sell pledged shares to repay it.</li>
    <li>You can disconnect from Hapax once your balance is repaid.</li>
  </ul>
  <p class="fine">Facility <code>${esc(v.facility)}</code><br />Owner wallet <code>${esc(v.owner)}</code></p>
  <input type="hidden" name="sid" value="${esc(sid)}" />
  <div class="row">
    <button type="submit" name="decision" value="deny">Cancel</button>
    <button class="primary" type="submit" name="decision" value="allow">Allow</button>
  </div>
</form>`,
  );
}

export function errorPage(broker: string, message: string, backTo?: string) {
  return shell(
    broker,
    "Can't connect",
    `<div class="card">
  <h1>We couldn't connect your account</h1>
  <p class="err" role="alert">${esc(message)}</p>
  ${backTo ? `<p><a href="${esc(backTo)}">Return to Hapax</a></p>` : ""}
</div>`,
  );
}
