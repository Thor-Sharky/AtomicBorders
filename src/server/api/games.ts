/**
 * Match results: archiving, replays, player profiles and the leaderboard.
 *
 *   POST /game/:id                      game server, x-api-key (Archive.ts)
 *   GET  /game/:id                      replay record (JoinLobbyModal)
 *   POST /archive_singleplayer_game     client, JWT (LocalServer.ts)
 *   GET  /public/player/:publicId       PlayerProfileSchema
 *   GET  /public/player/:publicId/games PublicPlayerGamesResponseSchema
 *   GET  /leaderboard/ranked?page=      RankedLeaderboardResponseSchema
 *   GET  /users/@me/ffa_rank_position   FfaRankPositionResponseSchema
 */
import {
  GameMode,
  GameType,
  HumansVsNations,
} from "@openfront/engine-api/game/GameTypes";
import { replacer } from "@openfront/shared/SharedUtil";
import {
  type GameRecord,
  GameRecordSchema,
  PartialAnalyticsRecordSchema,
} from "@openfront/shared/WireSchemas";
import express, { type Express, type Request, type Response } from "express";
import zlib from "node:zlib";
import { z } from "zod";
import type { PlayerRow } from "./accounts";
import { type ApiContext, requireApiKey, requirePlayer } from "./context";
import { tx } from "./db";
import { applyMatch, type Ladder, type RatingRow } from "./ratings";

const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const BIG_BODY = express.json({ limit: "64mb" });

/** Clients (by clientID) that the record says won. */
function winningClients(
  record: GameRecord | z.infer<typeof PartialAnalyticsRecordSchema>,
): Set<string> {
  const w = record.info.winner;
  if (!w) return new Set();
  // ["player", clientID, ...] or ["team"|"nation", name, ...clientIDs]
  return new Set(w[0] === "player" ? w.slice(1) : w.slice(2));
}

/** Stores a game and its per-player rows; returns false if already archived. */
export function ingestGame(
  ctx: ApiContext,
  record: GameRecord | z.infer<typeof PartialAnalyticsRecordSchema>,
  opts: { rated: boolean },
): boolean {
  const { info } = record;
  const cfg = info.config;
  const winners = winningClients(record);
  return tx(ctx.db, () => {
    const exists = ctx.db
      .prepare("SELECT 1 FROM games WHERE game_id = ?")
      .get(info.gameID);
    if (exists) return false;
    ctx.db
      .prepare(
        `INSERT INTO games (game_id, start_ms, end_ms, duration_s, map, mode, type,
           difficulty, player_teams, ranked_type, total_players, has_winner, record)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        info.gameID,
        info.start,
        info.end,
        Math.max(0, Math.round(info.duration)),
        String(cfg.gameMap),
        cfg.gameMode,
        cfg.gameType,
        cfg.difficulty,
        cfg.playerTeams === undefined ? null : String(cfg.playerTeams),
        cfg.rankedType ?? "",
        info.players.length,
        info.winner ? 1 : 0,
        zlib.gzipSync(JSON.stringify(record, replacer)),
      );
    const insertPlayer = ctx.db.prepare(
      `INSERT INTO game_players (game_id, client_id, player_id, username, clan_tag, team, won)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const rated: { id: string; won: boolean }[] = [];
    for (const p of info.players) {
      const account =
        p.persistentID && ctx.accounts.getPlayer(p.persistentID)
          ? p.persistentID
          : null;
      const won = winners.has(p.clientID);
      insertPlayer.run(
        info.gameID,
        p.clientID,
        account,
        p.username,
        p.clanTag ?? null,
        p.team ?? null,
        won ? 1 : 0,
      );
      if (account) rated.push({ id: account, won });
    }

    if (opts.rated && info.winner) {
      const ladder = ladderFor(cfg.gameType, cfg.gameMode, cfg.rankedType);
      if (ladder) {
        applyMatch(
          ctx.db,
          ladder,
          rated.filter((r) => r.won).map((r) => r.id),
          rated.filter((r) => !r.won).map((r) => r.id),
        );
      }
    }
    return true;
  });
}

function ladderFor(
  type: GameType,
  mode: GameMode,
  rankedType: string | undefined,
): Ladder | null {
  if (rankedType === "1v1" || rankedType === "2v2") return rankedType;
  if (type === GameType.Public && mode === GameMode.FFA) return "ffa";
  return null;
}

function readRecord(ctx: ApiContext, gameId: string): GameRecord | null {
  const row = ctx.db
    .prepare("SELECT record FROM games WHERE game_id = ?")
    .get(gameId) as { record: Uint8Array } | undefined;
  if (!row) return null;
  return JSON.parse(zlib.gunzipSync(row.record).toString("utf8"));
}

// --- profile ----------------------------------------------------------------

type StatsMode = GameMode | typeof HumansVsNations;

function statsMode(mode: string, playerTeams: string | null): StatsMode {
  if (mode === GameMode.Team && playerTeams === HumansVsNations) {
    return HumansVsNations;
  }
  return mode === GameMode.Team ? GameMode.Team : GameMode.FFA;
}

const leaf = (wins: number, total: number) => ({
  wins: String(wins),
  losses: String(total - wins),
  total: String(total),
  stats: {},
});

function statsTree(ctx: ApiContext, playerId: string) {
  const rows = ctx.db
    .prepare(
      `SELECT g.type, g.mode, g.player_teams, g.difficulty, g.ranked_type,
              COUNT(*) AS total, SUM(gp.won) AS wins
         FROM game_players gp JOIN games g ON g.game_id = gp.game_id
        WHERE gp.player_id = ? AND g.has_winner = 1
        GROUP BY g.type, g.mode, g.player_teams, g.difficulty, g.ranked_type`,
    )
    .all(playerId) as {
    type: string;
    mode: string;
    player_teams: string | null;
    difficulty: string;
    ranked_type: string;
    total: number;
    wins: number;
  }[];
  const tree: Record<
    string,
    Record<string, Record<string, ReturnType<typeof leaf>>>
  > = {};
  const ranked: Record<string, ReturnType<typeof leaf>> = {};
  const merge = (
    a: ReturnType<typeof leaf> | undefined,
    w: number,
    t: number,
  ) => leaf(Number(a?.wins ?? 0) + w, Number(a?.total ?? 0) + t);
  for (const r of rows) {
    if (r.ranked_type) {
      ranked[r.ranked_type] = merge(ranked[r.ranked_type], r.wins, r.total);
      continue;
    }
    const mode = statsMode(r.mode, r.player_teams);
    const byMode = (tree[r.type] ??= {});
    const byDiff = (byMode[mode] ??= {});
    byDiff[r.difficulty] = merge(byDiff[r.difficulty], r.wins, r.total);
  }
  return { ...tree, ...(Object.keys(ranked).length ? { Ranked: ranked } : {}) };
}

function ratingOut(r: RatingRow | undefined) {
  return r ? { elo: Math.round(r.rating) } : undefined;
}

function playerRatings(ctx: ApiContext, playerId: string) {
  const rows = ctx.db
    .prepare("SELECT * FROM ratings WHERE player_id = ?")
    .all(playerId) as unknown as RatingRow[];
  const by = (l: Ladder) => rows.find((r) => r.ladder === l);
  const ffa = by("ffa");
  return {
    oneVone: ratingOut(by("1v1")),
    twoVtwo: ratingOut(by("2v2")),
    ffa: ffa
      ? {
          elo: Math.round(ffa.rating),
          games: ffa.games,
          wins: ffa.wins,
          peak: Math.round(ffa.peak),
        }
      : undefined,
  };
}

// --- leaderboard ------------------------------------------------------------

function ladderPage(ctx: ApiContext, ladder: Ladder, page: number) {
  const rows = ctx.db
    .prepare(
      `SELECT r.*, p.public_id, p.username FROM ratings r
         JOIN players p ON p.id = r.player_id
        WHERE r.ladder = ? AND (p.role IS NULL OR p.role != 'banned')
        ORDER BY r.rating DESC, r.games DESC
        LIMIT ? OFFSET ?`,
    )
    .all(ladder, PAGE_SIZE, (page - 1) * PAGE_SIZE) as unknown as (RatingRow & {
    public_id: string;
    username: string | null;
  })[];
  return rows.map((r, i) => ({
    rank: (page - 1) * PAGE_SIZE + i + 1,
    elo: Math.round(r.rating),
    peakElo: Math.round(r.peak),
    wins: r.wins,
    losses: r.losses,
    total: r.games,
    public_id: r.public_id,
    accountUsername: r.username,
  }));
}

export function registerGameRoutes(app: Express, ctx: ApiContext) {
  ctx.userExtras.push((player: PlayerRow) => ({
    leaderboard: playerRatings(ctx, player.id),
  }));

  app.post(
    "/game/:id",
    requireApiKey(ctx),
    BIG_BODY,
    (req: Request, res: Response) => {
      const parsed = GameRecordSchema.safeParse(req.body);
      if (!parsed.success || parsed.data.info.gameID !== req.params.id) {
        res.status(400).json({
          error: "invalid game record",
          details: parsed.success
            ? "gameID does not match the URL"
            : z.prettifyError(parsed.error),
        });
        return;
      }
      const stored = ingestGame(ctx, parsed.data, { rated: true });
      res.status(stored ? 200 : 409).json({ ok: stored });
    },
  );

  app.get("/game/:id", (req: Request, res: Response) => {
    const record = readRecord(ctx, String(req.params.id));
    if (!record) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // Never hand out players' persistent ids.
    for (const p of record.info.players) p.persistentID = null;
    delete record.info.reports;
    res.json(record);
  });

  app.post(
    "/archive_singleplayer_game",
    requirePlayer(ctx),
    BIG_BODY,
    (req: Request, res: Response) => {
      const parsed = PartialAnalyticsRecordSchema.passthrough().safeParse(
        req.body,
      );
      if (
        !parsed.success ||
        parsed.data.info.config.gameType !== GameType.Singleplayer
      ) {
        res.status(400).json({ error: "invalid record" });
        return;
      }
      // Client-reported, so it counts toward personal stats only, never a
      // ladder. Only the uploader's own row is attributed to their account.
      const player = res.locals.player as PlayerRow;
      const record = parsed.data;
      for (const p of record.info.players) {
        p.persistentID = p.persistentID === player.id ? player.id : null;
      }
      ingestGame(ctx, record, { rated: false });
      res.json({ ok: true });
    },
  );

  app.get("/public/player/:publicId", (req: Request, res: Response) => {
    const player = ctx.accounts.getPlayerByPublicId(
      String(req.params.publicId),
    );
    if (!player || player.role === "banned") {
      res.status(404).json({ error: "not found" });
      return;
    }
    const discord = ctx.accounts
      .identities(player.id)
      .find((i) => i.provider === "discord");
    res.json({
      createdAt: new Date(player.created_at).toISOString(),
      user: discord ? JSON.parse(discord.profile) : undefined,
      username: player.username,
      stats: statsTree(ctx, player.id),
      clans: [],
      displayClanTag: null,
      ffaRating: null,
      ...Object.assign({}, ...ctx.profileExtras.map((fn) => fn(player))),
    });
  });

  app.get("/public/player/:publicId/games", (req: Request, res: Response) => {
    const player = ctx.accounts.getPlayerByPublicId(
      String(req.params.publicId),
    );
    if (!player) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const cursor = Number(req.query.cursor ?? 0) || Number.MAX_SAFE_INTEGER;
    const rows = ctx.db
      .prepare(
        `SELECT g.*, gp.username, gp.clan_tag, gp.won FROM game_players gp
           JOIN games g ON g.game_id = gp.game_id
          WHERE gp.player_id = ? AND g.start_ms < ?
          ORDER BY g.start_ms DESC LIMIT ?`,
      )
      .all(player.id, cursor, PAGE_SIZE + 1) as {
      game_id: string;
      start_ms: number;
      duration_s: number;
      map: string;
      mode: string;
      type: string;
      player_teams: string | null;
      ranked_type: string;
      total_players: number;
      has_winner: number;
      username: string;
      clan_tag: string | null;
      won: number;
    }[];
    const page = rows.slice(0, PAGE_SIZE);
    res.json({
      results: page.map((g) => ({
        gameId: g.game_id,
        start: new Date(g.start_ms).toISOString(),
        durationSeconds: g.duration_s,
        map: g.map,
        mode: g.mode,
        type: g.type,
        playerTeams: g.player_teams,
        rankedType: g.ranked_type,
        result: !g.has_winner ? "incomplete" : g.won ? "victory" : "defeat",
        totalPlayers: g.total_players,
        username: g.username,
        clanTag: g.clan_tag,
        ffaRating: null,
      })),
      nextCursor:
        rows.length > PAGE_SIZE ? String(page[page.length - 1].start_ms) : null,
    });
  });

  app.get("/leaderboard/ranked", (req: Request, res: Response) => {
    const page = Number(req.query.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) {
      res
        .status(400)
        .json({ message: `Page must be between 1 and ${MAX_PAGES}` });
      return;
    }
    const out = {
      "1v1": ladderPage(ctx, "1v1", page),
      "2v2": ladderPage(ctx, "2v2", page),
      ffa: ladderPage(ctx, "ffa", page),
    };
    if (
      page > 1 &&
      !out["1v1"].length &&
      !out["2v2"].length &&
      !out.ffa.length
    ) {
      res
        .status(400)
        .json({ message: `Page must be between 1 and ${page - 1}` });
      return;
    }
    res.json(out);
  });

  app.get(
    "/users/@me/ffa_rank_position",
    requirePlayer(ctx),
    (_req: Request, res: Response) => {
      const player = res.locals.player as PlayerRow;
      const mine = ctx.db
        .prepare(
          "SELECT rating FROM ratings WHERE player_id = ? AND ladder = 'ffa'",
        )
        .get(player.id) as { rating: number } | undefined;
      if (!mine) {
        res.json({ position: null });
        return;
      }
      const above = ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM ratings WHERE ladder = 'ffa' AND rating > ?",
        )
        .get(mine.rating) as { n: number };
      res.json({ position: above.n + 1 });
    },
  );
}
