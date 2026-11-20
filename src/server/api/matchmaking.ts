/**
 * Ranked matchmaking (1v1 and 2v2), speaking the protocol of
 * src/client/Matchmaking.ts and src/server/RankedCheckin.ts:
 *
 *   WS   /matchmaking/join?mode=1v1|2v2   player: {type:"join", jwt}
 *        <- {type:"queue-size", count}      every few seconds while queued
 *        <- {type:"match-assignment", gameId}
 *   POST /matchmaking/checkin              game worker (x-api-key), long poll:
 *        {mode, gameId, ...} -> {assignment: {players, teams}} | {}
 *
 * Players are paired by rating; the window widens the longer they wait. A
 * formed match waits for a worker of that mode to check in, then the worker
 * hosts it under the game id it offered and every player is sent that id.
 */
import { CloseCode } from "@openfront/shared/CloseCodes";
import type { Express, Request, Response } from "express";
import type http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { PlayerRow } from "./accounts";
import { type ApiContext, bearerPlayer, requireApiKey } from "./context";
import { getRating } from "./ratings";

export type RankedMode = "1v1" | "2v2";
const MODES: RankedMode[] = ["1v1", "2v2"];
const PLAYERS: Record<RankedMode, number> = { "1v1": 2, "2v2": 4 };

/** Rating gap allowed at first, growth per second waited, and its ceiling. */
const BASE_WINDOW = 100;
const WINDOW_PER_SECOND = 10;
const MAX_WINDOW = 800;
const TICK_MS = 1000;
const QUEUE_SIZE_EVERY_MS = 5000;
/** Longest a worker's check-in is held before answering "nothing yet". */
const CHECKIN_HOLD_MS = 15_000;
/** How long a player may take between connecting and sending "join". */
const JOIN_TIMEOUT_MS = 30_000;

interface Queued {
  ws: WebSocket;
  player: PlayerRow;
  rating: number;
  since: number;
}

interface PendingMatch {
  players: Queued[];
  teams: Queued[][];
}

interface WaitingWorker {
  gameId: string;
  res: Response;
  timer: ReturnType<typeof setTimeout>;
}

export class Matchmaker {
  private readonly queues: Record<RankedMode, Queued[]> = {
    "1v1": [],
    "2v2": [],
  };
  private readonly ready: Record<RankedMode, PendingMatch[]> = {
    "1v1": [],
    "2v2": [],
  };
  private readonly workers: Record<RankedMode, WaitingWorker[]> = {
    "1v1": [],
    "2v2": [],
  };
  private readonly wss = new WebSocketServer({ noServer: true });
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private sizeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ctx: ApiContext) {}

  register(app: Express) {
    app.post(
      "/matchmaking/checkin",
      requireApiKey(this.ctx),
      (req: Request, res: Response) => this.checkin(req, res),
    );
  }

  /** Accepts /matchmaking/join upgrades on the API's HTTP server and starts the loop. */
  attach(server: http.Server) {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://api");
      if (url.pathname !== "/matchmaking/join") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.onSocket(ws, url.searchParams.get("mode") ?? ""),
      );
    });
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.sizeTimer = setInterval(
      () => this.broadcastSizes(),
      QUEUE_SIZE_EVERY_MS,
    );
    server.on("close", () => this.stop());
  }

  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.sizeTimer) clearInterval(this.sizeTimer);
    for (const mode of MODES) {
      for (const w of this.workers[mode]) {
        clearTimeout(w.timer);
        w.res.json({});
      }
      this.workers[mode] = [];
    }
    for (const ws of this.wss.clients) ws.terminate();
  }

  queueSize(mode: RankedMode): number {
    return this.queues[mode].length;
  }

  // --- players -------------------------------------------------------------

  private onSocket(ws: WebSocket, mode: string) {
    if (!MODES.includes(mode as RankedMode)) {
      ws.close(CloseCode.ModeRetired, "mode_retired");
      return;
    }
    const m = mode as RankedMode;
    const joinTimer = setTimeout(
      () => ws.close(CloseCode.Unauthorized, "no join"),
      JOIN_TIMEOUT_MS,
    );
    ws.once("message", async (raw) => {
      clearTimeout(joinTimer);
      let jwt = "";
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          jwt?: string;
        };
        if (msg.type === "join" && typeof msg.jwt === "string") jwt = msg.jwt;
      } catch {
        // fall through: jwt stays empty
      }
      const player = await bearerPlayer(
        { headers: { authorization: `Bearer ${jwt}` } } as Request,
        this.ctx,
      );
      if (!player) {
        ws.close(CloseCode.Unauthorized, "invalid_token");
        return;
      }
      if (this.ctx.accounts.identities(player.id).length === 0) {
        // Ranked needs a signed-in account (the client shows why).
        ws.close(CloseCode.NotTrusted, "not_trusted");
        return;
      }
      this.enqueue(m, ws, player);
    });
    ws.on("close", () => {
      clearTimeout(joinTimer);
      for (const mm of MODES) {
        this.queues[mm] = this.queues[mm].filter((q) => q.ws !== ws);
      }
    });
  }

  private enqueue(mode: RankedMode, ws: WebSocket, player: PlayerRow) {
    // One queue slot per account: a newer tab replaces the older one.
    for (const m of MODES) {
      for (const q of this.queues[m].filter((x) => x.player.id === player.id)) {
        q.ws.close(CloseCode.Normal, "replaced");
      }
      this.queues[m] = this.queues[m].filter((x) => x.player.id !== player.id);
    }
    this.queues[mode].push({
      ws,
      player,
      rating: getRating(this.ctx.db, player.id, mode).rating,
      since: Date.now(),
    });
    this.sendSize(ws, mode);
  }

  private sendSize(ws: WebSocket, mode: RankedMode) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "queue-size", count: this.queues[mode].length }),
      );
    }
  }

  private broadcastSizes() {
    for (const mode of MODES) {
      for (const q of this.queues[mode]) this.sendSize(q.ws, mode);
    }
  }

  // --- matching ------------------------------------------------------------

  /** One matching pass; exported behaviour for tests via `tick()`. */
  tick(now = Date.now()) {
    for (const mode of MODES) {
      this.queues[mode] = this.queues[mode].filter(
        (q) => q.ws.readyState === WebSocket.OPEN,
      );
      this.form(mode, now);
      this.dispatch(mode);
    }
  }

  private window(q: Queued, now: number) {
    return Math.min(
      MAX_WINDOW,
      BASE_WINDOW + ((now - q.since) / 1000) * WINDOW_PER_SECOND,
    );
  }

  private form(mode: RankedMode, now: number) {
    const size = PLAYERS[mode];
    // Longest-waiting first, so nobody starves behind newer arrivals.
    const queue = [...this.queues[mode]].sort((a, b) => a.since - b.since);
    const used = new Set<Queued>();
    for (const anchor of queue) {
      if (used.has(anchor)) continue;
      const candidates = queue
        .filter((q) => q !== anchor && !used.has(q))
        .filter(
          (q) =>
            Math.abs(q.rating - anchor.rating) <=
            Math.max(this.window(anchor, now), this.window(q, now)),
        )
        .sort(
          (a, b) =>
            Math.abs(a.rating - anchor.rating) -
            Math.abs(b.rating - anchor.rating),
        )
        .slice(0, size - 1);
      if (candidates.length < size - 1) continue;
      const group = [anchor, ...candidates];
      group.forEach((q) => used.add(q));
      this.ready[mode].push({ players: group, teams: splitTeams(mode, group) });
    }
    this.queues[mode] = this.queues[mode].filter((q) => !used.has(q));
  }

  private dispatch(mode: RankedMode) {
    while (this.ready[mode].length > 0 && this.workers[mode].length > 0) {
      const match = this.ready[mode].shift()!;
      // Someone left while the match waited for a server: drop the match and
      // put the players still connected back in the queue.
      const live = match.players.filter(
        (q) => q.ws.readyState === WebSocket.OPEN,
      );
      if (live.length < match.players.length) {
        for (const q of live) this.queues[mode].push(q);
        continue;
      }
      const worker = this.workers[mode].shift()!;
      clearTimeout(worker.timer);
      worker.res.json({
        assignment: {
          players: match.players.map((q) => q.player.public_id),
          teams: match.teams.map((t) => t.map((q) => q.player.public_id)),
        },
      });
      for (const q of match.players) {
        q.ws.send(
          JSON.stringify({ type: "match-assignment", gameId: worker.gameId }),
        );
      }
    }
  }

  // --- game workers --------------------------------------------------------

  private checkin(req: Request, res: Response) {
    const mode = req.body?.mode as RankedMode;
    const gameId = req.body?.gameId;
    if (!MODES.includes(mode) || typeof gameId !== "string") {
      // Clan wars and unknown modes: nothing to host here.
      res.json({});
      return;
    }
    const worker: WaitingWorker = {
      gameId,
      res,
      timer: setTimeout(() => {
        this.workers[mode] = this.workers[mode].filter((w) => w !== worker);
        res.json({});
      }, CHECKIN_HOLD_MS),
    };
    // The response closing early means the worker gave up (its 20s abort).
    // Not req "close": Node fires that as soon as the body has been read.
    res.on("close", () => {
      if (!res.writableEnded) {
        clearTimeout(worker.timer);
        this.workers[mode] = this.workers[mode].filter((w) => w !== worker);
      }
    });
    this.workers[mode].push(worker);
    this.dispatch(mode);
  }
}

/** 1v1: one each. 2v2: strongest with weakest against the middle two. */
export function splitTeams<T extends { rating: number }>(
  mode: RankedMode,
  group: T[],
): T[][] {
  if (mode === "1v1") return [[group[0]], [group[1]]];
  const s = [...group].sort((a, b) => b.rating - a.rating);
  return [
    [s[0], s[3]],
    [s[1], s[2]],
  ];
}
