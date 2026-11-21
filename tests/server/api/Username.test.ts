import {
  PutUsernameResponseSchema,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveVerifiedJoin } from "../../../src/server/Privilege";
import { startTestApi, type TestApi } from "./TestApi";

let api: TestApi;
let ids = 0;

beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());

async function linked(displayName: string) {
  const g = await api.guest();
  const id = `u${++ids}`;
  api.ctx.accounts.loginWithIdentity(
    "discord",
    {
      providerUserId: id,
      profile: {
        id,
        username: id,
        avatar: null,
        global_name: displayName,
        discriminator: "0",
      },
      displayName,
    },
    g.playerId,
  );
  return g;
}

async function me(jwt: string) {
  const res = await fetch(`${api.base}/users/@me`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  return UserMeResponseSchema.parse(await res.json());
}

function rename(jwt: string, username: string, acceptSuffixed = false) {
  return fetch(`${api.base}/users/@me/username`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(
      acceptSuffixed ? { username, acceptSuffixed } : { username },
    ),
  });
}

describe("verified names", () => {
  it("are free for a signed-in account", async () => {
    const a = await linked("Commander");
    const m = await me(a.jwt);
    expect(m.player.usernameStatus).toBe("indefinite");
    expect(m.player.username).toBe("Commander");
    expect(m.player.usernameBase).toBe("Commander");
    // The game server grants the verified check for this account.
    expect(resolveVerifiedJoin({ verified: true }, "Commander", m.player)).toBe(
      "verified",
    );
  });

  it("go to the first claimant; a later one is shown with a number", async () => {
    const b = await linked("commander");
    const m = await me(b.jwt);
    expect(m.player.username).toMatch(/^commander\.\d{4}$/);
    expect(resolveVerifiedJoin({ verified: true }, "commander", m.player)).toBe(
      "custom",
    );
  });

  it("aren't offered to guests", async () => {
    const g = await api.guest();
    expect((await me(g.jwt)).player.usernameStatus).toBe("unclaimed");
  });
});

describe("renaming", () => {
  it("claims a free name bare", async () => {
    const a = await linked("Rookie");
    const res = await rename(a.jwt, "Warhawk");
    const body = PutUsernameResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      username: "Warhawk",
      base: "Warhawk",
      usernameStatus: "indefinite",
    });
    expect((await me(a.jwt)).player.username).toBe("Warhawk");
  });

  it("asks before taking a held name with a number", async () => {
    const a = await linked("Someone");
    const held = await rename(a.jwt, "warhawk");
    expect(held.status).toBe(409);
    expect((await held.json()).code).toBe("BARE_NAME_TAKEN");
    const res = await rename(a.jwt, "warhawk", true);
    const body = PutUsernameResponseSchema.parse(await res.json());
    expect(body.username).toMatch(/^warhawk\.\d{4}$/);
  });

  it("doesn't let an older account take a name someone already claimed", async () => {
    // "Commander" was claimed above; an account renaming onto it later must
    // not displace the holder, whatever the accounts' ages.
    const a = await linked("Latecomer");
    await rename(a.jwt, "Commander", true);
    expect((await me(a.jwt)).player.username).toMatch(/^Commander\.\d{4}$/);
  });

  it("rejects invalid names and guests", async () => {
    const a = await linked("Valid");
    expect((await rename(a.jwt, "x")).status).toBe(400);
    expect((await rename(a.jwt, "bad!name")).status).toBe(400);
    const g = await api.guest();
    expect((await rename(g.jwt, "GuestName")).status).toBe(400);
  });
});
