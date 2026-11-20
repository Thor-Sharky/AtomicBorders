import { TokenPayloadSchema } from "@openfront/shared/ApiSchemas";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApiApp, originMatcher } from "../../../src/server/api/ApiServer";
import type { ApiContext } from "../../../src/server/api/context";
import { openDb } from "../../../src/server/api/db";
import { loadSigningKeys } from "../../../src/server/api/keys";
import type { Matchmaker } from "../../../src/server/api/matchmaking";

export const TEST_ISSUER = "http://localhost:8787";
export const TEST_API_KEY = "test-key";

export interface TestApi {
  base: string;
  ctx: ApiContext;
  matchmaker: Matchmaker;
  close: () => void;
  /** A fresh guest session: its JWT, refresh cookie and player id. */
  guest: () => Promise<{ jwt: string; cookie: string; playerId: string }>;
}

/** Boots the API on a random port with an in-memory database. */
export async function startTestApi(): Promise<TestApi> {
  delete process.env.API_SIGNING_KEY;
  const keys = await loadSigningKeys(null);
  const { app, ctx, matchmaker } = createApiApp(openDb(":memory:"), keys, {
    issuer: TEST_ISSUER,
    audience: "localhost",
    apiKey: TEST_API_KEY,
    isAllowedOrigin: originMatcher("localhost"),
  });
  const server = http.createServer(app);
  matchmaker.attach(server);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    ctx,
    matchmaker,
    close: () => {
      matchmaker.stop();
      server.close();
    },
    async guest() {
      const res = await fetch(`${base}/auth/refresh`, { method: "POST" });
      const cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .find((c) => c.startsWith("ab_refresh="))!;
      const { jwt } = await res.json();
      const playerId = TokenPayloadSchema.parse(
        JSON.parse(atob(jwt.split(".")[1])),
      ).sub;
      return { jwt, cookie, playerId };
    },
  };
}
