/**
 * Sign-in routes, matching what src/client/Auth.ts calls:
 *   GET  /auth/login/:provider?redirect_uri=   -> provider consent page
 *   GET  /auth/callback/:provider              -> back from the provider
 *   POST /auth/refresh                         -> { jwt, expiresIn }
 *   POST /auth/logout | /auth/revoke
 *   GET  /.well-known/jwks.json
 *
 * Every browser gets a session: /auth/refresh without a cookie mints a guest
 * player, and signing in later attaches the provider identity to that guest.
 */
import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import { REFRESH_TTL_MS } from "./accounts";
import {
  type ApiContext,
  clearCookie,
  readCookie,
  REFRESH_COOKIE,
  setCookie,
} from "./context";
import { JWT_TTL_SECONDS, signPlayerJwt } from "./keys";
import {
  authorizeUrl,
  exchangeCode,
  isProvider,
  newPkce,
  providerConfigured,
} from "./oauth";

const STATE_COOKIE = "ab_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;

function validRedirect(ctx: ApiContext, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return ctx.config.isAllowedOrigin(u.origin) ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Hands a login outcome back to the page as `#login=<result>` (read by
 * src/client/LoginResult.ts): "cancel" needs no message, anything else shows
 * the generic sign-in error.
 */
function withError(redirect: string, code: string): string {
  const u = new URL(redirect);
  const params = new URLSearchParams(u.hash.slice(1));
  params.set("login", code === "cancelled" ? "cancel" : "error");
  u.hash = params.toString();
  return u.toString();
}

export function registerAuthRoutes(app: Express, ctx: ApiContext) {
  const callbackUrl = (provider: string) =>
    `${ctx.config.issuer}/auth/callback/${provider}`;

  app.get("/.well-known/jwks.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ keys: [ctx.keys.publicJwk] });
  });

  app.get("/auth/login/:provider", (req: Request, res: Response) => {
    const { provider } = req.params as { provider: string };
    const redirect = validRedirect(ctx, req.query.redirect_uri);
    if (!redirect) {
      res.status(400).json({ error: "invalid redirect_uri" });
      return;
    }
    if (!isProvider(provider)) {
      res.redirect(withError(redirect, "unknown_provider"));
      return;
    }
    if (!providerConfigured(provider)) {
      res.redirect(withError(redirect, "provider_not_configured"));
      return;
    }
    const cookie = readCookie(req, REFRESH_COOKIE);
    const guest = cookie ? ctx.accounts.sessionPlayer(cookie) : null;
    const state = crypto.randomBytes(24).toString("base64url");
    const { verifier, challenge } = newPkce();
    const now = Date.now();
    ctx.db
      .prepare("DELETE FROM oauth_states WHERE created_at < ?")
      .run(now - STATE_TTL_MS);
    ctx.db
      .prepare(
        "INSERT INTO oauth_states (state, provider, verifier, redirect_uri, player_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(state, provider, verifier, redirect, guest?.id ?? null, now);
    // Binds the state to this browser (login CSRF protection).
    setCookie(res, ctx, STATE_COOKIE, state, STATE_TTL_MS);
    res.redirect(
      authorizeUrl(provider, {
        callbackUrl: callbackUrl(provider),
        state,
        challenge,
      }),
    );
  });

  app.get("/auth/callback/:provider", async (req: Request, res: Response) => {
    const { provider } = req.params as { provider: string };
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const row = ctx.db
      .prepare("SELECT * FROM oauth_states WHERE state = ?")
      .get(state) as
      | {
          provider: string;
          verifier: string;
          redirect_uri: string;
          player_id: string | null;
          created_at: number;
        }
      | undefined;
    if (row)
      ctx.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
    clearCookie(res, ctx, STATE_COOKIE);
    if (
      !row ||
      row.provider !== provider ||
      !isProvider(provider) ||
      readCookie(req, STATE_COOKIE) !== state ||
      Date.now() - row.created_at > STATE_TTL_MS
    ) {
      res
        .status(400)
        .send("Sign-in expired or was started elsewhere. Please try again.");
      return;
    }
    if (
      typeof req.query.error === "string" ||
      typeof req.query.code !== "string"
    ) {
      res.redirect(withError(row.redirect_uri, "cancelled"));
      return;
    }
    try {
      const profile = await exchangeCode(provider, {
        code: req.query.code,
        verifier: row.verifier,
        callbackUrl: callbackUrl(provider),
      });
      const player = ctx.accounts.loginWithIdentity(
        provider,
        profile,
        row.player_id,
      );
      if (player.role === "banned") {
        res.redirect(withError(row.redirect_uri, "banned"));
        return;
      }
      const old = readCookie(req, REFRESH_COOKIE);
      if (old) ctx.accounts.revokeSession(old);
      setCookie(
        res,
        ctx,
        REFRESH_COOKIE,
        ctx.accounts.createSession(player.id),
        REFRESH_TTL_MS,
      );
      res.redirect(row.redirect_uri);
    } catch (e) {
      console.warn(`[api] ${provider} login failed:`, e);
      res.redirect(withError(row.redirect_uri, "failed"));
    }
  });

  app.post("/auth/refresh", async (req: Request, res: Response) => {
    const cookie = readCookie(req, REFRESH_COOKIE);
    let session: { player: { id: string; role: string | null }; token: string };
    if (cookie) {
      const rotated = ctx.accounts.rotateSession(cookie);
      if (!rotated || rotated.player.role === "banned") {
        clearCookie(res, ctx, REFRESH_COOKIE);
        res.status(401).json({ error: "session expired" });
        return;
      }
      session = rotated;
    } else {
      const guest = ctx.accounts.createPlayer();
      session = { player: guest, token: ctx.accounts.createSession(guest.id) };
    }
    setCookie(res, ctx, REFRESH_COOKIE, session.token, REFRESH_TTL_MS);
    const jwt = await signPlayerJwt(ctx.keys, {
      playerId: session.player.id,
      issuer: ctx.config.issuer,
      audience: ctx.config.audience,
      role: session.player.role,
      provider: ctx.accounts.primaryProvider(session.player.id),
    });
    res.json({ jwt, expiresIn: JWT_TTL_SECONDS });
  });

  app.post("/auth/logout", (req: Request, res: Response) => {
    const cookie = readCookie(req, REFRESH_COOKIE);
    if (cookie) ctx.accounts.revokeSession(cookie);
    clearCookie(res, ctx, REFRESH_COOKIE);
    res.json({ ok: true });
  });

  app.post("/auth/revoke", (req: Request, res: Response) => {
    const cookie = readCookie(req, REFRESH_COOKIE);
    const player = cookie ? ctx.accounts.sessionPlayer(cookie) : null;
    if (player) ctx.accounts.revokeAllSessions(player.id);
    clearCookie(res, ctx, REFRESH_COOKIE);
    res.json({ ok: true });
  });
}
