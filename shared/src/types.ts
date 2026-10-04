import type { Address } from "viem";

// Mirrors contracts/src/libraries/Types.sol. Order matters: these index the Solidity enums.
export const STATES = [
  "ACTIVE",
  "WARNING",
  "MARGIN_CALL",
  "DELEVERAGING",
  "FROZEN",
  "CURE",
  "DEFAULT",
  "CLOSED",
] as const;
export type StateName = (typeof STATES)[number];

export const ATT_STATUSES = ["NONE", "VALID", "STALE", "REVOKED"] as const;
export const LEVELS = ["HEALTHY", "WARNING", "MARGIN_CALL", "DELEVERAGING"] as const;
export const PHASES = ["NORMAL", "CURE", "DEFAULT", "CLOSED"] as const;

export const SYMBOLS = ["TSLA", "AMZN", "NFLX"] as const;
export type StockSymbol = (typeof SYMBOLS)[number];

export interface Deployment {
  chainId: number;
  mocks: boolean;
  admin: Address;
  broker: Address;
  usdg: Address;
  oracle: Address;
  registry: Address;
  pool: Address;
  risk: Address;
  factory: Address;
  venue: Address;
  stocks: Record<StockSymbol, { token: Address; refFeed: Address; liveFeed: Address }>;
}

/** EIP-712 types for broker holdings attestations (CollateralRegistry.ATTESTATION_TYPEHASH). */
export const attestationTypes = {
  Position: [
    { name: "asset", type: "address" },
    { name: "shares", type: "uint256" },
  ],
  Attestation: [
    { name: "facility", type: "address" },
    { name: "borrower", type: "address" },
    { name: "custodyRef", type: "bytes32" },
    { name: "positions", type: "Position[]" },
    { name: "cashUsd", type: "uint256" },
    { name: "encumberedUsd", type: "uint256" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export function attestationDomain(chainId: number, registry: Address) {
  return { name: "Hapax", version: "1", chainId, verifyingContract: registry } as const;
}

/** 1e18 fixed point helpers. */
export const WAD = 10n ** 18n;
export const toWad = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
export const fromWad = (x: bigint) => Number(x / 10n ** 12n) / 1e6;
