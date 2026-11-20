import {
  GameMode,
  GameType,
  RankedType,
} from "@openfront/engine-api/game/GameTypes";
import { RankedLeaderboardResponseSchema } from "@openfront/shared/ApiSchemas";
import { CloseCode } from "@openfront/shared/CloseCodes";
import {
  createPartialGameRecord,
  replacer,
} from "@openfront/shared/SharedUtil";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { splitTeams } from "../../../src/server/api/matchmaking";
import { testGameConfig } from "../../util/Wire";
import { startTestApi, TEST_API_KEY, type TestApi } from "./TestApi";

let api: TestApi;
type Who = { jwt: string; playerId: string; publicId: string };

let discordIds = 0;
async function linked(): Promise<Who> {
  const g = await api.guest();
  const id = `mm${++discordIds}`;
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

interface Client {
  ws: WebSocket;
  messages: { type: string; [k: string]: unknown }[];
  closed: Promise<number>;
}

function connect(mode: string, jwt: string | null): Promise<Client> {
  const ws = new WebSocket(
    `${api.base.replace("http", "ws")}/matchmaking/join?mode=${mode}`,
  );
  const messages: Client["messages"] = [];
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  return new Promise((resolve) => {
    ws.on("open", () => {
      if (jwt !== null) ws.send(JSON.stringify({ type: "join", jwt }));
      resolve({ ws, messages, closed });
    });
  });
}

function checkin(mode: string, gameId: string) {
  return fetch(`${api.base}/matchmaking/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
    body: JSON.stringify({ id: 0, gameId, ccu: 0, mode }),
  }).then((r) => r.json());
}

beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());

describe("joining the queue", () => {
  it("refuses a guest account: ranked needs sign-in", async () => {
    const g = await api.guest();
    const c = await connect("1v1", g.jwt);
    expect(await c.closed).toBe(CloseCode.NotTrusted);
  });

  it("refuses a mode that doesn't exist", async () => {
    const p = await linked();
    const c = await connect("clanwars", p.jwt);
    expect(await c.closed).toBe(CloseCode.ModeRetired);
  });

  it("refuses a bad token", async () => {
    const c = await connect("1v1", "nope");
    expect(await c.closed).toBe(CloseCode.Unauthorized);
  });

  it("reports the queue size once queued, and replaces an older tab", async () => {
    const p = await linked();
    const first = await connect("2v2", p.jwt);
    await vi.waitFor(() =>
      expect(first.messages[0]).toEqual({ type: "queue-size", count: 1 }),
    );
    const second = await connect("2v2", p.jwt);
    expect(await first.closed).toBe(CloseCode.Normal);
    await vi.waitFor(() => expect(api.matchmaker.queueSize("2v2")).toBe(1));
    second.ws.close();
    await vi.waitFor(() => expect(api.matchmaker.queueSize("2v2")).toBe(0));
  });
});

describe("matching", () => {
  it("pairs two 1v1 players and hands the match to a worker", async () => {
    const a = await linked();
    const b = await linked();
    const ca = await connect("1v1", a.jwt);
    const cb = await connect("1v1", b.jwt);
    await vi.waitFor(() => expect(api.matchmaker.queueSize("1v1")).toBe(2));

    const worker = await checkin("1v1", "rankGme1");
    expect(worker.assignment.players.sort()).toEqual(
      [a.publicId, b.publicId].sort(),
    );
    expect(worker.assignment.teams).toHaveLength(2);

    for (const c of [ca, cb]) {
      await vi.waitFor(() =>
        expect(c.messages).toContainEqual({
          type: "match-assignment",
          gameId: "rankGme1",
        }),
      );
      c.ws.close();
    }
  });

  it("holds a worker's check-in until a match forms", async () => {
    const pending = checkin("1v1", "rankGme2");
    const a = await linked();
    const b = await linked();
    const ca = await connect("1v1", a.jwt);
    const cb = await connect("1v1", b.jwt);
    const worker = await pending;
    expect(worker.assignment.players).toHaveLength(2);
    ca.ws.close();
    cb.ws.close();
  });

  it("doesn't pair players far apart in rating until they've waited", () => {
    const now = 1_000_000;
    const mm = api.matchmaker as unknown as {
      queues: Record<
        string,
        {
          rating: number;
          since: number;
          ws: { readyState: number };
          player: unknown;
        }[]
      >;
      ready: Record<string, unknown[]>;
      form: (mode: string, now: number) => void;
    };
    const open = { readyState: WebSocket.OPEN };
    mm.queues["1v1"] = [
      { rating: 1000, since: now, ws: open, player: {} },
      { rating: 1500, since: now, ws: open, player: {} },
    ];
    mm.ready["1v1"] = [];
    mm.form("1v1", now);
    expect(mm.ready["1v1"]).toHaveLength(0);
    // 40s later the window is 100 + 40*10 = 500: close enough.
    mm.form("1v1", now + 40_000);
    expect(mm.ready["1v1"]).toHaveLength(1);
    mm.queues["1v1"] = [];
    mm.ready["1v1"] = [];
  });

  it("balances 2v2 teams: strongest with weakest", () => {
    const [t1, t2] = splitTeams("2v2", [
      { rating: 1200 },
      { rating: 900 },
      { rating: 1100 },
      { rating: 1000 },
    ]);
    expect(t1.map((p) => p.rating)).toEqual([1200, 900]);
    expect(t2.map((p) => p.rating)).toEqual([1100, 1000]);
  });
});

describe("ranked results", () => {
  it("moves the 1v1 ladder when a ranked game is archived", async () => {
    const a = await linked();
    const b = await linked();
    const record = createPartialGameRecord(
      "rnkDone1",
      testGameConfig({
        gameType: GameType.Public,
        gameMode: GameMode.FFA,
        rankedType: RankedType.OneVOne,
      }),
      [
        {
          clientID: "RANKA001",
          username: "alpha",
          clanTag: null,
          persistentID: a.playerId,
          stats: {},
        },
        {
          clientID: "RANKB001",
          username: "bravo",
          clanTag: null,
          persistentID: b.playerId,
          stats: {},
        },
      ],
      [],
      Date.now() - 60_000,
      Date.now(),
      ["player", "RANKB001"],
    );
    const res = await fetch(`${api.base}/game/rnkDone1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": TEST_API_KEY,
      },
      body: JSON.stringify({ ...record, gitCommit: "DEV" }, replacer),
    });
    expect(res.status).toBe(200);
    const board = RankedLeaderboardResponseSchema.parse(
      await (await fetch(`${api.base}/leaderboard/ranked?page=1`)).json(),
    );
    const ladder = board[RankedType.OneVOne];
    expect(ladder[0]).toMatchObject({
      public_id: b.publicId,
      elo: 1016,
      wins: 1,
    });
    expect(ladder[1]).toMatchObject({
      public_id: a.publicId,
      elo: 984,
      losses: 1,
    });
    // A ranked 1v1 doesn't also count toward the public FFA ladder.
    expect(board[RankedType.FreeForAll].map((r) => r.public_id)).not.toContain(
      b.publicId,
    );
  });
});
