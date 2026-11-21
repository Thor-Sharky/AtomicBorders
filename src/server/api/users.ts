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

/** Account name as displayed, with the parts the client's username UI reads. */
function usernameFields(ctx: ApiContext, player: PlayerRow) {
  const name = ctx.accounts.accountName(player);
  if (name === null) {
    return {
      username: player.username,
      usernameBase: player.username,
      usernameDiscriminator: null,
      usernameStatus: "unclaimed",
    };
  }
  return {
    username: name.username,
    usernameBase: name.base,
    usernameDiscriminator: name.discriminator,
    usernameStatus: "indefinite",
  };
}

// Same rule as the client's AccountUsernameSchema (validations/username.ts).
const ACCOUNT_NAME_RE = /^[a-zA-Z0-9_-]+( [a-zA-Z0-9_-]+)*$/;

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
    // Verified names are free for signed-in accounts ("indefinite"); a name
    // someone else claimed first shows suffixed (accounts.accountName).
    ...usernameFields(ctx, player),
    nextUsernameChangeAt: null,
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

  // PUT /users/@me/username: rename (src/client/Api.ts updateUsername).
  app.put(
    "/users/@me/username",
    requirePlayer(ctx),
    (req: Request, res: Response) => {
      const player = res.locals.player as PlayerRow;
      if (ctx.accounts.identities(player.id).length === 0) {
        res
          .status(400)
          .json({ reason: "Sign in with Discord or Google to set a name." });
        return;
      }
      const raw =
        typeof req.body?.username === "string" ? req.body.username.trim() : "";
      if (raw.length < 3 || raw.length > 20 || !ACCOUNT_NAME_RE.test(raw)) {
        res.status(400).json({ reason: "Use 3-20 letters, numbers, _ or -." });
        return;
      }
      if (
        ctx.accounts.nameHeldByOther(raw, player.id) &&
        req.body?.acceptSuffixed !== true
      ) {
        res.status(409).json({ code: "BARE_NAME_TAKEN", base: raw });
        return;
      }
      ctx.accounts.setUsername(player.id, raw);
      const name = ctx.accounts.accountName({ ...player, username: raw })!;
      res.json({
        username: name.username,
        base: name.base,
        discriminator: name.discriminator,
        usernameStatus: "indefinite",
        nextUsernameChangeAt: null,
        bareClaim: name.bare ? "claimed" : "unavailable",
      });
    },
  );

  // Notices / messages the client marks as seen: nothing to persist yet.
  app.post("/users/@me/notices", requirePlayer(ctx), (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/users/@me/messages/seen", requirePlayer(ctx), (_req, res) => {
    res.json({ ok: true });
  });
}
