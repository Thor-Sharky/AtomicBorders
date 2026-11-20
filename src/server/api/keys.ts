/**
 * Ed25519 signing key for API-issued JWTs. The game server verifies them
 * with the public half from /.well-known/jwks.json (src/server/jwt.ts).
 *
 * Loaded from API_SIGNING_KEY (a private JWK as JSON) when set, otherwise
 * from <dataDir>/signing-key.json, generated on first boot.
 */
import { uuidToBase64url } from "@openfront/shared/Base64";
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from "jose";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const JWT_TTL_SECONDS = 15 * 60;

export interface SigningKeys {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export async function loadSigningKeys(
  dataDir: string | null,
): Promise<SigningKeys> {
  let privateJwk: JWK | null = null;
  const fromEnv = process.env.API_SIGNING_KEY;
  const file = dataDir ? path.join(dataDir, "signing-key.json") : null;
  if (fromEnv) {
    privateJwk = JSON.parse(fromEnv) as JWK;
  } else if (file && fs.existsSync(file)) {
    privateJwk = JSON.parse(fs.readFileSync(file, "utf8")) as JWK;
  }
  if (privateJwk === null) {
    const { privateKey } = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    privateJwk = await exportJWK(privateKey);
    privateJwk.kid = crypto.randomUUID();
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(privateJwk), { mode: 0o600 });
    }
  }
  const kid = privateJwk.kid ?? "atomic-borders";
  const privateKey = (await importJWK(
    { ...privateJwk, alg: "EdDSA" },
    "EdDSA",
  )) as CryptoKey;
  const publicJwk: JWK = { ...privateJwk };
  delete publicJwk.d;
  return {
    kid,
    privateKey,
    publicJwk: { ...publicJwk, kid, alg: "EdDSA", use: "sig" },
  };
}

export async function signPlayerJwt(
  keys: SigningKeys,
  opts: {
    playerId: string;
    issuer: string;
    audience: string;
    role: string | null;
    provider: string | null;
  },
): Promise<string> {
  const claims: Record<string, string> = {};
  if (opts.role) claims.role = opts.role;
  if (opts.provider) claims.provider = opts.provider;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: keys.kid })
    .setJti(crypto.randomUUID())
    .setSubject(uuidToBase64url(opts.playerId))
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setIssuedAt()
    .setExpirationTime(`${JWT_TTL_SECONDS}s`)
    .sign(keys.privateKey);
}
