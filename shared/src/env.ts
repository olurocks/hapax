import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor } from "./chains.ts";
import type { Deployment } from "./types.ts";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
config({ path: join(repoRoot, ".env") });

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env var ${name}`);
  return v;
}

export const chainId = Number(env("CHAIN_ID", "31337"));
export const chain = chainFor(chainId);
export const rpcUrl = env("RPC_URL", chain.rpcUrls.default.http[0]);

export function loadDeployment(id = chainId): Deployment {
  const path = join(repoRoot, "contracts", "deployments", `${id}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}

export const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

export function walletFor(pkEnv: string) {
  const account = privateKeyToAccount(env(pkEnv) as Hex);
  return createWalletClient({ account, chain, transport: http(rpcUrl) });
}
