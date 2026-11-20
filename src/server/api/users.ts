/**
 * GET /users/@me — the signed-in player's account, in the shape of
 * UserMeResponseSchema (packages/shared/src/ApiSchemas.ts). Called by the
 * client with its JWT, and by game servers on join (src/server/jwt.ts) with
 * the player's JWT plus x-api-key.
 *
 * Paid features (subscriptions, currency, store) don't exist in Atomic
 * Borders, so those fields are sent empty.
 */
import type { Express, Request, Response } from "express";
import type { PlayerRow } from "./accounts";
import { type ApiContext, requirePlayer } from "./context";

export function buildUserMe(ctx: ApiContext, player: PlayerRow) {
  const user: Record<string, unknown> = {};
  for (const id of ctx.accounts.identities(player.id)) {
    user[id.provider] = JSON.parse(id.profile);
  }
  const linked = Object.keys(user).length > 0;
  const playerObj: Record<string, unknown> = {
    publicId: player.public_id,
    adfree: true,
    // No paid tiers: any signed-in account may list a custom lobby.
    canCreatePublicLobbies: linked,
    trustTier: linked && player.role !== "flagged" ? "trusted" : "untrusted",
    username: player.username,
    achievements: { singleplayerMap: [], player: [] },
    friends: [],
    subscription: null,
    subscriptions: [],
    pastDueSubscription: null,
    creator: null,
    clans: [],
    clanRequests: [],
  };
  for (const fn of ctx.userExtras) Object.assign(playerObj, fn(player));
  return {
    user,
    ban:
      player.role === "banned"
        ? { category: "other", reason: null, expiresAt: null }
        : null,
    noticesSeen: [],
    pendingMessages: [],
    player: playerObj,
  };
}

export function registerUserRoutes(app: Express, ctx: ApiContext) {
  app.get("/users/@me", requirePlayer(ctx), (_req: Request, res: Response) => {
    res.json(buildUserMe(ctx, res.locals.player as PlayerRow));
  });

  // Notices / messages the client marks as seen: nothing to persist yet.
  app.post("/users/@me/notices", requirePlayer(ctx), (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/users/@me/messages/seen", requirePlayer(ctx), (_req, res) => {
    res.json({ ok: true });
  });
}
