// The demo services: broker simulator, market operator, AI agent.
const env = import.meta.env;
export const services = {
  broker: env.VITE_BROKER_URL ?? "http://localhost:8787",
  market: env.VITE_MARKET_URL ?? "http://localhost:8788",
  agent: env.VITE_AGENT_URL ?? "http://localhost:8789",
};

export async function api<T = unknown>(service: keyof typeof services, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(services[service] + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`The ${service} service is not reachable at ${services[service]}. Start it with "pnpm ${service}".`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${service} returned ${res.status}`);
  return json as T;
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
  source: "claude" | "rules" | "manual";
  reasoning: string;
  trades: AgentTrade[];
}
export interface AgentHistory {
  agent: string;
  facility: string;
  model: string;
  instructions: string;
  history: AgentDecision[];
}
