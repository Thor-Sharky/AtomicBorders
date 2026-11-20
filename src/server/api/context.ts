import { base64urlToUuid } from "@openfront/shared/Base64";
/** Shared request plumbing for the Atomic Borders API. */
import type { NextFunction, Request, Response } from "express";
import { importJWK, jwtVerify } from "jose";
import { Accounts, type PlayerRow } from "./accounts";
import type { Db } from "./db";
import type { SigningKeys } from "./keys";

export interface ApiConfig {
  /** This API's public origin; also the JWT `iss` (ServerEnv.jwtIssuer()). */
  issuer: string;
  /** The JWT `aud` (the site domain, ServerEnv.jwtAudience()). */
  audience: string;
  /** Shared secret game servers send as x-api-key. Empty disables those routes. */
  apiKey: string;
  /** Origins (scheme://host[:port]) allowed for CORS and login redirects. */
  isAllowedOrigin: (origin: string) => boolean;
}

export interface ApiContext {
  db: Db;
  keys: SigningKeys;
  accounts: Accounts;
  config: ApiConfig;
  /** Fields later modules add to /users/@me `player` (ratings, clans). */
  userExtras: ((player: PlayerRow) => Record<string, unknown>)[];
}

export const REFRESH_COOKIE = "ab_refresh";

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

export function setCookie(
  res: Response,
  ctx: ApiContext,
  name: string,
  value: string,
  maxAgeMs: number,
) {
  const secure = ctx.config.issuer.startsWith("https://") ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`,
  );
}

export function clearCookie(res: Response, ctx: ApiContext, name: string) {
  setCookie(res, ctx, name, "", 0);
}

/** CORS for the game page: exact allowed origin, with credentials. */
export function cors(ctx: ApiContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && ctx.config.isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "authorization, content-type, x-api-key",
        );
        res.setHeader("Access-Control-Max-Age", "600");
        res.status(204).end();
        return;
      }
    } else if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

let publicKeyCache: { kid: string; key: CryptoKey } | null = null;

/** The signed-in player from `Authorization: Bearer <jwt>`, or null. */
export async function bearerPlayer(
  req: Request,
  ctx: ApiContext,
): Promise<PlayerRow | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  try {
    if (publicKeyCache?.kid !== ctx.keys.kid) {
      publicKeyCache = {
        kid: ctx.keys.kid,
        key: (await importJWK(ctx.keys.publicJwk, "EdDSA")) as CryptoKey,
      };
    }
    const { payload } = await jwtVerify(header.slice(7), publicKeyCache.key, {
      algorithms: ["EdDSA"],
      issuer: ctx.config.issuer,
      audience: ctx.config.audience,
    });
    if (typeof payload.sub !== "string") return null;
    const player = ctx.accounts.getPlayer(base64urlToUuid(payload.sub));
    if (!player || player.role === "banned") return null;
    return player;
  } catch {
    return null;
  }
}

/** Route guard: 401 unless a valid bearer JWT names a live player. */
export function requirePlayer(ctx: ApiContext) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const player = await bearerPlayer(req, ctx);
    if (!player) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.locals.player = player;
    next();
  };
}

/** Route guard for game-server calls: x-api-key must match API_KEY. */
export function requireApiKey(ctx: ApiContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers["x-api-key"];
    if (!ctx.config.apiKey || key !== ctx.config.apiKey) {
      res.status(401).json({ error: "bad api key" });
      return;
    }
    next();
  };
}
