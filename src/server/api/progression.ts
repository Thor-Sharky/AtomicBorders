/**
 * Levels and XP. Every finished game awards XP to the accounts that played;
 * levels unlock cosmetics (catalog.ts UNLOCKS) through `player.flares`.
 * Shapes follow ProgressSchema / ProgressionConfigSchema / GameXpResponseSchema
 * in packages/shared/src/ApiSchemas.ts, which the client already renders.
 *
 *   GET /public/progression/config        level curve, XP rules, reward track
 *   GET /users/@me/xp/:gameId             XP one game awarded the caller
 *   GET /public/player/:publicId/progress public level
 */
import { GameMode, GameType } from "@openfront/engine-api/game/GameTypes";
import type { Express, Request, Response } from "express";
import type { PlayerRow } from "./accounts";
import { flareCosmetic, flaresForLevel, UNLOCKS } from "./catalog";
import { type ApiContext, requirePlayer } from "./context";
import type { Db } from "./db";

export const MAX_LEVEL = 100;

/** XP needed to go from `level` to `level + 1`. */
export const xpToNext = (level: number) => 200 + 25 * (level - 1);

export const XP_RULES = {
  minAliveTicks: 600, // one minute alive before a game counts
  gameXp: 50,
  xpPerMinute: 10,
  timeCapMinutes: 30,
  ffaPlacementMax: 0,
  ffaWin: 150,
  fullLobbyHumans: 0,
  teamWin: 80,
  teamWinMinAlivePermille: 0,
  hvnWin: 80,
  firstGameOfDay: 0,
  featXp: 0,
  maxFeatsPerGame: 0,
  publicPermille: 1000,
  rankedPermille: 1000,
  privatePermille: 500,
  singleplayerPermille: 250,
  privateMinHumans: 2,
  privateGamesPerDay: 20,
  singleplayerGamesPerDay: 10,
};

const LEVELS = (() => {
  const out: { level: number; xpToNext: number; cumulativeXp: number }[] = [];
  let cumulative = 0;
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const next = level === MAX_LEVEL ? 0 : xpToNext(level);
    out.push({ level, xpToNext: next, cumulativeXp: cumulative });
    cumulative += next;
  }
  return out;
})();

/** Level position for a lifetime XP total. */
export function positionFor(lifetimeXp: number) {
  let level = 1;
  for (const l of LEVELS) if (lifetimeXp >= l.cumulativeXp) level = l.level;
  const row = LEVELS[level - 1];
  return {
    prestige: 0,
    level,
    xpInLevel: level === MAX_LEVEL ? 0 : lifetimeXp - row.cumulativeXp,
    xpForNext: row.xpToNext,
  };
}

const today = () => new Date().toISOString().slice(0, 10);

export function lifetimeXp(db: Db, playerId: string): number {
  const row = db
    .prepare("SELECT lifetime_xp FROM progress WHERE player_id = ?")
    .get(playerId) as { lifetime_xp: number } | undefined;
  return row?.lifetime_xp ?? 0;
}

function dailyCounts(db: Db, playerId: string) {
  const row = db
    .prepare(
      "SELECT singleplayer_games, private_games FROM xp_daily WHERE player_id = ? AND day = ?",
    )
    .get(playerId, today()) as
    | { singleplayer_games: number; private_games: number }
    | undefined;
  return {
    day: today(),
    singleplayerGames: row?.singleplayer_games ?? 0,
    privateGames: row?.private_games ?? 0,
    firstGameClaimed: true,
  };
}

/** ProgressSchema for a player. */
export function progressFor(db: Db, playerId: string) {
  const xp = lifetimeXp(db, playerId);
  return {
    ...positionFor(xp),
    lifetimeXp: xp,
    legend: false,
    canPrestige: false,
    daily: dailyCounts(db, playerId),
    subscriberPermille: 1000,
  };
}

interface XpInput {
  gameId: string;
  gameType: GameType;
  gameMode: GameMode;
  ranked: boolean;
  won: boolean;
  /** Ticks the player stayed alive (game length if they survived). */
  aliveTicks: number;
}

/**
 * Scores one game for one account and stores it. Returns false if the game
 * was already scored for them. Call inside the ingest transaction.
 */
export function awardGameXp(db: Db, playerId: string, g: XpInput): boolean {
  const scored = db
    .prepare("SELECT 1 FROM game_xp WHERE player_id = ? AND game_id = ?")
    .get(playerId, g.gameId);
  if (scored) return false;

  const daily = dailyCounts(db, playerId);
  const capped =
    (g.gameType === GameType.Singleplayer &&
      daily.singleplayerGames >= XP_RULES.singleplayerGamesPerDay) ||
    (g.gameType === GameType.Private &&
      !g.ranked &&
      daily.privateGames >= XP_RULES.privateGamesPerDay);

  const minutes = Math.min(
    XP_RULES.timeCapMinutes,
    Math.floor(g.aliveTicks / 600),
  );
  const counted = g.aliveTicks >= XP_RULES.minAliveTicks && !capped;
  const played = counted ? XP_RULES.gameXp : 0;
  const time = counted ? minutes * XP_RULES.xpPerMinute : 0;
  const win =
    counted && g.won
      ? g.gameMode === GameMode.FFA
        ? XP_RULES.ffaWin
        : XP_RULES.teamWin
      : 0;
  const subtotal = played + time + win;
  const gamePermille = g.ranked
    ? XP_RULES.rankedPermille
    : g.gameType === GameType.Public
      ? XP_RULES.publicPermille
      : g.gameType === GameType.Private
        ? XP_RULES.privatePermille
        : XP_RULES.singleplayerPermille;
  const total = Math.floor((subtotal * gamePermille) / 1000);

  const before = lifetimeXp(db, playerId);
  const breakdown = {
    leftEarly: false,
    played,
    time,
    placement: 0,
    win,
    firstGame: 0,
    feats: 0,
    subtotal,
    gamePermille,
    subscriberPermille: 1000,
    total,
  };
  db.prepare(
    "INSERT INTO game_xp (player_id, game_id, breakdown, before_xp, after_xp, eligible, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    playerId,
    g.gameId,
    JSON.stringify(breakdown),
    before,
    before + total,
    counted ? 1 : 0,
    Date.now(),
  );
  db.prepare(
    `INSERT INTO progress (player_id, lifetime_xp) VALUES (?, ?)
     ON CONFLICT (player_id) DO UPDATE SET lifetime_xp = lifetime_xp + excluded.lifetime_xp`,
  ).run(playerId, total);
  if (g.gameType === GameType.Singleplayer || g.gameType === GameType.Private) {
    db.prepare(
      `INSERT INTO xp_daily (player_id, day, singleplayer_games, private_games) VALUES (?, ?, ?, ?)
       ON CONFLICT (player_id, day) DO UPDATE SET
         singleplayer_games = singleplayer_games + excluded.singleplayer_games,
         private_games = private_games + excluded.private_games`,
    ).run(
      playerId,
      today(),
      g.gameType === GameType.Singleplayer ? 1 : 0,
      g.gameType === GameType.Private ? 1 : 0,
    );
  }
  return true;
}

/** The reward track: one entry per unlock, in level order. */
function trackFlares() {
  return UNLOCKS.map((u) => ({
    kind: "level",
    level: u.level,
    prestige: 0,
    flareName: u.flare,
    cosmetic: { ...flareCosmetic(u.flare), url: null },
  }));
}

export function registerProgressionRoutes(app: Express, ctx: ApiContext) {
  ctx.userExtras.push((player: PlayerRow) => {
    const progress = progressFor(ctx.db, player.id);
    return {
      progress,
      flares: flaresForLevel(progress.level),
      levelHidden: false,
    };
  });

  app.get("/public/progression/config", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      version: 1,
      maxLevel: MAX_LEVEL,
      maxPrestige: 0,
      levels: LEVELS,
      requireStatsAgreed: false,
      scoresSingleplayer: true,
      xp: XP_RULES,
      flares: trackFlares(),
    });
  });

  app.get(
    "/users/@me/xp/:gameId",
    requirePlayer(ctx),
    (req: Request, res: Response) => {
      const player = res.locals.player as PlayerRow;
      const gameId = String(req.params.gameId);
      const row = ctx.db
        .prepare(
          "SELECT breakdown, before_xp, after_xp, eligible FROM game_xp WHERE player_id = ? AND game_id = ?",
        )
        .get(player.id, gameId) as
        | {
            breakdown: string;
            before_xp: number;
            after_xp: number;
            eligible: number;
          }
        | undefined;
      if (!row) {
        res.status(404).json({ error: "not scored yet" });
        return;
      }
      if (!row.eligible) {
        res.json({ gameId, eligible: false, reason: "not_counted" });
        return;
      }
      const before = positionFor(row.before_xp);
      const after = positionFor(row.after_xp);
      const levelsReached: { prestige: number; level: number }[] = [];
      for (let l = before.level + 1; l <= after.level; l++) {
        levelsReached.push({ prestige: 0, level: l });
      }
      const flares = UNLOCKS.filter(
        (u) => u.level > before.level && u.level <= after.level,
      ).map((u) => ({
        kind: "level",
        prestige: 0,
        level: u.level,
        flareId: u.flare,
        flareName: u.flare,
        cosmetic: { ...flareCosmetic(u.flare), url: null },
      }));
      res.json({
        gameId,
        eligible: true,
        breakdown: JSON.parse(row.breakdown),
        before,
        after: {
          ...after,
          lifetimeXp: row.after_xp,
          legend: false,
          canPrestige: false,
        },
        levelsReached,
        rewards: [],
        flares,
      });
    },
  );

  app.get(
    "/public/player/:publicId/progress",
    (req: Request, res: Response) => {
      const player = ctx.accounts.getPlayerByPublicId(
        String(req.params.publicId),
      );
      if (!player) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const p = progressFor(ctx.db, player.id);
      res.json({
        prestige: 0,
        level: p.level,
        lifetimeXp: p.lifetimeXp,
        legend: false,
        xpInLevel: p.xpInLevel,
        xpForNext: p.xpForNext,
      });
    },
  );
}
