/** Players, identities and refresh sessions. */
import crypto from "node:crypto";
import { type Db, tx } from "./db";
import type { ProviderName, ProviderProfile } from "./oauth";

export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PlayerRow {
  id: string;
  public_id: string;
  username: string | null;
  role: string | null;
  created_at: number;
  last_seen: number;
}

export interface IdentityRow {
  provider: ProviderName;
  provider_user_id: string;
  player_id: string;
  profile: string;
}

const PUBLIC_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function newPublicId(): string {
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (const b of bytes) out += PUBLIC_ID_ALPHABET[b % 62];
  return out;
}

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");

export class Accounts {
  constructor(private readonly db: Db) {}

  getPlayer(id: string): PlayerRow | undefined {
    return this.db.prepare("SELECT * FROM players WHERE id = ?").get(id) as
      | PlayerRow
      | undefined;
  }

  getPlayerByPublicId(publicId: string): PlayerRow | undefined {
    return this.db
      .prepare("SELECT * FROM players WHERE public_id = ?")
      .get(publicId) as PlayerRow | undefined;
  }

  identities(playerId: string): IdentityRow[] {
    return this.db
      .prepare("SELECT * FROM identities WHERE player_id = ?")
      .all(playerId) as unknown as IdentityRow[];
  }

  createPlayer(username: string | null = null): PlayerRow {
    const now = Date.now();
    const row: PlayerRow = {
      id: crypto.randomUUID(),
      public_id: newPublicId(),
      username,
      role: null,
      created_at: now,
      last_seen: now,
    };
    this.db
      .prepare(
        "INSERT INTO players (id, public_id, username, role, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.public_id, row.username, null, now, now);
    return row;
  }

  /**
   * Resolves a provider login to a player. An identity seen before logs into
   * its player. A new identity is attached to `guestId` when the browser was
   * a guest (keeping that guest's stats), otherwise to a new player.
   */
  loginWithIdentity(
    provider: ProviderName,
    p: ProviderProfile,
    guestId: string | null,
  ): PlayerRow {
    return tx(this.db, () => {
      const existing = this.db
        .prepare(
          "SELECT player_id FROM identities WHERE provider = ? AND provider_user_id = ?",
        )
        .get(provider, p.providerUserId) as { player_id: string } | undefined;
      if (existing) {
        this.db
          .prepare(
            "UPDATE identities SET profile = ? WHERE provider = ? AND provider_user_id = ?",
          )
          .run(JSON.stringify(p.profile), provider, p.providerUserId);
        return this.getPlayer(existing.player_id)!;
      }
      let player: PlayerRow | undefined;
      if (guestId) {
        const guest = this.getPlayer(guestId);
        const taken = guest
          ? this.identities(guest.id).some((i) => i.provider === provider)
          : true;
        if (guest && !taken) player = guest;
      }
      player ??= this.createPlayer(p.displayName);
      if (player.username === null && p.displayName) {
        this.db
          .prepare("UPDATE players SET username = ? WHERE id = ?")
          .run(p.displayName, player.id);
        player = { ...player, username: p.displayName };
      }
      this.db
        .prepare(
          "INSERT INTO identities (provider, provider_user_id, player_id, profile, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          provider,
          p.providerUserId,
          player.id,
          JSON.stringify(p.profile),
          Date.now(),
        );
      return player;
    });
  }

  /** Creates a refresh session; returns the opaque cookie value. */
  createSession(playerId: string): string {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO refresh_tokens (token_hash, player_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(sha256(token), playerId, now, now + REFRESH_TTL_MS);
    this.db
      .prepare("UPDATE players SET last_seen = ? WHERE id = ?")
      .run(now, playerId);
    return token;
  }

  /** The player a live refresh token belongs to, or null. */
  sessionPlayer(token: string): PlayerRow | null {
    const row = this.db
      .prepare(
        "SELECT player_id FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
      )
      .get(sha256(token), Date.now()) as { player_id: string } | undefined;
    return row ? (this.getPlayer(row.player_id) ?? null) : null;
  }

  /** Revokes `token` and issues a replacement; null if it wasn't live. */
  rotateSession(token: string): { player: PlayerRow; token: string } | null {
    return tx(this.db, () => {
      const player = this.sessionPlayer(token);
      if (!player) return null;
      this.revokeSession(token);
      return { player, token: this.createSession(player.id) };
    });
  }

  revokeSession(token: string) {
    this.db
      .prepare(
        "UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), sha256(token));
  }

  revokeAllSessions(playerId: string) {
    this.db
      .prepare(
        "UPDATE refresh_tokens SET revoked_at = ? WHERE player_id = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), playerId);
  }

  /** Primary sign-in provider for the JWT `provider` claim, or null for a guest. */
  primaryProvider(playerId: string): ProviderName | null {
    const ids = this.identities(playerId);
    return (
      ids.find((i) => i.provider === "discord")?.provider ??
      ids[0]?.provider ??
      null
    );
  }
}
