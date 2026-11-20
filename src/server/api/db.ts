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
