import {
  GameMode,
  GameType,
  RankedType,
} from "@openfront/engine-api/game/GameTypes";
import {
  FfaRankPositionResponseSchema,
  PlayerProfileSchema,
  PublicPlayerGamesResponseSchema,
  RankedLeaderboardResponseSchema,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import {
  createPartialGameRecord,
  replacer,
} from "@openfront/shared/SharedUtil";
import {
  GameRecordSchema,
  type PlayerRecord,
} from "@openfront/shared/WireSchemas";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../../../src/server/api/db";
import {
  applyMatch,
  expectedScore,
  getRating,
} from "../../../src/server/api/ratings";
import { testGameConfig } from "../../util/Wire";
import { startTestApi, TEST_API_KEY, type TestApi } from "./TestApi";

let api: TestApi;
let alice: { jwt: string; playerId: string };
let bob: { jwt: string; playerId: string };

beforeAll(async () => {
  api = await startTestApi();
  alice = await api.guest();
  bob = await api.guest();
});
afterAll(() => api.close());

const publicId = (playerId: string) =>
  api.ctx.accounts.getPlayer(playerId)!.public_id;

function player(clientID: string, persistentID: string | null): PlayerRecord {
  return {
    clientID,
    username: clientID.toLowerCase(),
    clanTag: null,
    persistentID,
    stats: {},
  };
}

function gameRecord(
  gameID: string,
  winnerClient: string,
  overrides: Parameters<typeof testGameConfig>[0] = {},
) {
  const record = createPartialGameRecord(
    gameID,
    testGameConfig({
      gameType: GameType.Public,
      gameMode: GameMode.FFA,
      ...overrides,
    }),
    [
      player("AAAA1111", alice.playerId),
      player("BBBB2222", bob.playerId),
      player("CCCC3333", null),
    ],
    [],
    1_700_000_000_000 + gameID.charCodeAt(0) * 1000,
    1_700_000_600_000 + gameID.charCodeAt(0) * 1000,
    ["player", winnerClient],
  );
  return JSON.parse(JSON.stringify({ ...record, gitCommit: "DEV" }, replacer));
}

const postGame = (record: { info: { gameID: string } }, key = TEST_API_KEY) =>
  fetch(`${api.base}/game/${record.info.gameID}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(record),
  });

describe("archiving games", () => {
  it("refuses a game server without the API key", async () => {
    expect(
      (await postGame(gameRecord("gameNoKy", "AAAA1111"), "wrong")).status,
    ).toBe(401);
  });

  it("stores a game once and rates the winner above the loser", async () => {
    const record = gameRecord("gameOne1", "AAAA1111");
    expect((await postGame(record)).status).toBe(200);
    expect((await postGame(record)).status).toBe(409);
    expect(getRating(api.ctx.db, alice.playerId, "ffa").rating).toBeGreaterThan(
      1000,
    );
    expect(getRating(api.ctx.db, bob.playerId, "ffa").rating).toBeLessThan(
      1000,
    );
  });

  it("does not rate private games", async () => {
    const before = getRating(api.ctx.db, alice.playerId, "ffa").rating;
    await postGame(
      gameRecord("gamePriv", "AAAA1111", { gameType: GameType.Private }),
    );
    expect(getRating(api.ctx.db, alice.playerId, "ffa").rating).toBe(before);
  });

  it("serves the replay record without persistent ids", async () => {
    const res = await fetch(`${api.base}/game/gameOne1`);
    expect(res.status).toBe(200);
    const record = GameRecordSchema.parse(await res.json());
    expect(record.info.players.every((p) => p.persistentID === null)).toBe(
      true,
    );
    expect((await fetch(`${api.base}/game/missing1`)).status).toBe(404);
  });

  it("accepts a gzipped singleplayer record from the player, unrated", async () => {
    const before = getRating(api.ctx.db, alice.playerId, "ffa").games;
    const record = gameRecord("solo0001", "AAAA1111", {
      gameType: GameType.Singleplayer,
    });
    const res = await fetch(`${api.base}/archive_singleplayer_game`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        authorization: `Bearer ${alice.jwt}`,
      },
      body: zlib.gzipSync(JSON.stringify(record)),
    });
    expect(res.status).toBe(200);
    expect(getRating(api.ctx.db, alice.playerId, "ffa").games).toBe(before);
    // Only the uploader's own row is attributed to an account.
    const rows = api.ctx.db
      .prepare(
        "SELECT player_id FROM game_players WHERE game_id = 'solo0001' AND player_id IS NOT NULL",
      )
      .all();
    expect(rows).toEqual([{ player_id: alice.playerId }]);
  });
});

describe("leaderboard", () => {
  it("lists the FFA ladder in rating order, in the client's shape", async () => {
    const res = await fetch(`${api.base}/leaderboard/ranked?page=1`);
    const board = RankedLeaderboardResponseSchema.parse(await res.json());
    const ffa = board[RankedType.FreeForAll];
    expect(ffa.map((r) => r.public_id)).toEqual([
      publicId(alice.playerId),
      publicId(bob.playerId),
    ]);
    expect(ffa[0].rank).toBe(1);
    expect(board[RankedType.OneVOne]).toEqual([]);
  });

  it("ends paging with the bounds message the client recognises", async () => {
    const res = await fetch(`${api.base}/leaderboard/ranked?page=2`);
    expect(res.status).toBe(400);
    // The exact wording src/client/Api.ts isPageBoundsMessage matches.
    expect((await res.json()).message).toMatch(
      /^Page must be between \d+ and \d+$/,
    );
  });

  it("reports the player's FFA position", async () => {
    const res = await fetch(`${api.base}/users/@me/ffa_rank_position`, {
      headers: { authorization: `Bearer ${bob.jwt}` },
    });
    expect(FfaRankPositionResponseSchema.parse(await res.json()).position).toBe(
      2,
    );
  });

  it("puts the rating in /users/@me", async () => {
    const res = await fetch(`${api.base}/users/@me`, {
      headers: { authorization: `Bearer ${alice.jwt}` },
    });
    const me = UserMeResponseSchema.parse(await res.json());
    expect(me.player.leaderboard?.ffa?.elo).toBeGreaterThan(1000);
  });
});

describe("player profile", () => {
  it("summarises wins by game type, mode and difficulty", async () => {
    const res = await fetch(
      `${api.base}/public/player/${publicId(alice.playerId)}`,
    );
    const profile = PlayerProfileSchema.parse(await res.json());
    const leaf = profile.stats.Public?.[GameMode.FFA]?.Medium;
    expect(leaf).toMatchObject({ wins: 1n, losses: 0n, total: 1n });
    expect(profile.stats.Singleplayer?.[GameMode.FFA]?.Medium?.total).toBe(1n);
  });

  it("lists recent games newest first", async () => {
    const res = await fetch(
      `${api.base}/public/player/${publicId(bob.playerId)}/games`,
    );
    const games = PublicPlayerGamesResponseSchema.parse(await res.json());
    expect(games.results.map((g) => g.result)).toContain("defeat");
    expect(games.nextCursor).toBeNull();
  });

  it("404s an unknown player", async () => {
    expect((await fetch(`${api.base}/public/player/nobody`)).status).toBe(404);
  });
});

describe("Elo", () => {
  it("expects evenly matched players to split", () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5);
    expect(expectedScore(1400, 1000) + expectedScore(1000, 1400)).toBeCloseTo(
      1,
    );
  });

  it("is zero-sum for a 1v1", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO players (id, public_id, created_at, last_seen) VALUES ('a','pa',0,0), ('b','pb',0,0)",
    ).run();
    applyMatch(db, "1v1", ["a"], ["b"]);
    const a = getRating(db, "a", "1v1");
    const b = getRating(db, "b", "1v1");
    expect(a.rating + b.rating).toBeCloseTo(2000);
    expect(a.rating).toBe(1016);
    expect([a.wins, b.losses]).toEqual([1, 1]);
  });
});
