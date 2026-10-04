// Keeper: anyone can run one. Each tick it evaluates every facility, persists state changes with `poke`
// (timers, events), and calls `deleverage` when the fresh evaluation allows it. It never supplies calldata
// for the unwind; the contract sells at oracle-bounded prices and pays a capped tip.
import { type Address } from "viem";
import { STATES, facilityFactoryAbi, fromWad, riskManagerAbi } from "@hapax/shared";
import { env, loadDeployment, publicClient, walletFor } from "@hapax/shared/env";
import { log as mkLog } from "@hapax/shared/http";

const log = mkLog("keeper");
const d = loadDeployment();
const wallet = walletFor("KEEPER_PK");
const POLL = Number(env("KEEPER_POLL_MS", "2000"));

const pct = (x: bigint) => (x > 10n ** 30n ? "∞" : `${(fromWad(x) * 100).toFixed(1)}%`);

async function send(fn: "poke" | "deleverage", facility: Address) {
  const { request } = await publicClient.simulateContract({
    account: wallet.account,
    address: d.risk,
    abi: riskManagerAbi,
    functionName: fn,
    args: [facility],
  });
  const hash = await wallet.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function check(facility: Address) {
  const [e, rec, canDelev] = await Promise.all([
    publicClient.readContract({ address: d.risk, abi: riskManagerAbi, functionName: "evaluate", args: [facility] }),
    publicClient.readContract({ address: d.risk, abi: riskManagerAbi, functionName: "recordOf", args: [facility] }),
    publicClient.readContract({ address: d.risk, abi: riskManagerAbi, functionName: "canDeleverage", args: [facility] }),
  ]);

  const tag = `${facility.slice(0, 10)} ${STATES[e.state]} U=${pct(e.U)} H=${pct(e.H)}${e.anyClosed ? " [market closed]" : ""}`;

  if (canDelev) {
    const tx = await send("deleverage", facility);
    log(`${tag} -> deleveraged (${tx})`);
    return;
  }

  const timerPending = STATES[e.state] === "FROZEN" && rec.frozenAt === 0n;
  if (e.state !== rec.lastState || timerPending) {
    const tx = await send("poke", facility);
    log(`${tag} <- was ${STATES[rec.lastState]} (poked ${tx})`);
  }
}

async function tick() {
  const facilities = await publicClient.readContract({
    address: d.factory,
    abi: facilityFactoryAbi,
    functionName: "facilities",
  });
  for (const f of facilities) {
    try {
      await check(f);
    } catch (err) {
      log(`${f.slice(0, 10)} error: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }
}

log(`keeper ${wallet.account.address} watching ${d.factory} every ${POLL}ms`);
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await tick();
  } finally {
    running = false;
  }
}, POLL);
