/**
 * Discord and Google OAuth 2.0 (authorization code + PKCE), with plain fetch.
 * Client IDs and secrets come from the environment (.env.local in dev):
 * DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET, GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
 */
import crypto from "node:crypto";

export type ProviderName = "discord" | "google";

export interface ProviderProfile {
  providerUserId: string;
  /** Stored as-is and echoed in /users/@me (DiscordUserSchema / GoogleUserSchema). */
  profile: Record<string, unknown>;
  /** Suggested display name, or null. Never an email address. */
  displayName: string | null;
}

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
  fetchProfile: (accessToken: string) => Promise<ProviderProfile>;
}

const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  discord: {
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    scope: "identify",
    clientId: () => process.env.DISCORD_CLIENT_ID,
    clientSecret: () => process.env.DISCORD_CLIENT_SECRET,
    async fetchProfile(accessToken) {
      const res = await fetch("https://discord.com/api/users/@me", {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`discord profile: ${res.status}`);
      const u = (await res.json()) as {
        id: string;
        username: string;
        avatar: string | null;
        global_name: string | null;
        discriminator?: string;
      };
      return {
        providerUserId: u.id,
        profile: {
          id: u.id,
          username: u.username,
          avatar: u.avatar,
          global_name: u.global_name,
          discriminator: u.discriminator ?? "0",
        },
        displayName: u.global_name ?? u.username,
      };
    },
  },
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email",
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    async fetchProfile(accessToken) {
      const res = await fetch(
        "https://openidconnect.googleapis.com/v1/userinfo",
        {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) throw new Error(`google profile: ${res.status}`);
      const u = (await res.json()) as { sub: string; email?: string };
      return {
        providerUserId: u.sub,
        profile: { email: u.email ?? "" },
        displayName: null,
      };
    },
  },
};

export function isProvider(name: string): name is ProviderName {
  return name === "discord" || name === "google";
}

export function providerConfigured(name: ProviderName): boolean {
  const p = PROVIDERS[name];
  return !!p.clientId() && !!p.clientSecret();
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

export function authorizeUrl(
  name: ProviderName,
  opts: { callbackUrl: string; state: string; challenge: string },
): string {
  const p = PROVIDERS[name];
  const u = new URL(p.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId() ?? "");
  u.searchParams.set("scope", p.scope);
  u.searchParams.set("redirect_uri", opts.callbackUrl);
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (name === "discord") u.searchParams.set("prompt", "none");
  return u.toString();
}

/** Exchanges an authorization code and returns the provider profile. */
export async function exchangeCode(
  name: ProviderName,
  opts: { code: string; verifier: string; callbackUrl: string },
): Promise<ProviderProfile> {
  const p = PROVIDERS[name];
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.callbackUrl,
      client_id: p.clientId() ?? "",
      client_secret: p.clientSecret() ?? "",
      code_verifier: opts.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${name} token exchange: ${res.status}`);
  const { access_token } = (await res.json()) as { access_token?: string };
  if (!access_token) throw new Error(`${name} token exchange: no access_token`);
  return p.fetchProfile(access_token);
}
