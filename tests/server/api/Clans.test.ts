import { GameMode, GameType } from "@openfront/engine-api/game/GameTypes";
import {
  PlayerProfileSchema,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import {
  ClanBansResponseSchema,
  ClanBrowseResponseSchema,
  ClanGamesResponseSchema,
  ClanInfoSchema,
  ClanLeaderboardResponseSchema,
  ClanMembersResponseSchema,
  ClanRequestsResponseSchema,
  JoinClanResponseSchema,
  ReservedClanTagsResponseSchema,
} from "@openfront/shared/ClanApiSchemas";
import { CosmeticsSchema } from "@openfront/shared/CosmeticSchemas";
import {
  createPartialGameRecord,
  replacer,
} from "@openfront/shared/SharedUtil";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testGameConfig } from "../../util/Wire";
import { startTestApi, TEST_API_KEY, type TestApi } from "./TestApi";

let api: TestApi;
type Who = { jwt: string; playerId: string; publicId: string };
let leader: Who, officer: Who, member: Who, outsider: Who, guestOnly: Who;

let discordIds = 0;
async function linked(): Promise<Who> {
  const g = await api.guest();
  const id = `d${++discordIds}`;
  api.ctx.accounts.loginWithIdentity(
    "discord",
    {
      providerUserId: id,
      profile: {
        id,
        username: id,
        avatar: null,
        global_name: null,
        discriminator: "0",
      },
      displayName: id,
    },
    g.playerId,
  );
  return { ...g, publicId: api.ctx.accounts.getPlayer(g.playerId)!.public_id };
}

function call(who: Who | null, method: string, path: string, body?: unknown) {
  return fetch(`${api.base}${path}`, {
    method,
    headers: {
      ...(who ? { authorization: `Bearer ${who.jwt}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  api = await startTestApi();
  leader = await linked();
  officer = await linked();
  member = await linked();
  outsider = await linked();
  const g = await api.guest();
  guestOnly = {
    ...g,
    publicId: api.ctx.accounts.getPlayer(g.playerId)!.public_id,
  };
});
afterAll(() => api.close());

describe("creating a clan", () => {
  it("requires a signed-in (linked) account", async () => {
    const res = await call(guestOnly, "POST", "/clans", {
      tag: "GST",
      name: "Guests",
    });
    expect(res.status).toBe(403);
  });

  it("creates the clan with the creator as leader", async () => {
    const res = await call(leader, "POST", "/clans", {
      tag: "nuke",
      name: "Nuclear Option",
      description: "We launch first.",
      isOpen: true,
    });
    expect(res.status).toBe(201);
    const clan = ClanInfoSchema.parse(await res.json());
    expect(clan).toMatchObject({ tag: "NUKE", memberCount: 1, isOpen: true });
  });

  it("refuses a taken tag (case-insensitive) and a second clan to lead", async () => {
    expect(
      (await call(outsider, "POST", "/clans", { tag: "Nuke", name: "Again" }))
        .status,
    ).toBe(409);
    expect(
      (await call(leader, "POST", "/clans", { tag: "TWO", name: "Second" }))
        .status,
    ).toBe(409);
  });

  it("rejects a bad tag", async () => {
    expect(
      (await call(outsider, "POST", "/clans", { tag: "x!", name: "Bad" }))
        .status,
    ).toBe(400);
  });
});

describe("membership", () => {
  it("joins an open clan straight away", async () => {
    for (const who of [officer, member]) {
      const res = await call(who, "POST", "/clans/NUKE/join");
      expect(JoinClanResponseSchema.parse(await res.json()).status).toBe(
        "joined",
      );
    }
    expect((await call(member, "POST", "/clans/NUKE/join")).status).toBe(409);
  });

  it("lists members leader first, in the client's shape", async () => {
    const res = await call(null, "GET", "/clans/NUKE/members?page=1&limit=20");
    const list = ClanMembersResponseSchema.parse(await res.json());
    expect(list.total).toBe(3);
    expect(list.results[0]).toMatchObject({
      role: "leader",
      publicId: leader.publicId,
    });
  });

  it("lets only the leader promote, and officers can't kick officers", async () => {
    expect(
      (
        await call(member, "POST", "/clans/NUKE/promote", {
          targetPublicId: officer.publicId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(leader, "POST", "/clans/NUKE/promote", {
          targetPublicId: officer.publicId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(officer, "POST", "/clans/NUKE/kick", {
          targetPublicId: leader.publicId,
        })
      ).status,
    ).toBe(403);
  });

  it("keeps the leader from leaving a clan with members", async () => {
    expect((await call(leader, "POST", "/clans/NUKE/leave")).status).toBe(400);
  });

  it("shows clans in /users/@me", async () => {
    const me = UserMeResponseSchema.parse(
      await (await call(officer, "GET", "/users/@me")).json(),
    );
    expect(me.player.clans).toEqual([
      expect.objectContaining({ tag: "NUKE", role: "officer", memberCount: 3 }),
    ]);
  });
});

describe("invite-only clans", () => {
  it("turns a join into a request the officers approve", async () => {
    expect(
      (await call(officer, "PATCH", "/clans/NUKE", { isOpen: false })).status,
    ).toBe(200);
    const join = await call(outsider, "POST", "/clans/NUKE/join");
    expect(JoinClanResponseSchema.parse(await join.json()).status).toBe(
      "requested",
    );

    const reqs = ClanRequestsResponseSchema.parse(
      await (
        await call(officer, "GET", "/clans/NUKE/requests?page=1&limit=20")
      ).json(),
    );
    expect(reqs.results.map((r) => r.publicId)).toEqual([outsider.publicId]);
    expect((await call(member, "GET", "/clans/NUKE/requests")).status).toBe(
      403,
    );

    expect(
      (
        await call(officer, "POST", "/clans/NUKE/requests/approve", {
          targetPublicId: outsider.publicId,
        })
      ).status,
    ).toBe(200);
    expect(
      ClanInfoSchema.parse(
        await (await call(null, "GET", "/clans/NUKE")).json(),
      ).memberCount,
    ).toBe(4);
  });
});

describe("bans", () => {
  it("removes the member and blocks rejoining", async () => {
    expect(
      (
        await call(officer, "POST", "/clans/NUKE/ban", {
          targetPublicId: outsider.publicId,
          reason: "griefing",
        })
      ).status,
    ).toBe(200);
    expect((await call(outsider, "POST", "/clans/NUKE/join")).status).toBe(403);
    const bans = ClanBansResponseSchema.parse(
      await (await call(officer, "GET", "/clans/NUKE/bans")).json(),
    );
    expect(bans.results[0]).toMatchObject({
      publicId: outsider.publicId,
      bannedBy: officer.publicId,
      reason: "griefing",
    });
  });
});

describe("browse, reserved tags and cosmetics", () => {
  it("browses and searches clans", async () => {
    const all = ClanBrowseResponseSchema.parse(
      await (await call(null, "GET", "/clans?page=1&limit=20")).json(),
    );
    expect(all.results.map((c) => c.tag)).toContain("NUKE");
    const hit = ClanBrowseResponseSchema.parse(
      await (await call(null, "GET", "/clans?search=nucl")).json(),
    );
    expect(hit.total).toBe(1);
  });

  it("gives game servers the reserved tags", async () => {
    const res = await fetch(`${api.base}/reserved_clan_tags`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(ReservedClanTagsResponseSchema.parse(await res.json())).toEqual([
      "NUKE",
    ]);
    expect((await fetch(`${api.base}/reserved_clan_tags`)).status).toBe(401);
  });

  it("serves a valid (empty) cosmetics catalog", async () => {
    const res = await fetch(`${api.base}/cosmetics.json`);
    expect(CosmeticsSchema.safeParse(await res.json()).success).toBe(true);
  });
});

describe("clan games and leaderboard", () => {
  beforeAll(async () => {
    const config = testGameConfig({
      gameType: GameType.Public,
      gameMode: GameMode.FFA,
    });
    const record = createPartialGameRecord(
      "clanGme1",
      config,
      [
        {
          clientID: "LEAD0001",
          username: "lead",
          clanTag: "NUKE",
          persistentID: leader.playerId,
          stats: {},
        },
        // Wears the tag without being a member: must not count for the clan.
        {
          clientID: "FAKE0001",
          username: "fake",
          clanTag: "NUKE",
          persistentID: guestOnly.playerId,
          stats: {},
        },
      ],
      [],
      Date.now() - 60_000,
      Date.now(),
      ["player", "LEAD0001"],
    );
    const res = await fetch(`${api.base}/game/clanGme1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": TEST_API_KEY,
      },
      body: JSON.stringify({ ...record, gitCommit: "DEV" }, replacer),
    });
    expect(res.status).toBe(200);
  });

  it("lists the clan's games with only its members", async () => {
    const games = ClanGamesResponseSchema.parse(
      await (await call(null, "GET", "/clans/NUKE/games")).json(),
    );
    expect(games.results).toHaveLength(1);
    expect(games.results[0].result).toBe("victory");
    expect(games.results[0].clanPlayers.map((p) => p.publicId)).toEqual([
      leader.publicId,
    ]);
  });

  it("ranks the clan on the leaderboard", async () => {
    const board = ClanLeaderboardResponseSchema.parse(
      await (await call(null, "GET", "/public/clans/leaderboard")).json(),
    );
    expect(board.clans[0]).toMatchObject({
      clanTag: "NUKE",
      games: 1,
      wins: 1,
      losses: 0,
    });
  });

  it("shows the clan tag on the leader's profile", async () => {
    const profile = PlayerProfileSchema.parse(
      await (
        await call(null, "GET", `/public/player/${leader.publicId}`)
      ).json(),
    );
    expect(profile.displayClanTag).toBe("NUKE");
    expect(profile.clans?.[0]).toMatchObject({ tag: "NUKE", role: "leader" });
  });
});

describe("leadership transfer and disband", () => {
  it("hands over leadership, then the new leader disbands", async () => {
    expect(
      (
        await call(leader, "POST", "/clans/NUKE/transfer", {
          targetPublicId: officer.publicId,
        })
      ).status,
    ).toBe(200);
    expect((await call(leader, "DELETE", "/clans/NUKE")).status).toBe(403);
    expect((await call(officer, "DELETE", "/clans/NUKE")).status).toBe(200);
    expect((await call(null, "GET", "/clans/NUKE")).status).toBe(404);
  });
});
