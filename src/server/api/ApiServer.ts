/**
 * The Atomic Borders API: accounts, sign-in, stats, leaderboards, clans and
 * ranked. It replaces OpenFront's closed-source API and speaks the same
 * contract, so the client (getApiBase) and game server (ServerEnv.jwtIssuer)
 * reach it unchanged: http://localhost:8787 in dev, https://api.<domain> in
 * production (proxy that host to API_PORT).
 *
 * Started by the master process (Master.ts). See docs/AtomicBordersApi.md.
 */
import express, { type Express } from "express";
import http from "node:http";
import path from "node:path";
import { Accounts } from "./accounts";
import { registerAuthRoutes } from "./auth";
import { type ApiConfig, type ApiContext, cors } from "./context";
import { type Db, openDb } from "./db";
import { loadSigningKeys, type SigningKeys } from "./keys";
import { registerUserRoutes } from "./users";

export function createApiApp(
  db: Db,
  keys: SigningKeys,
  config: ApiConfig,
): { app: Express; ctx: ApiContext } {
  const ctx: ApiContext = { db, keys, accounts: new Accounts(db), config };
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(cors(ctx));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  registerAuthRoutes(app, ctx);
  registerUserRoutes(app, ctx);

  // Everything else OpenFront's API offered (store, cosmetics, news, Steam...)
  // doesn't exist here: answer fast so the client shows "unavailable".
  app.use((_req, res) => {
    res.status(404).json({ error: "not available in Atomic Borders" });
  });
  return { app, ctx };
}

/** Origins allowed to use the API: the site and its subdomains, or localhost in dev. */
export function originMatcher(domain: string): (origin: string) => boolean {
  return (origin: string) => {
    try {
      const u = new URL(origin);
      if (domain === "localhost") {
        return (
          (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
          (u.protocol === "http:" || u.protocol === "https:")
        );
      }
      return (
        u.protocol === "https:" &&
        (u.hostname === domain || u.hostname.endsWith(`.${domain}`))
      );
    } catch {
      return false;
    }
  };
}

export async function startApiServer(opts: {
  issuer: string;
  audience: string;
}): Promise<http.Server | null> {
  if (process.env.API_ENABLED === "false") return null;
  const port = Number(process.env.API_PORT ?? 8787);
  const dataDir = path.resolve(process.env.DATA_DIR ?? "data");
  const db = openDb(path.join(dataDir, "atomic.db"));
  const keys = await loadSigningKeys(dataDir);
  const { app } = createApiApp(db, keys, {
    issuer: opts.issuer,
    audience: opts.audience,
    apiKey: process.env.API_KEY ?? "",
    isAllowedOrigin: originMatcher(opts.audience),
  });
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.once("error", (e) => {
      console.error(`[api] could not listen on ${port}:`, e);
      resolve(null);
    });
    server.listen(port, () => {
      console.log(`[api] Atomic Borders API on :${port} (data in ${dataDir})`);
      resolve(server);
    });
  });
}
