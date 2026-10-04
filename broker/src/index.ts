// Broker simulator: stands in for a brokerage that custodies the borrower's real shares.
// It signs EIP-712 holdings attestations (shares, not dollars) on a heartbeat and exposes an operator API
// for the demo: open an account, change holdings, encumber, revoke, go silent (attestation goes stale), settle.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  ATT_STATUSES,
  SYMBOLS,
  attestationDomain,
  attestationTypes,
  collateralRegistryAbi,
  creditFacilityAbi,
  mockERC20Abi,
  riskManagerAbi,
  toWad,
  type StockSymbol,
} from "@hapax/shared";
import { chainId, env, loadDeployment, publicClient, repoRoot, walletFor } from "@hapax/shared/env";
import { log as mkLog, serve } from "@hapax/shared/http";

const log = mkLog("broker");
const d = loadDeployment();
const wallet = walletFor("BROKER_PK");
const TTL = BigInt(env("ATTEST_TTL_S", "300"));
const INTERVAL = Number(env("ATTEST_INTERVAL_MS", "30000"));
const statePath = join(repoRoot, "broker", `state.${chainId}.json`);

type Holdings = Partial<Record<StockSymbol, number>>;
interface Account {
  facility: Address;
  borrower: Address;
  accountId: string;
  salt: Hex;
  holdings: Holdings;
  cashUsd: number;
  encumberedUsd: number;
  attesting: boolean;
  lastTx?: Hex;
  lastError?: string;
}

const accounts: Record<string, Account> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => writeFileSync(statePath, JSON.stringify(accounts, null, 2));

// Serialize every write from the broker key so nonces never collide.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function account(facility: string): Account {
  const a = accounts[facility.toLowerCase()];
  if (!a) throw new Error(`No brokerage account for facility ${facility}`);
  return a;
}

const custodyRef = (a: Account) =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "string" }], [a.salt, a.accountId]));

async function attest(a: Account) {
  return enqueue(async () => {
    const rec = await publicClient.readContract({
      address: d.registry,
      abi: collateralRegistryAbi,
      functionName: "record",
      args: [a.facility],
    });
    const { timestamp } = await publicClient.getBlock();
    const message = {
      facility: a.facility,
      borrower: a.borrower,
      custodyRef: custodyRef(a),
      positions: SYMBOLS.filter((s) => (a.holdings[s] ?? 0) > 0).map((s) => ({
        asset: d.stocks[s].token,
        shares: toWad(a.holdings[s]!),
      })),
      cashUsd: toWad(a.cashUsd),
      encumberedUsd: toWad(a.encumberedUsd),
      issuedAt: timestamp,
      expiresAt: timestamp + TTL,
      nonce: rec.nonce + 1n,
    };
    const signature = await wallet.signTypedData({
      domain: attestationDomain(chainId, d.registry),
      types: attestationTypes,
      primaryType: "Attestation",
      message,
    });
    const hash = await wallet.writeContract({
      address: d.registry,
      abi: collateralRegistryAbi,
      functionName: "submit",
      args: [message, signature],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    a.lastTx = hash;
    a.lastError = undefined;
    save();
    log(`attested ${a.facility} nonce=${message.nonce} positions=${JSON.stringify(a.holdings)} cash=$${a.cashUsd}`);
    return { nonce: message.nonce, expiresAt: message.expiresAt, tx: hash };
  });
}

async function tick() {
  for (const a of Object.values(accounts)) {
    if (!a.attesting) continue;
    try {
      await attest(a);
    } catch (err) {
      a.lastError = err instanceof Error ? err.message.split("\n")[0] : String(err);
      log(`attest failed for ${a.facility}: ${a.lastError}`);
    }
  }
}

async function write(fn: string, args: readonly unknown[], address: Address, abi: any) {
  return enqueue(async () => {
    const hash = await wallet.writeContract({ address, abi, functionName: fn, args } as any);
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  });
}

serve("broker", Number(env("BROKER_PORT", "8787")), {
  "GET /state": async () => {
    const out = [];
    for (const a of Object.values(accounts)) {
      const status = await publicClient.readContract({
        address: d.registry,
        abi: collateralRegistryAbi,
        functionName: "status",
        args: [a.facility],
      });
      out.push({ ...a, salt: undefined, custodyRef: custodyRef(a), status: ATT_STATUSES[status] });
    }
    return { broker: wallet.account.address, chainId, accounts: out };
  },

  /** Open a brokerage account for a facility: { facility, holdings: { TSLA: 1000, AMZN: 500 }, cashUsd } */
  "POST /accounts": async (b: { facility: Address; holdings: Holdings; cashUsd?: number; accountId?: string }) => {
    const borrower = await publicClient.readContract({
      address: b.facility,
      abi: creditFacilityAbi,
      functionName: "owner",
    });
    const a: Account = {
      facility: b.facility,
      borrower,
      accountId: b.accountId ?? `RH-${Math.floor(Math.random() * 1e8)}`,
      salt: generatePrivateKey(),
      holdings: b.holdings,
      cashUsd: b.cashUsd ?? 0,
      encumberedUsd: 0,
      attesting: true,
    };
    accounts[b.facility.toLowerCase()] = a;
    save();
    return attest(a);
  },

  "POST /holdings": async (b: { facility: Address; holdings?: Holdings; cashUsd?: number }) => {
    const a = account(b.facility);
    if (b.holdings) a.holdings = b.holdings;
    if (b.cashUsd !== undefined) a.cashUsd = b.cashUsd;
    return attest(a);
  },

  "POST /encumber": async (b: { facility: Address; encumberedUsd: number }) => {
    const a = account(b.facility);
    a.encumberedUsd = b.encumberedUsd;
    return attest(a);
  },

  /** Revoke now (account transferred out, fraud flag...). The facility freezes in the same block. */
  "POST /revoke": async (b: { facility: Address; reason?: number }) => {
    const a = account(b.facility);
    a.attesting = false;
    save();
    const tx = await write("revoke", [a.facility, b.reason ?? 1], d.registry, collateralRegistryAbi);
    log(`revoked ${a.facility}`);
    return { tx };
  },

  /** Stop signing without revoking: the attestation goes STALE at expiry (dead-man switch). */
  "POST /silence": async (b: { facility: Address }) => {
    const a = account(b.facility);
    a.attesting = false;
    save();
    return { attesting: false };
  },

  "POST /reinstate": async (b: { facility: Address }) => {
    const a = account(b.facility);
    a.attesting = true;
    save();
    return attest(a);
  },

  /** Simulated offchain sale of pledged shares after DEFAULT: pay proceeds in USDG to close the facility. */
  "POST /settle": async (b: { facility: Address; amountUsd: number }) => {
    account(b.facility);
    const amount = parseUnits(String(b.amountUsd), 6);
    if (d.mocks) await write("mint", [wallet.account.address, amount], d.usdg, mockERC20Abi);
    await write("approve", [d.risk, amount], d.usdg, mockERC20Abi);
    const evidence = keccak256(toHex(`sale:${b.facility}:${Date.now()}`));
    const tx = await write("confirmSettlement", [b.facility, amount, evidence], d.risk, riskManagerAbi);
    log(`settled ${b.facility} with $${b.amountUsd}`);
    return { tx, evidence };
  },
});

log(`broker ${wallet.account.address} on chain ${chainId}, attesting every ${INTERVAL / 1000}s, ttl ${TTL}s`);
setInterval(tick, INTERVAL);
