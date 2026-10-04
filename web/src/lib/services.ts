// The app's two backends: the brokerage (holdings attestations) and the agent service (hire and run agents).
import type { Address } from "viem";
import type { AgentProfile, Assignment, BrokerLink, OwnerAction, SignedOwnerRequest } from "@hapax/shared";
import { ownerMessage } from "@hapax/shared";
import type { Wallet } from "./wallet";

const env = import.meta.env;
export const services = {
  broker: (env.VITE_BROKER_URL as string | undefined) ?? "http://localhost:8787",
  agent: (env.VITE_AGENT_URL as string | undefined) ?? "http://localhost:8789",
};
const NAMES = { broker: "brokerage connection", agent: "agent service" } as const;

async function api<T>(service: keyof typeof services, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(services[service] + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`The ${NAMES[service]} is unavailable right now. Try again in a moment.`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `The ${NAMES[service]} returned an error (${res.status}).`);
  return json as T;
}

/** Have the owner sign an offchain request with their wallet (personal_sign; no transaction). */
export async function signOwnerRequest(
  wallet: Wallet,
  action: OwnerAction,
  facility: Address,
  fields: Record<string, string>,
): Promise<SignedOwnerRequest> {
  const req = { action, facility, fields, issuedAt: Math.floor(Date.now() / 1000) };
  const signature = await wallet.client.signMessage({ account: wallet.address, message: ownerMessage(req) });
  return { ...req, signature };
}

// ------------------------------------------------------------------ brokerage

export const broker = {
  info: () => api<{ name: string; signer: Address }>("broker", "/info"),
  link: (facility: Address) => api<BrokerLink>("broker", `/links/${facility}`),
  disconnect: (req: SignedOwnerRequest) => api<{ tx: string }>("broker", `/links/${req.facility}/disconnect`, req),
  /** Where to send the browser to sign in at the broker and approve the link. */
  authorizeUrl: (facility: Address, redirectUri: string, state: string) =>
    `${services.broker}/oauth/authorize?${new URLSearchParams({ facility, redirect_uri: redirectUri, state })}`,
};

// ------------------------------------------------------------------ agents

export const agents = {
  catalog: () => api<{ agents: AgentProfile[]; intervalMs: number }>("agent", "/agents"),
  addressFor: (agentId: string, facility: Address) =>
    api<{ agent: Address }>("agent", `/agents/${agentId}/address?facility=${facility}`).then((r) => r.agent),
  hire: (req: SignedOwnerRequest) => api<Assignment>("agent", "/assignments", req),
  updateInstructions: (req: SignedOwnerRequest) => api<Assignment>("agent", `/assignments/${req.facility}/instructions`, req),
  assignment: (facility: Address) => api<{ assignment: Assignment | null }>("agent", `/assignments/${facility}`).then((r) => r.assignment),
};
