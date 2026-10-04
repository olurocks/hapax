import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** What a handler gets besides the parsed body. */
export interface Ctx {
  query: Record<string, string>;
  params: Record<string, string>;
  headers: IncomingMessage["headers"];
}
export type Handler = (body: any, ctx: Ctx) => Promise<unknown> | unknown;
/** key: "GET /state", "POST /revoke", "GET /agents/:id". Routes under /admin/ require the admin token. */
export type Routes = Record<string, Handler>;

/** A non-JSON response: an HTML page or a redirect. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly headers: Record<string, string> = {},
  ) {}
}
export const html = (body: string, status = 200) => new Reply(status, body, { "content-type": "text/html; charset=utf-8" });
export const redirect = (location: string) => new Reply(302, "", { location });

/** Thrown by a handler to answer with a specific status instead of 400. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

/**
 * Shared secret for the demo control plane. Every service reads the same .env, so the default works locally
 * without configuration; set ADMIN_TOKEN anywhere the services are reachable by others.
 */
export const adminToken = () => process.env.ADMIN_TOKEN || "hapax-local-admin";

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

function parseBody(raw: string, type: string | undefined) {
  if (!raw) return {};
  if (type?.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  return JSON.parse(raw);
}

/**
 * Minimal JSON API with permissive CORS. Routes whose path starts with /admin/ are the demo control plane:
 * they need `x-admin-token`, and only the control service calls them.
 */
export function serve(name: string, port: number, routes: Routes, opts: { host?: string } = {}) {
  const table = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(" ");
    return { method, pattern, handler };
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    let found: { handler: Handler; params: Record<string, string> } | null = null;
    for (const r of table) {
      if (r.method !== req.method) continue;
      const params = match(r.pattern, path);
      if (params) {
        found = { handler: r.handler, params };
        break;
      }
    }
    const key = `${req.method} ${path}`;
    if (!found) return res.writeHead(404, { "content-type": "application/json" }).end(json({ error: `No route ${key}` }));
    if (path.startsWith("/admin/") && req.headers["x-admin-token"] !== adminToken()) {
      return res.writeHead(401, { "content-type": "application/json" }).end(json({ error: "Admin token required" }));
    }

    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const ctx: Ctx = { query: Object.fromEntries(url.searchParams), params: found.params, headers: req.headers };
      const result = await found.handler(parseBody(raw, req.headers["content-type"]), ctx);
      if (result instanceof Reply) return res.writeHead(result.status, result.headers).end(result.body);
      res.writeHead(200, { "content-type": "application/json" }).end(json(result ?? { ok: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof HttpError ? err.status : 400;
      console.error(`[${name}] ${key} failed: ${message}`);
      res.writeHead(status, { "content-type": "application/json" }).end(json({ error: message }));
    }
  });
  server.listen(port, opts.host, () => console.log(`[${name}] listening on http://${opts.host ?? "localhost"}:${port}`));
  return server;
}

/** Call another service's admin route (used by the control service). */
export async function adminCall<T = unknown>(base: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-admin-token": adminToken() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Service at ${base} is not reachable`);
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((out as { error?: string }).error ?? `${base}${path} returned ${res.status}`);
  return out as T;
}

export const log = (name: string) => (...args: unknown[]) =>
  console.log(new Date().toISOString().slice(11, 19), `[${name}]`, ...args);
