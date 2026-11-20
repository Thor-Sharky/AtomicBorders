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
import { registerGameRoutes } from "./games";
import { loadSigningKeys, type SigningKeys } from "./keys";
import { registerUserRoutes } from "./users";

const BIG_BODY_PATHS = /^\/(game\/[^/]+|archive_singleplayer_game)$/;

export function createApiApp(
  db: Db,
  keys: SigningKeys,
  config: ApiConfig,
): { app: Express; ctx: ApiContext } {
  const ctx: ApiContext = {
    db,
    keys,
    accounts: new Accounts(db),
    config,
    userExtras: [],
  };
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(cors(ctx));
  // Game records can be large; their routes parse with a bigger limit.
  const smallJson = express.json({ limit: "1mb" });
  app.use((req, res, next) =>
    BIG_BODY_PATHS.test(req.path) ? next() : smallJson(req, res, next),
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  registerAuthRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerGameRoutes(app, ctx);

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
