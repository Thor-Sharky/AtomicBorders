/**
 * Elo ladders. 1v1 and 2v2 come from ranked games; the FFA ladder comes from
 * public free-for-all games, where the winner takes rating from every other
 * rated player in the match.
 */
import type { Db } from "./db";

export const START_RATING = 1000;
export const K_FACTOR = 32;

export type Ladder = "1v1" | "2v2" | "ffa";

export interface RatingRow {
  player_id: string;
  ladder: Ladder;
  rating: number;
  peak: number;
  games: number;
  wins: number;
  losses: number;
}

/** Expected score of a player rated `a` against one rated `b`. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

export function getRating(db: Db, playerId: string, ladder: Ladder): RatingRow {
  const row = db
    .prepare("SELECT * FROM ratings WHERE player_id = ? AND ladder = ?")
    .get(playerId, ladder) as RatingRow | undefined;
  return (
    row ?? {
      player_id: playerId,
      ladder,
      rating: START_RATING,
      peak: START_RATING,
      games: 0,
      wins: 0,
      losses: 0,
    }
  );
}

function saveRating(db: Db, r: RatingRow) {
  db.prepare(
    `INSERT INTO ratings (player_id, ladder, rating, peak, games, wins, losses)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (player_id, ladder) DO UPDATE SET
       rating = excluded.rating, peak = excluded.peak, games = excluded.games,
       wins = excluded.wins, losses = excluded.losses`,
  ).run(r.player_id, r.ladder, r.rating, r.peak, r.games, r.wins, r.losses);
}

/**
 * Applies one finished match to a ladder. `winners` and `losers` are player
 * ids (teams for 2v2: each side's average rating is used). Every winner/loser
 * pairing exchanges points; K is split by the number of opponents so a big
 * FFA lobby doesn't swing ratings wildly. Call inside a transaction.
 */
export function applyMatch(
  db: Db,
  ladder: Ladder,
  winners: string[],
  losers: string[],
) {
  if (winners.length === 0 || losers.length === 0) return;
  const w = winners.map((id) => getRating(db, id, ladder));
  const l = losers.map((id) => getRating(db, id, ladder));

  if (ladder === "2v2" || ladder === "1v1") {
    const avg = (rs: RatingRow[]) =>
      rs.reduce((s, r) => s + r.rating, 0) / rs.length;
    const wa = avg(w);
    const la = avg(l);
    const delta = K_FACTOR * (1 - expectedScore(wa, la));
    for (const r of w) bump(r, +delta, true);
    for (const r of l) bump(r, -delta, false);
  } else {
    // FFA: each winner vs each loser, K shared across the opponents faced.
    const k = K_FACTOR / Math.max(1, l.length);
    const wDelta = new Map<RatingRow, number>();
    const lDelta = new Map<RatingRow, number>();
    for (const a of w) {
      for (const b of l) {
        const d = k * (1 - expectedScore(a.rating, b.rating));
        wDelta.set(a, (wDelta.get(a) ?? 0) + d);
        lDelta.set(b, (lDelta.get(b) ?? 0) + d / w.length);
      }
    }
    for (const r of w) bump(r, wDelta.get(r) ?? 0, true);
    for (const r of l) bump(r, -(lDelta.get(r) ?? 0), false);
  }
  for (const r of [...w, ...l]) saveRating(db, r);
}

function bump(r: RatingRow, delta: number, won: boolean) {
  r.rating = Math.round((r.rating + delta) * 10) / 10;
  r.peak = Math.max(r.peak, r.rating);
  r.games += 1;
  if (won) r.wins += 1;
  else r.losses += 1;
}
