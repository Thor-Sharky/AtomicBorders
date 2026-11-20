import {
  TokenPayloadSchema,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import { importJWK, jwtVerify } from "jose";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiApp, originMatcher } from "../../../src/server/api/ApiServer";
import type { ApiContext } from "../../../src/server/api/context";
import { openDb } from "../../../src/server/api/db";
import { loadSigningKeys } from "../../../src/server/api/keys";

const ISSUER = "http://localhost:8787";
const PAGE = "http://localhost:9000";

let server: http.Server;
let base: string;
let ctx: ApiContext;

beforeAll(async () => {
  delete process.env.API_SIGNING_KEY;
  const keys = await loadSigningKeys(null);
  const made = createApiApp(openDb(":memory:"), keys, {
    issuer: ISSUER,
    audience: "localhost",
    apiKey: "test-key",
    isAllowedOrigin: originMatcher("localhost"),
  });
  ctx = made.ctx;
  server = http.createServer(made.app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  delete process.env.DISCORD_CLIENT_ID;
  delete process.env.DISCORD_CLIENT_SECRET;
});

const cookieFrom = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`));

async function refresh(cookie?: string) {
  return fetch(`${base}/auth/refresh`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });
}

describe("JWKS", () => {
  it("serves one Ed25519 public key the game server can parse", async () => {
    const body = await (await fetch(`${base}/.well-known/jwks.json`)).json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      alg: "EdDSA",
      crv: "Ed25519",
      kty: "OKP",
    });
    expect(body.keys[0].x).toEqual(expect.any(String));
    expect(body.keys[0].d).toBeUndefined();
  });
});

describe("POST /auth/refresh", () => {
  it("mints a guest session when there is no cookie", async () => {
    const res = await refresh();
    expect(res.status).toBe(200);
    const { jwt, expiresIn } = await res.json();
    expect(expiresIn).toBe(900);
    expect(cookieFrom(res, "ab_refresh")).toBeDefined();

    const jwks = await (await fetch(`${base}/.well-known/jwks.json`)).json();
    const key = await importJWK(jwks.keys[0], "EdDSA");
    const { payload } = await jwtVerify(jwt, key, {
      issuer: ISSUER,
      audience: "localhost",
    });
    const claims = TokenPayloadSchema.parse(payload);
    expect(ctx.accounts.getPlayer(claims.sub)).toBeDefined();
  });

  it("rotates the refresh token: the old cookie stops working", async () => {
    const first = cookieFrom(await refresh(), "ab_refresh")!;
    const second = await refresh(first);
    expect(second.status).toBe(200);
    expect(cookieFrom(second, "ab_refresh")).not.toBe(first);
    expect((await refresh(first)).status).toBe(401);
  });

  it("keeps the same player across rotations", async () => {
    const r1 = await refresh();
    const sub1 = JSON.parse(atob((await r1.json()).jwt.split(".")[1])).sub;
    const r2 = await refresh(cookieFrom(r1, "ab_refresh"));
    const sub2 = JSON.parse(atob((await r2.json()).jwt.split(".")[1])).sub;
    expect(sub2).toBe(sub1);
  });
});

describe("logout", () => {
  it("revokes the session", async () => {
    const cookie = cookieFrom(await refresh(), "ab_refresh")!;
    const out = await fetch(`${base}/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(out.status).toBe(200);
    expect((await refresh(cookie)).status).toBe(401);
  });
});

describe("GET /users/@me", () => {
  it("returns a response the client parses, for a guest", async () => {
    const { jwt } = await (await refresh()).json();
    const res = await fetch(`${base}/users/@me`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const me = UserMeResponseSchema.parse(await res.json());
    expect(me.user.discord).toBeUndefined();
    expect(me.player.trustTier).toBe("untrusted");
  });

  it("includes a linked Discord identity and trusts the account", async () => {
    const r = await refresh();
    const { jwt } = await r.json();
    const sub = TokenPayloadSchema.parse(
      JSON.parse(atob(jwt.split(".")[1])),
    ).sub;
    ctx.accounts.loginWithIdentity(
      "discord",
      {
        providerUserId: "1234",
        profile: {
          id: "1234",
          username: "general",
          avatar: null,
          global_name: "General",
          discriminator: "0",
        },
        displayName: "General",
      },
      sub,
    );
    const me = UserMeResponseSchema.parse(
      await (
        await fetch(`${base}/users/@me`, {
          headers: { authorization: `Bearer ${jwt}` },
        })
      ).json(),
    );
    expect(me.user.discord?.username).toBe("general");
    expect(me.player.trustTier).toBe("trusted");
    expect(me.player.username).toBe("General");
  });

  it("rejects a missing or forged token", async () => {
    expect((await fetch(`${base}/users/@me`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/users/@me`, {
          headers: { authorization: "Bearer not.a.jwt" },
        })
      ).status,
    ).toBe(401);
  });
});

describe("identity linking", () => {
  const discord = (id: string) => ({
    providerUserId: id,
    profile: {
      id,
      username: "u",
      avatar: null,
      global_name: null,
      discriminator: "0",
    },
    displayName: "u",
  });

  it("attaches a new identity to the guest that signed in", () => {
    const guest = ctx.accounts.createPlayer();
    const player = ctx.accounts.loginWithIdentity(
      "discord",
      discord("g1"),
      guest.id,
    );
    expect(player.id).toBe(guest.id);
  });

  it("logs a known identity into its own player, not the guest", () => {
    const owner = ctx.accounts.loginWithIdentity(
      "discord",
      discord("k1"),
      null,
    );
    const guest = ctx.accounts.createPlayer();
    const again = ctx.accounts.loginWithIdentity(
      "discord",
      discord("k1"),
      guest.id,
    );
    expect(again.id).toBe(owner.id);
  });
});

describe("GET /auth/login/:provider", () => {
  const login = (provider: string, redirect: string) =>
    fetch(
      `${base}/auth/login/${provider}?redirect_uri=${encodeURIComponent(redirect)}`,
      { redirect: "manual" },
    );

  it("refuses a redirect_uri on another site", async () => {
    expect((await login("discord", "https://evil.example/")).status).toBe(400);
  });

  it("sends the player back with an error when the provider isn't configured", async () => {
    const res = await login("discord", `${PAGE}/`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("#login=error");
  });

  it("redirects to Discord with state and PKCE when configured", async () => {
    process.env.DISCORD_CLIENT_ID = "cid";
    process.env.DISCORD_CLIENT_SECRET = "secret";
    const res = await login("discord", `${PAGE}/`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe("https://discord.com");
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("redirect_uri")).toBe(
      `${ISSUER}/auth/callback/discord`,
    );
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(cookieFrom(res, "ab_oauth_state")).toBe(
      `ab_oauth_state=${loc.searchParams.get("state")}`,
    );
  });

  it("rejects a callback whose state wasn't issued to this browser", async () => {
    const res = await fetch(`${base}/auth/callback/discord?state=nope&code=x`, {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });
});

describe("CORS", () => {
  it("allows the game page with credentials", async () => {
    const res = await fetch(`${base}/health`, { headers: { origin: PAGE } });
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGE);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("does not allow other sites", async () => {
    const res = await fetch(`${base}/health`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("unimplemented endpoints", () => {
  it("answer 404 fast", async () => {
    expect((await fetch(`${base}/cosmetics.json`)).status).toBe(404);
  });
});
