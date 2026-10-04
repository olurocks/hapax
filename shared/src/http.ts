import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type Handler = (body: any) => Promise<unknown> | unknown;
export type Routes = Record<string, Handler>; // key: "GET /state", "POST /revoke"

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

/** Minimal JSON API with permissive CORS, for the demo services and the operator console. */
export function serve(name: string, port: number, routes: Routes) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();

    const key = `${req.method} ${(req.url ?? "/").split("?")[0]}`;
    const handler = routes[key];
    if (!handler) return res.writeHead(404, { "content-type": "application/json" }).end(json({ error: `No route ${key}` }));

    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const result = await handler(raw ? JSON.parse(raw) : {});
      res.writeHead(200, { "content-type": "application/json" }).end(json(result ?? { ok: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${name}] ${key} failed: ${message}`);
      res.writeHead(400, { "content-type": "application/json" }).end(json({ error: message }));
    }
  });
  server.listen(port, () => console.log(`[${name}] listening on http://localhost:${port}`));
  return server;
}

export const log = (name: string) => (...args: unknown[]) =>
  console.log(new Date().toISOString().slice(11, 19), `[${name}]`, ...args);
