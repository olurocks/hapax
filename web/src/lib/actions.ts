// Every user action, as steps for the progress panel. Views call these; nothing here touches React state.
import { type Abi, type Address } from "viem";
import { demoVenueAbi, facilityFactoryAbi, mockERC20Abi, riskManagerAbi } from "@hapax/shared";
import { deployment, facilityAbiFull, publicClient, send, type Call } from "./chain";
import { agents, broker, signOwnerRequest } from "./services";
import type { Step } from "./tx";
import type { Wallet } from "./wallet";

const d = () => deployment!;

const tx = (label: string, w: Wallet, call: () => Call | Promise<Call>): Step => ({
  label,
  kind: "tx",
  run: async (on) => send(w.client, w.address, await call(), on),
});

const facilityCall = (f: Address, functionName: string, args: readonly unknown[] = []): Call => ({
  address: f,
  abi: facilityAbiFull as Abi,
  functionName,
  args,
});

/** Approve the facility to pull exactly `amount` USDG, skipped when the allowance already covers it. */
const approve = (w: Wallet, spender: Address, amount: bigint): Step => ({
  ...tx("Approve USDG", w, () => ({
    address: d().usdg,
    abi: mockERC20Abi as Abi,
    functionName: "approve",
    args: [spender, amount],
  })),
  skip: async () =>
    (await publicClient.readContract({
      address: d().usdg,
      abi: mockERC20Abi,
      functionName: "allowance",
      args: [w.address, spender],
    })) >= amount,
});

export const openFacility = (w: Wallet) => [
  tx("Open credit account", w, () => ({ address: d().factory, abi: facilityFactoryAbi as Abi, functionName: "openFacility" })),
];

export const borrow = (w: Wallet, f: Address, amount: bigint) => [tx("Borrow USDG", w, () => facilityCall(f, "borrow", [amount]))];

export const repayFromAccount = (w: Wallet, f: Address, amount: bigint) => [
  tx("Repay from account cash", w, () => facilityCall(f, "repay", [amount])),
];

export const repayFromWallet = (w: Wallet, f: Address, amount: bigint) => [
  approve(w, f, amount),
  tx("Repay from wallet", w, () => facilityCall(f, "repayFrom", [amount])),
];

export const addFunds = (w: Wallet, f: Address, amount: bigint) => [
  approve(w, f, amount),
  tx("Add USDG to account", w, () => facilityCall(f, "deposit", [amount])),
];

export const withdraw = (w: Wallet, f: Address, amount: bigint) => [
  tx("Withdraw to wallet", w, () => facilityCall(f, "withdrawSurplus", [amount, w.address])),
];

/** Owner sells part of a position back to USDG through the venue, with 1% slippage protection. */
export const sell = (w: Wallet, f: Address, token: Address, shares: bigint) => [
  tx("Sell", w, async () => {
    const quoted = await publicClient.readContract({
      address: d().venue,
      abi: demoVenueAbi,
      functionName: "quoteOut",
      args: [token, d().usdg, shares],
    });
    return facilityCall(f, "trade", [d().venue, token, d().usdg, shares, (quoted * 99n) / 100n]);
  }),
];

export const cashOut = (w: Wallet, f: Address) => [
  tx("Sell everything, repay and withdraw", w, () => ({
    address: d().risk,
    abi: riskManagerAbi as Abi,
    functionName: "cashOut",
    args: [f, w.address],
  })),
];

export interface MandateInput {
  tokens: Address[];
  maxPositionUsd: bigint; // 1e18
  expiresAt: bigint; // unix seconds
}

const setAgent = (w: Wallet, f: Address, agent: () => Address, m: MandateInput, label = "Appoint agent onchain") =>
  tx(label, w, () => facilityCall(f, "setAgent", [agent(), m.expiresAt, m.maxPositionUsd, m.tokens]));

/** Hire: derive the agent's key for this facility, appoint it onchain, then sign its instructions. */
export function hireAgent(w: Wallet, f: Address, agentId: string, m: MandateInput, instructions: string): Step[] {
  let agent: Address | null = null;
  let signed: Awaited<ReturnType<typeof signOwnerRequest>> | null = null;
  return [
    { label: "Prepare agent", kind: "call", run: async () => void (agent = await agents.addressFor(agentId, f)) },
    setAgent(w, f, () => agent!, m),
    {
      label: "Sign instructions",
      kind: "sign",
      run: async () =>
        void (signed = await signOwnerRequest(w, "hire-agent", f, { Agent: agentId, "Agent address": agent!, Instructions: instructions })),
    },
    { label: "Start agent", kind: "call", run: () => agents.hire(signed!) },
  ];
}

/** The agent is appointed onchain but the service isn't running it (e.g. the last step was interrupted). */
export function resumeAgent(w: Wallet, f: Address, agentId: string, agent: Address, instructions: string): Step[] {
  let signed: Awaited<ReturnType<typeof signOwnerRequest>> | null = null;
  return [
    {
      label: "Sign instructions",
      kind: "sign",
      run: async () =>
        void (signed = await signOwnerRequest(w, "hire-agent", f, { Agent: agentId, "Agent address": agent, Instructions: instructions })),
    },
    { label: "Start agent", kind: "call", run: () => agents.hire(signed!) },
  ];
}

export const updateMandate = (w: Wallet, f: Address, agent: Address, m: MandateInput) => [
  setAgent(w, f, () => agent, m, "Update mandate onchain"),
];

export const revokeAgent = (w: Wallet, f: Address) => [tx("Stop agent", w, () => facilityCall(f, "revokeAgent"))];

export function updateInstructions(w: Wallet, f: Address, instructions: string): Step[] {
  let signed: Awaited<ReturnType<typeof signOwnerRequest>> | null = null;
  return [
    {
      label: "Sign new instructions",
      kind: "sign",
      run: async () => void (signed = await signOwnerRequest(w, "update-instructions", f, { Instructions: instructions })),
    },
    { label: "Send to agent", kind: "call", run: () => agents.updateInstructions(signed!) },
  ];
}

export function disconnectBrokerage(w: Wallet, f: Address): Step[] {
  let signed: Awaited<ReturnType<typeof signOwnerRequest>> | null = null;
  return [
    {
      label: "Sign disconnect request",
      kind: "sign",
      run: async () => void (signed = await signOwnerRequest(w, "disconnect-brokerage", f, {})),
    },
    { label: "Disconnect at broker", kind: "call", run: () => broker.disconnect(signed!) },
  ];
}
