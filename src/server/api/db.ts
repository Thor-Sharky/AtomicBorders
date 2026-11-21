/**
 * SQLite storage for the Atomic Borders API (node:sqlite, built into Node 24+).
 *
 * Migrations are append-only: each entry runs once, in order, tracked by
 * SQLite's `user_version`. Never edit a shipped migration; add a new one.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1: accounts and sessions
  `
  CREATE TABLE players (
    id          TEXT PRIMARY KEY,          -- persistent id (uuid), JWT sub
    public_id   TEXT NOT NULL UNIQUE,      -- shown to other players
    username    TEXT,
    role        TEXT,                      -- null | admin | mod | banned
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );
  CREATE TABLE identities (
    provider          TEXT NOT NULL,       -- discord | google
    provider_user_id  TEXT NOT NULL,
    player_id         TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    profile           TEXT NOT NULL,       -- json
    created_at        INTEGER NOT NULL,
    PRIMARY KEY (provider, provider_user_id),
    UNIQUE (player_id, provider)
  );
  CREATE TABLE refresh_tokens (
    token_hash  TEXT PRIMARY KEY,          -- sha256 of the cookie value
    player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked_at  INTEGER
  );
  CREATE INDEX refresh_tokens_player ON refresh_tokens(player_id);
  CREATE TABLE oauth_states (
    state         TEXT PRIMARY KEY,
    provider      TEXT NOT NULL,
    verifier      TEXT NOT NULL,           -- PKCE code_verifier
    redirect_uri  TEXT NOT NULL,
    player_id     TEXT,                    -- guest to upgrade, if any
    created_at    INTEGER NOT NULL
  );
  `,
  // 2: archived games, per-player results, ratings
  `
  CREATE TABLE games (
    game_id        TEXT PRIMARY KEY,
    start_ms       INTEGER NOT NULL,
    end_ms         INTEGER NOT NULL,
    duration_s     INTEGER NOT NULL,
    map            TEXT NOT NULL,
    mode           TEXT NOT NULL,          -- GameMode value
    type           TEXT NOT NULL,          -- GameType value
    difficulty     TEXT NOT NULL,
    player_teams   TEXT,                   -- team count / "Humans Vs Nations"
    ranked_type    TEXT NOT NULL DEFAULT '',
    total_players  INTEGER NOT NULL,
    has_winner     INTEGER NOT NULL,
    record         BLOB NOT NULL           -- gzip(JSON GameRecord)
  );
  CREATE INDEX games_start ON games(start_ms);
  CREATE TABLE game_players (
    game_id    TEXT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
    client_id  TEXT NOT NULL,
    player_id  TEXT REFERENCES players(id) ON DELETE SET NULL,
    username   TEXT NOT NULL,
    clan_tag   TEXT,
    team       TEXT,
    won        INTEGER NOT NULL,
    PRIMARY KEY (game_id, client_id)
  );
  CREATE INDEX game_players_player ON game_players(player_id);
  CREATE INDEX game_players_clan ON game_players(clan_tag);
  CREATE TABLE ratings (
    player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    ladder     TEXT NOT NULL,              -- RankedType value: 1v1 | 2v2 | ffa
    rating     REAL NOT NULL,
    peak       REAL NOT NULL,
    games      INTEGER NOT NULL,
    wins       INTEGER NOT NULL,
    losses     INTEGER NOT NULL,
    PRIMARY KEY (player_id, ladder)
  );
  CREATE INDEX ratings_ladder ON ratings(ladder, rating DESC);
  `,
  // 3: clans
  `
  CREATE TABLE clans (
    tag          TEXT PRIMARY KEY,         -- uppercase, 2-5 [A-Z0-9]
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    discord_url  TEXT,
    is_open      INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE TABLE clan_members (
    tag        TEXT NOT NULL REFERENCES clans(tag) ON DELETE CASCADE,
    player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,              -- leader | officer | member
    joined_at  INTEGER NOT NULL,
    PRIMARY KEY (tag, player_id)
  );
  CREATE INDEX clan_members_player ON clan_members(player_id);
  CREATE TABLE clan_requests (
    tag         TEXT NOT NULL REFERENCES clans(tag) ON DELETE CASCADE,
    player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (tag, player_id)
  );
  CREATE TABLE clan_bans (
    tag         TEXT NOT NULL REFERENCES clans(tag) ON DELETE CASCADE,
    player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    banned_by   TEXT NOT NULL,
    reason      TEXT,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (tag, player_id)
  );
  `,
  // 4: XP and levels
  `
  CREATE TABLE progress (
    player_id    TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    lifetime_xp  INTEGER NOT NULL
  );
  CREATE TABLE game_xp (
    player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_id     TEXT NOT NULL,
    breakdown   TEXT NOT NULL,           -- json XpBreakdown
    before_xp   INTEGER NOT NULL,
    after_xp    INTEGER NOT NULL,
    eligible    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (player_id, game_id)
  );
  CREATE TABLE xp_daily (
    player_id           TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    day                 TEXT NOT NULL,   -- UTC YYYY-MM-DD
    singleplayer_games  INTEGER NOT NULL,
    private_games       INTEGER NOT NULL,
    PRIMARY KEY (player_id, day)
  );
  `,
];

export function openDb(file: string): Db {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** Runs `fn` in a transaction, committing on success. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
