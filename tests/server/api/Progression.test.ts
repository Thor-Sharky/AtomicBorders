import { GameMode, GameType } from "@openfront/engine-api/game/GameTypes";
import {
  GameXpResponseSchema,
  ProgressionConfigSchema,
  PublicProgressSchema,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import { CosmeticsSchema } from "@openfront/shared/CosmeticSchemas";
import { decodePatternData } from "@openfront/shared/PatternDecoder";
import {
  createPartialGameRecord,
  replacer,
} from "@openfront/shared/SharedUtil";
import { base64url } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CATALOG,
  encodePattern,
  flaresForLevel,
  UNLOCKS,
} from "../../../src/server/api/catalog";
import {
  MAX_LEVEL,
  positionFor,
  xpToNext,
} from "../../../src/server/api/progression";
import { PrivilegeCheckerImpl } from "../../../src/server/Privilege";
import { testGameConfig } from "../../util/Wire";
import { startTestApi, TEST_API_KEY, type TestApi } from "./TestApi";

let api: TestApi;
let me: { jwt: string; playerId: string };

beforeAll(async () => {
  api = await startTestApi();
  me = await api.guest();
});
afterAll(() => api.close());

const cosmetics = () => CosmeticsSchema.parse(CATALOG);

describe("catalog", () => {
  it("parses as the client's cosmetics catalog, with nothing for sale", () => {
    const c = cosmetics();
    expect(Object.keys(c.patterns).length).toBeGreaterThanOrEqual(8);
    for (const p of Object.values(c.patterns)) {
      expect(p.product).toBeNull();
      expect(p.priceSoft).toBeUndefined();
      expect(p.priceHard).toBeUndefined();
    }
  });

  it("encodes every pattern so the game can decode it", () => {
    for (const p of Object.values(cosmetics().patterns)) {
      const d = decodePatternData(p.pattern, base64url.decode);
      expect(d.width).toBeGreaterThanOrEqual(2);
    }
  });

  it("round-trips a pattern bitmap", () => {
    const d = decodePatternData(
      encodePattern(["#.", ".#"], 2),
      base64url.decode,
    );
    expect(d).toMatchObject({ width: 2, height: 2, scale: 2 });
    expect(d.bytes[3] & 0b1001).toBe(0b1001);
  });

  it("has an unlock for real catalog items only, with a free starter set", () => {
    const c = cosmetics();
    for (const { flare } of UNLOCKS) {
      const [type, name, palette] = flare.split(":");
      if (type === "pattern") {
        expect(c.patterns[name]?.colorPalettes?.map((p) => p.name)).toContain(
          palette,
        );
      } else {
        const all = Object.values(c.effects ?? {}).flatMap((g) =>
          Object.keys(g ?? {}),
        );
        expect(all).toContain(name);
      }
    }
    expect(flaresForLevel(1).length).toBeGreaterThanOrEqual(2);
  });

  it("lets the game server accept an unlocked item and refuse a locked one", () => {
    const checker = new PrivilegeCheckerImpl(cosmetics(), base64url.decode);
    const starter = flaresForLevel(1);
    expect(
      checker.isAllowed(starter, {
        patternName: "frontier_stripes",
        patternColorPaletteName: "olive",
      }).type,
    ).toBe("allowed");
    expect(
      checker.isAllowed(starter, {
        patternName: "border_steps",
        patternColorPaletteName: "amber",
      }).type,
    ).toBe("forbidden");
  });

  it("is what /cosmetics.json serves", async () => {
    const body = await (await fetch(`${api.base}/cosmetics.json`)).json();
    expect(CosmeticsSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body.patterns).length).toBeGreaterThan(0);
  });
});

describe("levels", () => {
  it("starts at level 1 and follows the curve", () => {
    expect(positionFor(0)).toMatchObject({
      level: 1,
      xpInLevel: 0,
      xpForNext: xpToNext(1),
    });
    expect(positionFor(xpToNext(1))).toMatchObject({ level: 2, xpInLevel: 0 });
    expect(positionFor(10_000_000)).toMatchObject({
      level: MAX_LEVEL,
      xpForNext: 0,
    });
  });

  it("serves a config the client parses, with the unlock track", async () => {
    const res = await fetch(`${api.base}/public/progression/config`);
    const config = ProgressionConfigSchema.parse(await res.json());
    expect(config.levels).toHaveLength(MAX_LEVEL);
    expect(config.flares).toHaveLength(UNLOCKS.length);
    expect(config.maxPrestige).toBe(0);
  });
});

describe("XP from games", () => {
  async function archive(gameID: string, won: boolean, minutes: number) {
    const record = createPartialGameRecord(
      gameID,
      testGameConfig({ gameType: GameType.Public, gameMode: GameMode.FFA }),
      [
        {
          clientID: "XPME0001",
          username: "xpplayer",
          clanTag: null,
          persistentID: me.playerId,
          stats: {},
        },
        {
          clientID: "XPOT0001",
          username: "other",
          clanTag: null,
          persistentID: null,
          stats: {},
        },
      ],
      [],
      0,
      minutes * 60_000,
      ["player", won ? "XPME0001" : "XPOT0001"],
    );
    // A tick is 100ms: num_turns is the game length in ticks.
    record.info.num_turns = minutes * 600;
    return fetch(`${api.base}/game/${gameID}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": TEST_API_KEY,
      },
      body: JSON.stringify({ ...record, gitCommit: "DEV" }, replacer),
    });
  }

  it("awards XP once per game and reports it for the end screen", async () => {
    expect((await archive("xpGame01", true, 12)).status).toBe(200);
    const res = await fetch(`${api.base}/users/@me/xp/xpGame01`, {
      headers: { authorization: `Bearer ${me.jwt}` },
    });
    const xp = GameXpResponseSchema.parse(await res.json());
    expect(xp.eligible).toBe(true);
    if (xp.eligible) {
      // 50 played + 12 min * 10 + 150 FFA win
      expect(xp.breakdown.total).toBe(320);
      expect(xp.after.level).toBe(2);
      expect(xp.levelsReached).toEqual([{ prestige: 0, level: 2 }]);
      expect(xp.flares?.map((f) => f.flareName)).toEqual([
        "pattern:grid_lock:steel",
      ]);
    }
    // Re-archiving the same game is refused and awards nothing more.
    expect((await archive("xpGame01", true, 12)).status).toBe(409);
  });

  it("grows the player's unlocked items in /users/@me", async () => {
    const me1 = UserMeResponseSchema.parse(
      await (
        await fetch(`${api.base}/users/@me`, {
          headers: { authorization: `Bearer ${me.jwt}` },
        })
      ).json(),
    );
    expect(me1.player.progress?.level).toBe(2);
    expect(me1.player.flares).toEqual(flaresForLevel(2));
  });

  it("doesn't count a game the player barely played", async () => {
    await archive("xpGame02", false, 0);
    const xp = GameXpResponseSchema.parse(
      await (
        await fetch(`${api.base}/users/@me/xp/xpGame02`, {
          headers: { authorization: `Bearer ${me.jwt}` },
        })
      ).json(),
    );
    expect(xp.eligible).toBe(false);
  });

  it("shows the public level on the profile", async () => {
    const publicId = api.ctx.accounts.getPlayer(me.playerId)!.public_id;
    const p = PublicProgressSchema.parse(
      await (
        await fetch(`${api.base}/public/player/${publicId}/progress`)
      ).json(),
    );
    expect(p.level).toBe(2);
  });
});
