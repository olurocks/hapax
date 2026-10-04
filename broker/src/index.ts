// Broker simulator: stands in for a brokerage that custodies the borrower's real shares.
//
// Public, used by the Hapax app:
//   GET  /info                             broker name and signer
//   GET  /oauth/authorize?facility&redirect_uri&state   sign-in + consent pages (OAuth-style), then attests
//   GET  /links/:facility                  is this facility linked, to which account, is the broker attesting
//   POST /links/:facility/disconnect       owner-signed; only with no debt outstanding
//
// Admin (demo control plane, x-admin-token; called by the control service, never by the app):
//   brokerage accounts (seed customers and holdings), encumber, revoke, silence, reinstate, settle.
//
// While a facility is linked the broker re-signs an EIP-712 holdings attestation (shares, not dollars) on a heartbeat.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { encodeAbiParameters, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  ATT_STATUSES,
  SYMBOLS,
  attestationDomain,
  attestationTypes,
  collateralRegistryAbi,
  creditFacilityAbi,
  facilityFactoryAbi,
  liquidityPoolAbi,
  marketOracleAbi,
  mockERC20Abi,
  riskManagerAbi,
  toWad,
  type BrokerLink,
  type SignedOwnerRequest,
  type StockSymbol,
} from "@hapax/shared";
import { chainId, env, loadDeployment, publicClient, repoRoot, walletFor } from "@hapax/shared/env";
import { HttpError, log as mkLog, redirect, serve } from "@hapax/shared/http";
import { verifyOwnerRequest } from "@hapax/shared/verify";
import { consentPage, errorPage, loginPage } from "./pages.ts";

const log = mkLog("broker");
const d = loadDeployment();
const wallet = walletFor("BROKER_PK");
const TTL = BigInt(env("ATTEST_TTL_S", "300"));
const INTERVAL = Number(env("ATTEST_INTERVAL_MS", "30000"));
const BROKER_NAME = env("BROKER_NAME", "Harbor Securities");
/** Origins the consent flow may send the user back to (the Hapax app). */
const REDIRECT_ORIGINS = env("BROKER_REDIRECT_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""));

// ------------------------------------------------------------------ state

type Holdings = Partial<Record<StockSymbol, number>>;

/** A customer of the broker. Seeded through the control plane. */
interface Customer {
  username: string;
  passcode: string;
  holder: string;
  accountNumber: string;
  holdings: Holdings;
  cashUsd: number;
  encumberedUsd: number;
}

/** A facility the customer pledged their account to. The custody ref is fixed for the facility's life. */
interface Link {
  facility: Address;
  borrower: Address;
  username: string;
  salt: Hex;
  active: boolean; // false after the owner disconnects
  attesting: boolean; // false when the broker goes silent or revokes
  lastTx?: Hex;
  lastAttestedAt?: string;
  lastError?: string;
}

const customersPath = join(repoRoot, "broker", `customers.${chainId}.json`);
// Links are per deployment (a fresh deploy has no facilities); customers belong to the broker and persist.
const linksPath = join(repoRoot, "broker", `links.${chainId}.${d.factory.slice(2, 10).toLowerCase()}.json`);
const load = <T>(p: string): T => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : ({} as T));
const customers = load<Record<string, Customer>>(customersPath);
const links = load<Record<string, Link>>(linksPath);
const save = () => {
  writeFileSync(customersPath, JSON.stringify(customers, null, 2));
  writeFileSync(linksPath, JSON.stringify(links, null, 2));
};

/** Sign-in sessions for the consent flow, kept in memory for ten minutes. */
interface Session {
  facility: Address;
  owner: Address;
  redirectUri: string;
  state: string;
  username?: string;
  expires: number;
}
const sessions = new Map<string, Session>();

// Serialize every write from the broker key so nonces never collide.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

const masked = (c: Customer) => `Individual ••${c.accountNumber.slice(-4)}`;
const linkOf = (facility: string) => links[facility.toLowerCase()];
function activeLink(facility: string): Link {
  const l = linkOf(facility);
  if (!l?.active) throw new Error(`No brokerage account is linked to facility ${facility}`);
  return l;
}
function customer(username: string): Customer {
  const c = customers[username.toLowerCase()];
  if (!c) throw new Error(`No brokerage customer "${username}"`);
  return c;
}

const custodyRef = (l: Link) =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "string" }], [l.salt, customer(l.username).accountNumber]));

const debtOf = (facility: Address) =>
  publicClient.readContract({ address: d.pool, abi: liquidityPoolAbi, functionName: "debtOf", args: [facility] });

// ------------------------------------------------------------------ attesting

async function attest(l: Link) {
  return enqueue(async () => {
    const c = customer(l.username);
    const rec = await publicClient.readContract({
      address: d.registry,
      abi: collateralRegistryAbi,
      functionName: "record",
      args: [l.facility],
    });
    const { timestamp } = await publicClient.getBlock();
    const message = {
      facility: l.facility,
      borrower: l.borrower,
      custodyRef: custodyRef(l),
      positions: SYMBOLS.filter((s) => (c.holdings[s] ?? 0) > 0).map((s) => ({
        asset: d.stocks[s].token,
        shares: toWad(c.holdings[s]!),
      })),
      cashUsd: toWad(c.cashUsd),
      encumberedUsd: toWad(c.encumberedUsd),
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
    l.lastTx = hash;
    l.lastAttestedAt = new Date().toISOString();
    l.lastError = undefined;
    save();
    log(`attested ${l.facility} for ${c.username} nonce=${message.nonce} ${JSON.stringify(c.holdings)} cash=$${c.cashUsd}`);
    return { nonce: message.nonce, expiresAt: message.expiresAt, tx: hash };
  });
}

async function tick() {
  for (const l of Object.values(links)) {
    if (!l.active || !l.attesting) continue;
    try {
      await attest(l);
    } catch (err) {
      l.lastError = err instanceof Error ? err.message.split("\n")[0] : String(err);
      log(`attest failed for ${l.facility}: ${l.lastError}`);
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

/** Re-attest every active link backed by this customer (after holdings change). */
async function reattestCustomer(username: string) {
  const out = [];
  for (const l of Object.values(links)) {
    if (l.username === username.toLowerCase() && l.active && l.attesting) out.push(await attest(l));
  }
  return out;
}

// ------------------------------------------------------------------ consent flow helpers

function allowedRedirect(uri: string) {
  try {
    const u = new URL(uri);
    return REDIRECT_ORIGINS.includes(u.origin);
  } catch {
    return false;
  }
}

function back(s: Session, params: Record<string, string>) {
  const u = new URL(s.redirectUri);
  for (const [k, v] of Object.entries({ ...params, state: s.state })) u.searchParams.set(k, v);
  return redirect(u.toString());
}

function session(sid: string): Session {
  const s = sessions.get(sid);
  if (!s || s.expires < Date.now()) throw new HttpError(400, "Your sign-in session expired. Start again from Hapax.");
  return s;
}

/** Prices for the consent page, so the customer sees what they are pledging. */
async function marks() {
  const out: Partial<Record<StockSymbol, number>> = {};
  for (const s of SYMBOLS) {
    try {
      const q = await publicClient.readContract({
        address: d.oracle,
        abi: marketOracleAbi,
        functionName: "quote",
        args: [d.stocks[s].token],
      });
      out[s] = Number(q.mark / 10n ** 14n) / 1e4;
    } catch {
      /* price unavailable: the page shows shares only */
    }
  }
  return out;
}

// ------------------------------------------------------------------ routes

serve("broker", Number(env("BROKER_PORT", "8787")), {
  "GET /info": () => ({ name: BROKER_NAME, signer: wallet.account.address, chainId }),

  // ---------------------------------------------------------------- consent flow (browser pages)

  "GET /oauth/authorize": async (_b, { query }) => {
    const { facility, redirect_uri: redirectUri = "", state = "" } = query;
    if (!allowedRedirect(redirectUri)) return errorPage(BROKER_NAME, "This app is not registered with the broker.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(facility ?? "")) return errorPage(BROKER_NAME, "Missing facility.");
    const isFacility = await publicClient.readContract({
      address: d.factory,
      abi: facilityFactoryAbi,
      functionName: "isFacility",
      args: [facility as Address],
    });
    if (!isFacility) return errorPage(BROKER_NAME, "Unknown Hapax facility.");
    const owner = (await publicClient.readContract({
      address: facility as Address,
      abi: creditFacilityAbi,
      functionName: "owner",
    })) as Address;
    const sid = randomBytes(18).toString("base64url");
    sessions.set(sid, { facility: facility as Address, owner, redirectUri, state, expires: Date.now() + 10 * 60_000 });
    return loginPage(BROKER_NAME, sid);
  },

  "POST /oauth/login": async (b: { sid: string; username: string; passcode: string }) => {
    const s = session(b.sid);
    const c = customers[String(b.username ?? "").trim().toLowerCase()];
    if (!c || c.passcode !== String(b.passcode ?? "")) {
      return loginPage(BROKER_NAME, b.sid, "That username and passcode don't match an account.");
    }
    const prior = linkOf(s.facility);
    if (prior && prior.username !== c.username) {
      return errorPage(
        BROKER_NAME,
        "This Hapax facility is tied to a different brokerage account. Open a new facility in Hapax to pledge this account.",
        s.redirectUri,
      );
    }
    const elsewhere = Object.values(links).find(
      (l) => l.active && l.username === c.username && l.facility.toLowerCase() !== s.facility.toLowerCase(),
    );
    if (elsewhere) {
      return errorPage(
        BROKER_NAME,
        `This account already backs another Hapax facility (${elsewhere.facility.slice(0, 6)}…${elsewhere.facility.slice(-4)}). Disconnect it there first.`,
        s.redirectUri,
      );
    }
    s.username = c.username;
    return consentPage(BROKER_NAME, b.sid, {
      holder: c.holder,
      account: masked(c),
      facility: s.facility,
      owner: s.owner,
      holdings: c.holdings,
      cashUsd: c.cashUsd,
      marks: await marks(),
    });
  },

  "POST /oauth/consent": async (b: { sid: string; decision: string }) => {
    const s = session(b.sid);
    sessions.delete(b.sid);
    if (b.decision !== "allow" || !s.username) return back(s, { brokerage: "denied" });
    const key = s.facility.toLowerCase();
    const l: Link = links[key] ?? {
      facility: s.facility,
      borrower: s.owner,
      username: s.username,
      salt: generatePrivateKey(),
      active: true,
      attesting: true,
    };
    l.active = true;
    l.attesting = true;
    l.borrower = s.owner;
    links[key] = l;
    save();
    try {
      await attest(l);
    } catch (err) {
      l.active = false;
      save();
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      log(`link failed for ${s.facility}: ${msg}`);
      return back(s, { brokerage: "error" });
    }
    log(`linked ${s.facility} to ${s.username}`);
    return back(s, { brokerage: "connected" });
  },

  // ---------------------------------------------------------------- app API

  "GET /links/:facility": async (_b, { params }): Promise<BrokerLink> => {
    const l = linkOf(params.facility);
    if (!l?.active) return { linked: false };
    const c = customers[l.username];
    return {
      linked: true,
      accountName: c ? `${BROKER_NAME} · ${masked(c)}` : undefined,
      holder: c?.holder,
      attesting: l.attesting,
      lastAttestedAt: l.lastAttestedAt,
      lastError: l.lastError,
    };
  },

  /** Owner-signed. Allowed only with no debt: the pledge is what backs the credit. */
  "POST /links/:facility/disconnect": async (b: SignedOwnerRequest, { params }) => {
    if (b.facility?.toLowerCase() !== params.facility.toLowerCase()) throw new Error("Facility mismatch");
    await verifyOwnerRequest(b, "disconnect-brokerage");
    const l = activeLink(params.facility);
    if ((await debtOf(l.facility)) > 0n) throw new Error("Repay your balance before disconnecting your brokerage account.");
    l.active = false;
    l.attesting = false;
    save();
    const tx = await write("revoke", [l.facility, 2], d.registry, collateralRegistryAbi);
    log(`disconnected ${l.facility} at the owner's request`);
    return { tx };
  },

  // ---------------------------------------------------------------- admin (demo control plane)

  "GET /admin/accounts": async () => {
    const out = [];
    for (const l of Object.values(links)) {
      const status = await publicClient.readContract({
        address: d.registry,
        abi: collateralRegistryAbi,
        functionName: "status",
        args: [l.facility],
      });
      out.push({ ...l, salt: undefined, status: ATT_STATUSES[status] });
    }
    return {
      broker: wallet.account.address,
      chainId,
      customers: Object.values(customers),
      links: out,
    };
  },

  /** Create or update a brokerage customer: { username, passcode, holder?, holdings: { TSLA: 1000 }, cashUsd? } */
  "POST /admin/accounts": async (b: { username: string; passcode?: string; holder?: string; holdings?: Holdings; cashUsd?: number }) => {
    if (!b.username) throw new Error("username required");
    const key = b.username.trim().toLowerCase();
    const prev = customers[key];
    if (!prev && !b.passcode) throw new Error("passcode required for a new customer");
    customers[key] = {
      username: key,
      passcode: b.passcode ?? prev!.passcode,
      holder: b.holder ?? prev?.holder ?? b.username,
      accountNumber: prev?.accountNumber ?? String(Math.floor(1e7 + Math.random() * 9e7)),
      holdings: b.holdings ?? prev?.holdings ?? {},
      cashUsd: b.cashUsd ?? prev?.cashUsd ?? 0,
      encumberedUsd: prev?.encumberedUsd ?? 0,
    };
    save();
    log(`customer ${key} ${JSON.stringify(customers[key].holdings)} cash=$${customers[key].cashUsd}`);
    const attestations = prev ? await reattestCustomer(key) : [];
    return { customer: { ...customers[key] }, attestations };
  },

  /** Margin elsewhere at the broker reduces what this facility can count. */
  "POST /admin/encumber": async (b: { facility: Address; encumberedUsd: number }) => {
    const l = activeLink(b.facility);
    customer(l.username).encumberedUsd = b.encumberedUsd;
    save();
    return attest(l);
  },

  /** Revoke now (account transferred out, fraud flag...). The facility freezes in the same block. */
  "POST /admin/revoke": async (b: { facility: Address; reason?: number }) => {
    const l = activeLink(b.facility);
    l.attesting = false;
    save();
    const tx = await write("revoke", [l.facility, b.reason ?? 1], d.registry, collateralRegistryAbi);
    log(`revoked ${l.facility}`);
    return { tx };
  },

  /** Stop signing without revoking: the attestation goes STALE at expiry (dead-man switch). */
  "POST /admin/silence": (b: { facility: Address }) => {
    const l = activeLink(b.facility);
    l.attesting = false;
    save();
    return { attesting: false };
  },

  "POST /admin/reinstate": async (b: { facility: Address }) => {
    const l = activeLink(b.facility);
    l.attesting = true;
    save();
    return attest(l);
  },

  /** Simulated offchain sale of pledged shares after DEFAULT: pay proceeds in USDG to close the facility. */
  "POST /admin/settle": async (b: { facility: Address; amountUsd?: number }) => {
    const l = linkOf(b.facility);
    if (!l) throw new Error(`Facility ${b.facility} was never linked to this broker`);
    const amount = b.amountUsd !== undefined ? parseUnits(String(b.amountUsd), 6) : await debtOf(l.facility);
    if (d.mocks) await write("mint", [wallet.account.address, amount], d.usdg, mockERC20Abi);
    await write("approve", [d.risk, amount], d.usdg, mockERC20Abi);
    const evidence = keccak256(toHex(`sale:${b.facility}:${Date.now()}`));
    const tx = await write("confirmSettlement", [l.facility, amount, evidence], d.risk, riskManagerAbi);
    l.active = false;
    l.attesting = false;
    save();
    log(`settled ${b.facility} with $${Number(amount) / 1e6}`);
    return { tx, evidence, amountUsd: Number(amount) / 1e6 };
  },
});

log(`${BROKER_NAME} signer ${wallet.account.address} on chain ${chainId}, attesting every ${INTERVAL / 1000}s, ttl ${TTL}s`);
setInterval(tick, INTERVAL);
setInterval(() => {
  for (const [sid, s] of sessions) if (s.expires < Date.now()) sessions.delete(sid);
}, 60_000);
