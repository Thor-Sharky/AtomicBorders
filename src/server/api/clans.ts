/**
 * Clans, matching src/client/ClanApi.ts and ClanApiSchemas.ts.
 *
 * Roles: leader (one per clan) > officer > member. Officers manage members
 * and requests; only the leader edits roles, transfers or disbands. Clan
 * currency (funds, donations, boosts) is an OpenFront paid feature and isn't
 * offered here: those routes fall through to the API's 404.
 *
 * Atomic Borders adds POST /clans (create), which OpenFront's client lacks.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { PlayerRow } from "./accounts";
import { type ApiContext, requireApiKey, requirePlayer } from "./context";
import { tx } from "./db";

export const MAX_MEMBERSHIPS = 3;
const MAX_PAGE = 100;
const LEADERBOARD_DAYS = 30;
const GAMES_PAGE = 25;

type Role = "leader" | "officer" | "member";
const RANK: Record<Role, number> = { member: 0, officer: 1, leader: 2 };

interface ClanRow {
  tag: string;
  name: string;
  description: string;
  discord_url: string | null;
  is_open: number;
  created_at: number;
}

const TagSchema = z.string().regex(/^[a-zA-Z0-9]{2,5}$/);
const NameSchema = z.string().trim().min(2).max(35);
const DescriptionSchema = z.string().trim().max(200);
const DiscordUrlSchema = z
  .string()
  .trim()
  .max(255)
  .regex(/^https:\/\/(discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+$/);

const CreateSchema = z.object({
  tag: TagSchema,
  name: NameSchema,
  description: DescriptionSchema.default(""),
  isOpen: z.boolean().default(true),
});
const PatchSchema = z.object({
  name: NameSchema.optional(),
  description: DescriptionSchema.optional(),
  isOpen: z.boolean().optional(),
  discordUrl: z.union([DiscordUrlSchema, z.literal(""), z.null()]).optional(),
});
const TargetSchema = z.object({ targetPublicId: z.string().min(1) });
const BanSchema = TargetSchema.extend({
  reason: z.string().trim().max(200).optional(),
});

const iso = (ms: number) => new Date(ms).toISOString();

function pageParams(req: Request) {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const limit = Math.min(
    MAX_PAGE,
    Math.max(1, Number(req.query.limit ?? 20) || 20),
  );
  return { page, limit, offset: (page - 1) * limit };
}

export function registerClanRoutes(app: Express, ctx: ApiContext) {
  const { db } = ctx;

  const clan = (tag: string) =>
    db.prepare("SELECT * FROM clans WHERE tag = ?").get(tag.toUpperCase()) as
      | ClanRow
      | undefined;
  const memberCount = (tag: string) =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM clan_members WHERE tag = ?")
        .get(tag) as {
        n: number;
      }
    ).n;
  const roleOf = (tag: string, playerId: string) =>
    (
      db
        .prepare(
          "SELECT role FROM clan_members WHERE tag = ? AND player_id = ?",
        )
        .get(tag, playerId) as { role: Role } | undefined
    )?.role;

  const info = (c: ClanRow) => ({
    name: c.name,
    tag: c.tag,
    description: c.description,
    discordUrl: c.discord_url,
    isOpen: c.is_open === 1,
    createdAt: iso(c.created_at),
    memberCount: memberCount(c.tag),
  });

  const playerClans = (playerId: string) =>
    (
      db
        .prepare(
          `SELECT c.tag, c.name, m.role, m.joined_at FROM clan_members m
             JOIN clans c ON c.tag = m.tag WHERE m.player_id = ? ORDER BY c.tag`,
        )
        .all(playerId) as {
        tag: string;
        name: string;
        role: Role;
        joined_at: number;
      }[]
    ).map((r) => ({
      tag: r.tag,
      name: r.name,
      role: r.role,
      joinedAt: iso(r.joined_at),
      memberCount: memberCount(r.tag),
    }));

  ctx.userExtras.push((player) => ({
    clans: playerClans(player.id),
    clanRequests: (
      db
        .prepare(
          `SELECT c.tag, c.name, r.created_at FROM clan_requests r
             JOIN clans c ON c.tag = r.tag WHERE r.player_id = ?`,
        )
        .all(player.id) as { tag: string; name: string; created_at: number }[]
    ).map((r) => ({ tag: r.tag, name: r.name, createdAt: iso(r.created_at) })),
  }));
  ctx.profileExtras.push((player) => {
    const clans = playerClans(player.id);
    const latest = db
      .prepare(
        `SELECT gp.clan_tag FROM game_players gp JOIN games g ON g.game_id = gp.game_id
          WHERE gp.player_id = ? AND gp.clan_tag IS NOT NULL
          ORDER BY g.start_ms DESC LIMIT 20`,
      )
      .all(player.id) as { clan_tag: string }[];
    const mine = new Set(clans.map((c) => c.tag));
    const display = latest.find((g) => mine.has(g.clan_tag.toUpperCase()));
    return {
      clans,
      displayClanTag: display ? display.clan_tag.toUpperCase() : null,
    };
  });

  /** Loads the clan and the caller's role; answers 404/403 itself. */
  function guard(
    req: Request,
    res: Response,
    minRole: Role | null,
  ): { c: ClanRow; me: PlayerRow; role: Role | undefined } | null {
    const c = clan(String(req.params.tag));
    if (!c) {
      res.status(404).json({ error: "clan not found" });
      return null;
    }
    const me = res.locals.player as PlayerRow;
    const role = roleOf(c.tag, me.id);
    if (minRole && (!role || RANK[role] < RANK[minRole])) {
      res.status(403).json({ error: "not allowed" });
      return null;
    }
    return { c, me, role };
  }

  /** Resolves `targetPublicId` to a player; answers 400/404 itself. */
  function target(req: Request, res: Response, schema = TargetSchema) {
    const body = schema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid request" });
      return null;
    }
    const p = ctx.accounts.getPlayerByPublicId(body.data.targetPublicId);
    if (!p) {
      res.status(404).json({ error: "player not found" });
      return null;
    }
    return { p, body: body.data };
  }

  // --- game server -------------------------------------------------------

  app.get("/reserved_clan_tags", requireApiKey(ctx), (_req, res) => {
    res.json(
      (db.prepare("SELECT tag FROM clans").all() as { tag: string }[]).map(
        (r) => r.tag,
      ),
    );
  });

  // --- browse / detail ---------------------------------------------------

  app.get("/clans", (req: Request, res: Response) => {
    const { page, limit, offset } = pageParams(req);
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const open = req.query.open;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (search.length >= 2) {
      where.push("(c.tag LIKE ? OR c.name LIKE ?)");
      args.push(`%${search}%`, `%${search}%`);
    }
    if (open === "open") where.push("c.is_open = 1");
    if (open === "inviteOnly") where.push("c.is_open = 0");
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const bucket = Math.floor(Date.now() / 3_600_000);
    const sortField = String(
      req.query.sortField ?? (search ? "name" : "random"),
    );
    const desc = req.query.sortOrder !== "asc";
    const orderBy =
      sortField === "memberCount"
        ? `members ${desc ? "DESC" : "ASC"}`
        : sortField === "createdAt"
          ? `c.created_at ${desc ? "DESC" : "ASC"}`
          : sortField === "name"
            ? `c.name COLLATE NOCASE ${req.query.sortOrder === "desc" ? "DESC" : "ASC"}`
            : // random: a shuffle that holds for the hour
              `((c.rowid * 2654435761 + ${bucket}) % 1000003)`;
    const total = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM clans c ${whereSql}`)
        .get(...args) as {
        n: number;
      }
    ).n;
    const rows = db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM clan_members m WHERE m.tag = c.tag) AS members
           FROM clans c ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as unknown as ClanRow[];
    res.json({
      results: rows.map(info),
      total,
      page,
      limit,
      bucket,
      boostedBlock: [],
    });
  });

  app.get("/clans/:tag", (req: Request, res: Response) => {
    const c = clan(String(req.params.tag));
    if (!c) {
      res.status(404).json({ error: "clan not found" });
      return;
    }
    res.json(info(c));
  });

  // --- create / edit / disband ------------------------------------------

  app.post("/clans", requirePlayer(ctx), (req: Request, res: Response) => {
    const me = res.locals.player as PlayerRow;
    if (ctx.accounts.identities(me.id).length === 0) {
      res
        .status(403)
        .json({ error: "sign in to create a clan", code: "sign_in" });
      return;
    }
    const body = CreateSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid clan", code: "invalid" });
      return;
    }
    const tag = body.data.tag.toUpperCase();
    const out = tx(db, () => {
      if (clan(tag)) return "taken" as const;
      const memberships = playerClans(me.id);
      if (memberships.some((m) => m.role === "leader"))
        return "already_leader" as const;
      if (memberships.length >= MAX_MEMBERSHIPS) return "too_many" as const;
      const now = Date.now();
      db.prepare(
        "INSERT INTO clans (tag, name, description, discord_url, is_open, created_at) VALUES (?, ?, ?, NULL, ?, ?)",
      ).run(
        tag,
        body.data.name,
        body.data.description,
        body.data.isOpen ? 1 : 0,
        now,
      );
      db.prepare(
        "INSERT INTO clan_members (tag, player_id, role, joined_at) VALUES (?, ?, 'leader', ?)",
      ).run(tag, me.id, now);
      return "ok" as const;
    });
    if (out !== "ok") {
      res.status(409).json({ error: out, code: out });
      return;
    }
    res.status(201).json(info(clan(tag)!));
  });

  app.patch(
    "/clans/:tag",
    requirePlayer(ctx),
    (req: Request, res: Response) => {
      const g = guard(req, res, "officer");
      if (!g) return;
      const body = PatchSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "invalid update" });
        return;
      }
      const p = body.data;
      db.prepare(
        `UPDATE clans SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         is_open = COALESCE(?, is_open),
         discord_url = CASE WHEN ? THEN ? ELSE discord_url END
       WHERE tag = ?`,
      ).run(
        p.name ?? null,
        p.description ?? null,
        p.isOpen === undefined ? null : p.isOpen ? 1 : 0,
        p.discordUrl !== undefined ? 1 : 0,
        // "" clears the link, like null.
        p.discordUrl === "" ? null : (p.discordUrl ?? null),
        g.c.tag,
      );
      res.json(info(clan(g.c.tag)!));
    },
  );

  app.delete(
    "/clans/:tag",
    requirePlayer(ctx),
    (req: Request, res: Response) => {
      const g = guard(req, res, "leader");
      if (!g) return;
      db.prepare("DELETE FROM clans WHERE tag = ?").run(g.c.tag);
      res.json({ ok: true });
    },
  );

  // --- membership ---------------------------------------------------------

  app.get("/clans/:tag/members", (req: Request, res: Response) => {
    const c = clan(String(req.params.tag));
    if (!c) {
      res.status(404).json({ error: "clan not found" });
      return;
    }
    const { page, limit, offset } = pageParams(req);
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const like = search ? `%${search}%` : "%";
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM clan_members m JOIN players p ON p.id = m.player_id
            WHERE m.tag = ? AND (COALESCE(p.username, '') LIKE ? OR p.public_id LIKE ?)`,
        )
        .get(c.tag, like, like) as { n: number }
    ).n;
    const rows = db
      .prepare(
        `SELECT m.role, m.joined_at, p.public_id, p.username FROM clan_members m
           JOIN players p ON p.id = m.player_id
          WHERE m.tag = ? AND (COALESCE(p.username, '') LIKE ? OR p.public_id LIKE ?)
          ORDER BY CASE m.role WHEN 'leader' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END, m.joined_at
          LIMIT ? OFFSET ?`,
      )
      .all(c.tag, like, like, limit, offset) as {
      role: Role;
      joined_at: number;
      public_id: string;
      username: string | null;
    }[];
    const pending = (
      db
        .prepare("SELECT COUNT(*) AS n FROM clan_requests WHERE tag = ?")
        .get(c.tag) as {
        n: number;
      }
    ).n;
    res.json({
      results: rows.map((r) => ({
        role: r.role,
        joinedAt: iso(r.joined_at),
        publicId: r.public_id,
        username: r.username,
      })),
      total,
      page,
      limit,
      pendingRequests: pending,
    });
  });

  app.post(
    "/clans/:tag/join",
    requirePlayer(ctx),
    (req: Request, res: Response) => {
      const g = guard(req, res, null);
      if (!g) return;
      const { c, me, role } = g;
      if (role) {
        res.status(409).json({ error: "already a member" });
        return;
      }
      const banned = db
        .prepare("SELECT 1 FROM clan_bans WHERE tag = ? AND player_id = ?")
        .get(c.tag, me.id);
      if (banned) {
        res.status(403).json({ error: "banned from this clan" });
        return;
      }
      if (playerClans(me.id).length >= MAX_MEMBERSHIPS) {
        res.status(409).json({ error: "too many clans", code: "too_many" });
        return;
      }
      const now = Date.now();
      if (c.is_open === 1) {
        tx(db, () => {
          db.prepare(
            "DELETE FROM clan_requests WHERE tag = ? AND player_id = ?",
          ).run(c.tag, me.id);
          db.prepare(
            "INSERT INTO clan_members (tag, player_id, role, joined_at) VALUES (?, ?, 'member', ?)",
          ).run(c.tag, me.id, now);
        });
        res.json({ status: "joined" });
        return;
      }
      db.prepare(
        "INSERT OR IGNORE INTO clan_requests (tag, player_id, created_at) VALUES (?, ?, ?)",
      ).run(c.tag, me.id, now);
      res.json({ status: "requested" });
    },
  );

  app.post(
    "/clans/:tag/leave",
    requirePlayer(ctx),
    (req: Request, res: Response) => {
      const g = guard(req, res, "member");
      if (!g) return;
      if (g.role === "leader") {
        if (memberCount(g.c.tag) > 1) {
          res.status(400).json({
            error: "transfer leadership first",
            code: "leader_must_transfer",
          });
          return;
        }
        db.prepare("DELETE FROM clans WHERE tag = ?").run(g.c.tag);
      } else {
        db.prepare(
          "DELETE FROM clan_members WHERE tag = ? AND player_id = ?",
        ).run(g.c.tag, g.me.id);
      }
      res.json({ ok: true });
    },
  );

  for (const action of ["kick", "promote", "demote", "transfer"] as const) {
    app.post(
      `/clans/:tag/${action}`,
      requirePlayer(ctx),
      (req: Request, res: Response) => {
        const g = guard(req, res, action === "kick" ? "officer" : "leader");
        if (!g) return;
        const t = target(req, res);
        if (!t) return;
        const theirs = roleOf(g.c.tag, t.p.id);
        if (!theirs || t.p.id === g.me.id) {
          res.status(400).json({ error: "not a member" });
          return;
        }
        if (RANK[theirs] >= RANK[g.role!]) {
          res.status(403).json({ error: "not allowed" });
          return;
        }
        const setRole = (id: string, role: Role) =>
          db
            .prepare(
              "UPDATE clan_members SET role = ? WHERE tag = ? AND player_id = ?",
            )
            .run(role, g.c.tag, id);
        tx(db, () => {
          if (action === "kick") {
            db.prepare(
              "DELETE FROM clan_members WHERE tag = ? AND player_id = ?",
            ).run(g.c.tag, t.p.id);
          } else if (action === "promote") {
            setRole(t.p.id, "officer");
          } else if (action === "demote") {
            setRole(t.p.id, "member");
          } else {
            setRole(t.p.id, "leader");
            setRole(g.me.id, "officer");
          }
        });
        res.json({ ok: true });
      },
    );
  }

  // --- join requests ------------------------------------------------------

  app.get(
    "/clans/:tag/requests",
    requirePlayer(ctx),
    (req: Request, res: Response) => {
      const g = guard(req, res, "officer");
      if (!g) return;
      const { page, limit, offset } = pageParams(req);
      const total = (
        db
          .prepare("SELECT COUNT(*) AS n FROM clan_requests WHERE tag = ?")
          .get(g.c.tag) as {
          n: number;
        }
      ).n;
      const rows = db
        .prepare(
          `SELECT p.public_id, p.username, r.created_at FROM clan_requests r
           JOIN players p ON p.id = r.player_id WHERE r.tag = ?
          ORDER BY r.created_at LIMIT ? OFFSET ?`,
        )
        .all(g.c.tag, limit, offset) as {
        public_id: string;
        username: string | null;
        created_at: number;
      }[];
      res.json({
        results: rows.map((r) => ({
          publicId: r.public_id,
          username: r.username,
          createdAt: iso(r.created_at),
        })),
        total,
        page,
        limit,
      });
    },
  );

  for (const decision of ["approve", "deny"] as const) {
    app.post(
      `/clans/:tag/requests/${decision}`,
      requirePlayer(ctx),
      (req: Request, res: Response) => {
        const g = guard(req, res, "officer");
        if (!g) return;
        const t = target(req, res);
        if (!t) return;
        const pending = db
          .prepare(
            "SELECT 1 FROM clan_requests WHERE tag = ? AND player_id = ?",
          )
          .get(g.c.tag, t.p.id);
        if (!pending) {
          res.status(404).json({ error: "no such request" });
          return;
        }
        if (
          decision === "approve" &&
          playerClans(t.p.id).length >= MAX_MEMBERSHIPS
        ) {
          res
            .status(409)
            .json({ error: "player is in too many clans", code: "too_many" });
          return;
        }
        tx(db, () => {
          db.prepare(
            "DELETE FROM clan_requests WHERE tag = ? AND player_id = ?",
          ).run(g.c.tag, t.p.id);
          if (decision === "approve") {
            db.prepare(
              "INSERT OR IGNORE INTO clan_members (tag, player_id, role, joined_at) VALUES (?, ?, 'member', ?)",
            ).run(g.c.tag, t.p.id, Date.now());
          }
        });
        res.json({ ok: true });
      },
    );
  }

  app.post(
    "/clans/:tag/requests/withdraw",
    requirePlayer(ctx),
    (req: Request, res: Response) => {
      const g = guard(req, res, null);
      if (!g) return;
      db.prepare(
        "DELETE FROM clan_requests WHERE tag = ? AND player_id = ?",
      ).run(g.c.tag, g.me.id);
      res.json({ ok: true });
    },
  );

  // --- bans ---------------------------------------------------------------

  app.post(
    "/clans/:tag/ban",
    requirePlayer(ctx),
    (req: Request, res: Response) => {
      const g = guard(req, res, "officer");
      if (!g) return;
      const t = target(req, res, BanSchema);
      if (!t) return;
      const theirs = roleOf(g.c.tag, t.p.id);
      if (t.p.id === g.me.id || (theirs && RANK[theirs] >= RANK[g.role!])) {
        res.status(403).json({ error: "not allowed" });
        return;
      }
      tx(db, () => {
        db.prepare(
          "DELETE FROM clan_members WHERE tag = ? AND player_id = ?",
        ).run(g.c.tag, t.p.id);
        db.prepare(
          "DELETE FROM clan_requests WHERE tag = ? AND player_id = ?",
        ).run(g.c.tag, t.p.id);
        db.prepare(
          "INSERT OR REPLACE INTO clan_bans (tag, player_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(
          g.c.tag,
          t.p.id,
          g.me.id,
          BanSchema.safeParse(req.body).data?.reason ?? null,
          Date.now(),
        );
      });
      res.json({ ok: true });
    },
  );

  app.post(
    "/clans/:tag/unban",
    requirePlayer(ctx),
    (req: Request, res: Response) => {
      const g = guard(req, res, "officer");
      if (!g) return;
      const t = target(req, res);
      if (!t) return;
      db.prepare("DELETE FROM clan_bans WHERE tag = ? AND player_id = ?").run(
        g.c.tag,
        t.p.id,
      );
      res.json({ ok: true });
    },
  );

  app.get(
    "/clans/:tag/bans",
    requirePlayer(ctx),
    (req: Request, res: Response) => {
      const g = guard(req, res, "officer");
      if (!g) return;
      const { page, limit, offset } = pageParams(req);
      const total = (
        db
          .prepare("SELECT COUNT(*) AS n FROM clan_bans WHERE tag = ?")
          .get(g.c.tag) as { n: number }
      ).n;
      const rows = db
        .prepare(
          `SELECT p.public_id, p.username, b.reason, b.created_at,
                bb.public_id AS by_public_id, bb.username AS by_username
           FROM clan_bans b JOIN players p ON p.id = b.player_id
           LEFT JOIN players bb ON bb.id = b.banned_by
          WHERE b.tag = ? ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(g.c.tag, limit, offset) as {
        public_id: string;
        username: string | null;
        reason: string | null;
        created_at: number;
        by_public_id: string | null;
        by_username: string | null;
      }[];
      res.json({
        results: rows.map((r) => ({
          publicId: r.public_id,
          username: r.username,
          bannedBy: r.by_public_id ?? "",
          bannedByUsername: r.by_username,
          reason: r.reason,
          createdAt: iso(r.created_at),
        })),
        total,
        page,
        limit,
      });
    },
  );

  // --- games & leaderboard -----------------------------------------------

  app.get("/clans/:tag/games", (req: Request, res: Response) => {
    const c = clan(String(req.params.tag));
    if (!c) {
      res.status(404).json({ error: "clan not found" });
      return;
    }
    const filter = String(req.query.filter ?? "");
    const filterSql =
      filter === "ffa"
        ? "AND g.mode = 'Free For All' AND g.ranked_type = ''"
        : filter === "team"
          ? "AND g.mode = 'Team' AND COALESCE(g.player_teams, '') != 'Humans Vs Nations' AND g.ranked_type = ''"
          : filter === "hvn"
            ? "AND g.player_teams = 'Humans Vs Nations'"
            : filter === "ranked"
              ? "AND g.ranked_type != ''"
              : "";
    const cursor = Number(req.query.cursor ?? 0) || Number.MAX_SAFE_INTEGER;
    const games = db
      .prepare(
        `SELECT DISTINCT g.* FROM games g
           JOIN game_players gp ON gp.game_id = g.game_id
           JOIN clan_members m ON m.player_id = gp.player_id AND m.tag = ?
          WHERE UPPER(gp.clan_tag) = ? AND g.start_ms < ? ${filterSql}
          ORDER BY g.start_ms DESC LIMIT ?`,
      )
      .all(c.tag, c.tag, cursor, GAMES_PAGE + 1) as {
      game_id: string;
      start_ms: number;
      duration_s: number;
      map: string;
      mode: string;
      player_teams: string | null;
      ranked_type: string;
      total_players: number;
      has_winner: number;
    }[];
    const page = games.slice(0, GAMES_PAGE);
    const playersOf = db.prepare(
      `SELECT p.public_id, gp.username, gp.won FROM game_players gp
         JOIN players p ON p.id = gp.player_id
         JOIN clan_members m ON m.player_id = gp.player_id AND m.tag = ?
        WHERE gp.game_id = ? AND UPPER(gp.clan_tag) = ?`,
    );
    res.json({
      results: page.map((g) => {
        const clanPlayers = (
          playersOf.all(c.tag, g.game_id, c.tag) as {
            public_id: string;
            username: string;
            won: number;
          }[]
        ).map((p) => ({
          publicId: p.public_id,
          username: p.username,
          won: p.won === 1,
        }));
        return {
          gameId: g.game_id,
          start: iso(g.start_ms),
          durationSeconds: g.duration_s,
          map: g.map,
          mode: g.mode,
          playerTeams: g.player_teams,
          rankedType: g.ranked_type,
          result: !g.has_winner
            ? "incomplete"
            : clanPlayers.some((p) => p.won)
              ? "victory"
              : "defeat",
          totalPlayers: g.total_players,
          clanPlayers,
        };
      }),
      nextCursor:
        games.length > GAMES_PAGE
          ? String(page[page.length - 1].start_ms)
          : null,
    });
  });

  app.get("/public/clans/leaderboard", (_req: Request, res: Response) => {
    const end = Date.now();
    const start = end - LEADERBOARD_DAYS * 86_400_000;
    const rows = db
      .prepare(
        `SELECT m.tag AS tag, g.game_id, MAX(gp.won) AS won, COUNT(*) AS sessions
           FROM game_players gp
           JOIN games g ON g.game_id = gp.game_id
           JOIN clan_members m ON m.player_id = gp.player_id AND UPPER(gp.clan_tag) = m.tag
          WHERE g.start_ms >= ? AND g.has_winner = 1 AND g.type != 'Singleplayer'
          GROUP BY m.tag, g.game_id`,
      )
      .all(start) as { tag: string; won: number; sessions: number }[];
    const agg = new Map<
      string,
      { games: number; wins: number; sessions: number }
    >();
    for (const r of rows) {
      const a = agg.get(r.tag) ?? { games: 0, wins: 0, sessions: 0 };
      a.games += 1;
      a.wins += r.won;
      a.sessions += r.sessions;
      agg.set(r.tag, a);
    }
    const clans = [...agg.entries()]
      .map(([clanTag, a]) => {
        const losses = a.games - a.wins;
        return {
          clanTag,
          games: a.games,
          wins: a.wins,
          losses,
          playerSessions: a.sessions,
          weightedWins: a.wins,
          weightedLosses: losses,
          weightedWLRatio:
            Math.round((a.wins / Math.max(1, losses)) * 100) / 100,
          elo: null,
        };
      })
      .sort((x, y) => y.wins - x.wins || y.weightedWLRatio - x.weightedWLRatio);
    res.json({ start: iso(start), end: iso(end), clans, total: clans.length });
  });
}
