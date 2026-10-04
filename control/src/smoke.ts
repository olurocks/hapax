// End-to-end smoke test of the user journey against running services on local Anvil:
// faucet + seed (control plane) → open account → brokerage sign-in and consent → borrow → hire agent →
// leash (refused trades) → agent trades → profit withdrawal → repay from wallet → instructions → close out →
// disconnect brokerage → market close / revoke / reinstate.
//
// The "user" signs with a local key exactly as a browser wallet would (transactions and personal_sign).
// Run: pnpm smoke (needs anvil, a fresh deploy:local, and market, broker, keeper, agent, control running).
import { createWalletClient, http, parseUnits, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ATT_STATUSES,
  STATES,
  creditFacilityAbi,
  facilityFactoryAbi,
  liquidityPoolAbi,
  mockERC20Abi,
  ownerMessage,
  riskManagerAbi,
  type Assignment,
  type OwnerAction,
} from "@hapax/shared";
import { chain, chainId, env, loadDeployment, publicClient, rpcUrl } from "@hapax/shared/env";

if (chainId !== 31337) throw new Error("The smoke test runs on local Anvil only (CHAIN_ID=31337)");
const d = loadDeployment();
// Anvil's public dev key #5. Never a real key.
const user = privateKeyToAccount((process.env.SMOKE_USER_PK ?? "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba") as Hex);
const w = createWalletClient({ account: user, chain, transport: http(rpcUrl) });
const port = (name: string, fallback: string) => `http://127.0.0.1:${env(name, fallback)}`;
const CONTROL = port("CONTROL_PORT", "8791");
const BROKER = port("BROKER_PORT", "8787");
const AGENT = port("AGENT_PORT", "8789");
const APP = "http://localhost:5173/";
const CUSTOMER = `alex-${Date.now().toString(36)}`; // unique per run, so reruns don't collide with earlier links

let failures = 0;
const ok = (cond: unknown, what: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${what}`);
  if (!cond) failures++;
};
const step = (s: string) => console.log(`\n▸ ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(base: string, path: string, body?: unknown, extra: RequestInit = {}) {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...extra,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const control = async (path: string, body?: unknown) => {
  const r = await req(CONTROL, path, body);
  if (r.status !== 200) throw new Error(`control ${path}: ${r.json?.error ?? r.status}`);
  return r.json;
};

async function tx(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  const { request } = await publicClient.simulateContract({ account: user, address, abi, functionName, args } as never);
  const hash = await w.writeContract(request as never);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
}
const evaluate = (f: Address) => publicClient.readContract({ address: d.risk, abi: riskManagerAbi, functionName: "evaluate", args: [f] });
const usdgOf = (a: Address) => publicClient.readContract({ address: d.usdg, abi: mockERC20Abi, functionName: "balanceOf", args: [a] });
const debtOf = (f: Address) => publicClient.readContract({ address: d.pool, abi: liquidityPoolAbi, functionName: "debtOf", args: [f] });

async function signed(action: OwnerAction, facility: Address, fields: Record<string, string>) {
  const r = { action, facility, fields, issuedAt: Math.floor(Date.now() / 1000) };
  return { ...r, signature: await w.signMessage({ message: ownerMessage(r) }) };
}

/** The browser half of the brokerage connection: sign in, approve, follow the redirect back. */
async function connectBrokerage(facility: Address, username: string, passcode: string) {
  const state = "st-" + Math.random().toString(36).slice(2);
  const q = new URLSearchParams({ facility, redirect_uri: APP, state });
  const login = await req(BROKER, `/oauth/authorize?${q}`);
  const sid = /name="sid" value="([^"]+)"/.exec(login.text)?.[1];
  if (!sid) throw new Error("no sign-in session");
  const form = (o: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(o).toString(),
    redirect: "manual" as const,
  });
  const consent = await fetch(`${BROKER}/oauth/login`, form({ sid, username, passcode })).then((r) => r.text());
  if (!consent.includes('value="allow"')) return { consentShown: false, page: consent, location: null };
  const done = await fetch(`${BROKER}/oauth/consent`, form({ sid, decision: "allow" }));
  return { consentShown: true, page: consent, location: done.headers.get("location"), state };
}

async function main() {
  console.log(`user ${user.address}`);

  step("Control plane: market at known prices, faucet and brokerage customer");
  await control("/market/open", {});
  for (const [symbol, price] of [["TSLA", 250], ["AMZN", 200], ["NFLX", 100]] as const) await control("/market/price", { symbol, price });
  await control("/faucet", { wallet: user.address, usdg: 50_000, eth: 5 });
  ok((await usdgOf(user.address)) >= 50_000_000_000n, "wallet funded with USDG");
  await control("/brokerage", { username: CUSTOMER, passcode: "2468", holder: "Alex Rivera", holdings: { TSLA: 1000, AMZN: 500 }, cashUsd: 50_000 });
  const adminNoToken = await req(BROKER, "/admin/accounts");
  ok(adminNoToken.status === 401, "broker admin routes reject calls without the admin token");

  step("Open a credit account");
  await tx(d.factory, facilityFactoryAbi as Abi, "openFacility");
  const mine = await publicClient.readContract({ address: d.factory, abi: facilityFactoryAbi, functionName: "facilitiesOf", args: [user.address] });
  const f = mine[mine.length - 1];
  ok(!!f, `facility ${f}`);

  step("Connect brokerage (sign-in and consent)");
  const bad = await req(BROKER, `/oauth/authorize?${new URLSearchParams({ facility: f, redirect_uri: "https://evil.example/", state: "x" })}`);
  ok(bad.text.includes("not registered"), "unknown redirect origin refused");
  const wrong = await connectBrokerage(f, CUSTOMER, "0000");
  ok(!wrong.consentShown && wrong.page.includes("match an account"), "wrong passcode refused");
  const c = await connectBrokerage(f, CUSTOMER, "2468");
  ok(c.consentShown && c.page.includes("1,000 shares"), "consent page lists holdings");
  ok(c.location?.startsWith(APP) && c.location.includes("brokerage=connected") && c.location.includes(`state=${c.state}`), `redirected back: ${c.location}`);
  const link = (await req(BROKER, `/links/${f}`)).json;
  ok(link.linked && /••\d{4}/.test(link.accountName), `link: ${link.accountName}`);
  let e = await evaluate(f);
  ok(Number(e.creditLimit / 10n ** 18n) === 250_000, `credit limit $${e.creditLimit / 10n ** 18n}`);

  step("Borrow");
  await tx(f, creditFacilityAbi as Abi, "borrow", [300_000_000_000n]);
  ok((await debtOf(f)) >= 300_000_000_000n, "borrowed 300,000 USDG");
  const disconnectEarly = await req(BROKER, `/links/${f}/disconnect`, await signed("disconnect-brokerage", f, {}));
  ok(disconnectEarly.status === 400 && /Repay/.test(disconnectEarly.json.error), "can't disconnect brokerage with debt outstanding");

  step("Hire an agent");
  const catalog = (await req(AGENT, "/agents")).json;
  ok(catalog.agents.length >= 2, `catalog: ${catalog.agents.map((a: { name: string; available: boolean }) => `${a.name}${a.available ? "" : " (unavailable)"}`).join(", ")}`);
  const agent = (await req(AGENT, `/agents/dip-buyer/address?facility=${f}`)).json.agent as Address;
  const now = (await publicClient.getBlock()).timestamp;
  await tx(f, creditFacilityAbi as Abi, "setAgent", [agent, now + 86_400n, parseUnits("250000", 18), [d.stocks.TSLA.token, d.stocks.NFLX.token]]);
  const forged = await req(AGENT, "/assignments", {
    ...(await signed("hire-agent", f, { Agent: "dip-buyer", "Agent address": agent, Instructions: "x" })),
    issuedAt: Math.floor(Date.now() / 1000) - 5,
  });
  ok(forged.status === 400, "tampered hire request rejected");
  const hire = await req(AGENT, "/assignments", await signed("hire-agent", f, { Agent: "dip-buyer", "Agent address": agent, Instructions: "Buy dips, keep a reserve." }));
  ok(hire.status === 200 && (hire.json as Assignment).status === "running", `agent ${agent} running`);
  ok((await publicClient.getBalance({ address: agent })) > 0n, "agent key funded for gas by the service");

  step("The leash: trades outside the mandate revert onchain");
  const amzn = await control("/agent/try", { facility: f, action: "buy", symbol: "AMZN", usd: 10_000 });
  ok(amzn.trades[0].status === "refused" && amzn.trades[0].detail.includes("OutsideMandate"), `AMZN: ${amzn.trades[0].detail}`);
  const big = await control("/agent/try", { facility: f, action: "buy", symbol: "TSLA", usd: 290_000 });
  ok(big.trades[0].status === "refused" && big.trades[0].detail.includes("PositionTooLarge"), `TSLA $290k: ${big.trades[0].detail}`);
  const buy = await control("/agent/try", { facility: f, action: "buy", symbol: "TSLA", usd: 100_000 });
  ok(buy.trades[0].status === "filled", "TSLA $100k filled");

  step("Market rallies; the agent takes profit");
  await control("/market/price", { symbol: "TSLA", price: 275 });
  const sell = await control("/agent/try", { facility: f, action: "sell", symbol: "TSLA", usd: 200_000 });
  ok(sell.trades[0].status === "filled", "agent sold TSLA");
  e = await evaluate(f);
  const [contributed, distributed] = await Promise.all([
    publicClient.readContract({ address: f, abi: creditFacilityAbi, functionName: "contributed" }),
    publicClient.readContract({ address: f, abi: creditFacilityAbi, functionName: "distributed" }),
  ]);
  const profitUnits = (e.assets - e.debt) / 10n ** 12n - contributed + distributed;
  ok(profitUnits > 9_000_000_000n, `profit ≈ $${Number(profitUnits) / 1e6}`);

  step("Withdraw profits to the wallet");
  const before = await usdgOf(user.address);
  const take = (profitUnits * 99n) / 100n;
  await tx(f, creditFacilityAbi as Abi, "withdrawSurplus", [take, user.address]);
  ok((await usdgOf(user.address)) - before === take, `withdrew $${Number(take) / 1e6}`);

  step("Repay from the wallet");
  const debt0 = await debtOf(f);
  await tx(d.usdg, mockERC20Abi as Abi, "approve", [f, 20_000_000_000n]);
  await tx(f, creditFacilityAbi as Abi, "repayFrom", [20_000_000_000n]);
  ok(debt0 - (await debtOf(f)) >= 19_999_000_000n, "repaid 20,000 from wallet");

  step("Update agent instructions");
  const upd = await req(AGENT, `/assignments/${f}/instructions`, await signed("update-instructions", f, { Instructions: "Hold more cash." }));
  ok(upd.status === 200 && upd.json.instructions === "Hold more cash.", "instructions updated");

  step("Close out");
  await control("/agent/try", { facility: f, action: "buy", symbol: "NFLX", usd: 50_000 });
  const walletBefore = await usdgOf(user.address);
  await tx(d.risk, riskManagerAbi as Abi, "cashOut", [f, user.address]);
  ok((await debtOf(f)) === 0n, "debt fully repaid");
  ok((await usdgOf(user.address)) > walletBefore, `received $${Number((await usdgOf(user.address)) - walletBefore) / 1e6}`);
  const agentAfter = await publicClient.readContract({ address: f, abi: creditFacilityAbi, functionName: "agent" });
  ok(agentAfter === "0x0000000000000000000000000000000000000000", "agent revoked onchain");
  const as = (await req(AGENT, `/assignments/${f}`)).json.assignment as Assignment;
  ok(as.status === "revoked", `assignment ${as.status}`);

  step("Disconnect brokerage");
  const disc = await req(BROKER, `/links/${f}/disconnect`, await signed("disconnect-brokerage", f, {}));
  ok(disc.status === 200, "disconnected");
  ok(!(await req(BROKER, `/links/${f}`)).json.linked, "link inactive");
  const att = await publicClient.readContract({ address: d.registry, abi: (await import("@hapax/shared")).collateralRegistryAbi, functionName: "status", args: [f] });
  ok(ATT_STATUSES[att] === "REVOKED", "attestation revoked onchain");

  step("Second account: risk events driven from the control plane");
  await tx(d.factory, facilityFactoryAbi as Abi, "openFacility");
  const all = await publicClient.readContract({ address: d.factory, abi: facilityFactoryAbi, functionName: "facilitiesOf", args: [user.address] });
  const f2 = all[all.length - 1];
  const c2 = await connectBrokerage(f2, CUSTOMER, "2468");
  ok(c2.location?.includes("brokerage=connected"), "same brokerage account pledged to a new account after disconnecting");
  await tx(f2, creditFacilityAbi as Abi, "borrow", [100_000_000_000n]);
  await control("/market/close", {});
  e = await evaluate(f2);
  ok(e.anyClosed && Number(e.creditLimit / 10n ** 18n) < 250_000, `market closed: limit $${e.creditLimit / 10n ** 18n}`);
  await control("/broker/revoke", { facility: f2 });
  ok(STATES[(await evaluate(f2)).state] === "FROZEN", "broker revoke → FROZEN in the same block");
  await control("/broker/reinstate", { facility: f2 });
  ok(STATES[(await evaluate(f2)).state] === "ACTIVE", "broker reinstates → ACTIVE");
  await control("/market/open", {});
  ok(!(await evaluate(f2)).anyClosed, "market open again");
  const status = await control("/status");
  ok(status.facilities.length >= 2 && status.services.agent && status.services.broker && status.services.market, "control /status sees every service");

  await sleep(10);
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nsmoke test crashed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
