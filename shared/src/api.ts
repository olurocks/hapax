// Request and response shapes shared by the services and the web app. Browser-safe: no Node imports.
import type { Address, Hex } from "viem";
import type { StockSymbol } from "./types.ts";

// ------------------------------------------------------------------ owner-signed requests

/**
 * Offchain requests that only a facility's owner may make (hiring an agent, changing its instructions,
 * disconnecting a brokerage) are authorised by a personal_sign over this text. Signing moves no funds.
 */
export type OwnerAction = "hire-agent" | "update-instructions" | "disconnect-brokerage";
export interface OwnerRequest {
  action: OwnerAction;
  facility: Address;
  fields: Record<string, string>;
  issuedAt: number; // unix seconds
}
export interface SignedOwnerRequest extends OwnerRequest {
  signature: Hex;
}
export const OWNER_REQUEST_MAX_AGE_S = 600;

const ACTION_TITLE: Record<OwnerAction, string> = {
  "hire-agent": "Start an agent on my facility",
  "update-instructions": "Update my agent's instructions",
  "disconnect-brokerage": "Disconnect my brokerage account",
};

export function ownerMessage(r: OwnerRequest): string {
  return [
    `Hapax: ${ACTION_TITLE[r.action]}`,
    "",
    `Facility: ${r.facility}`,
    ...Object.entries(r.fields).map(([k, v]) => `${k}: ${v}`),
    `Issued at: ${r.issuedAt}`,
    "",
    "This signature authorises the request above. It does not move funds or approve a transaction.",
  ].join("\n");
}

// ------------------------------------------------------------------ agent service

export interface AgentProfile {
  id: string;
  name: string;
  tagline: string;
  description: string;
  engine: string; // "claude-opus-5-5" or "rules"
  available: boolean;
  unavailableReason?: string;
  defaultInstructions: string;
  suggested: { symbols: StockSymbol[]; maxPositionUsd: number; hours: number };
}

export interface AgentTrade {
  action: "buy" | "sell" | "repay";
  symbol: string;
  usd: number;
  status: "filled" | "refused" | "skipped";
  detail: string;
  tx?: string;
}
export interface AgentDecision {
  at: string;
  source: "claude" | "rules" | "operator";
  reasoning: string;
  trades: AgentTrade[];
}

export type AssignmentStatus =
  | "running" // mandate active onchain, the service trades it
  | "not-appointed" // the service holds instructions but the facility has no matching agent onchain
  | "expired" // mandate expired
  | "revoked"; // owner revoked or replaced the agent

export interface Assignment {
  facility: Address;
  agentId: string;
  agentName: string;
  agent: Address; // the key the service trades with for this facility
  instructions: string;
  hiredAt: string;
  status: AssignmentStatus;
  lastRunAt?: string;
  nextRunAt?: string;
  lastError?: string;
  history: AgentDecision[];
}

// ------------------------------------------------------------------ broker service

export interface BrokerLink {
  linked: boolean;
  accountName?: string; // "Robinhood Individual ••4821"
  holder?: string;
  attesting?: boolean;
  lastAttestedAt?: string;
  lastError?: string;
}
