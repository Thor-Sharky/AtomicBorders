# Atomic Borders API

Atomic Borders runs its own replacement for OpenFront's closed-source API
(accounts, sign-in, stats, leaderboards, clans, ranked). It lives in
`src/server/api/`, starts inside the game server's master process, and speaks
the same contract the client and game server already use:

| Where | API address |
| --- | --- |
| Local dev | `http://localhost:8787` |
| Production | `https://api.<DOMAIN>` (proxy it to `API_PORT`) |

Data is a SQLite file, `DATA_DIR/atomic.db`, plus the JWT signing key
`DATA_DIR/signing-key.json` (generated on first boot). Back both up; losing the
key signs everyone out, losing the database loses accounts and stats.

## Sign-in setup

Secrets go in `.env.local` (gitignored). The server loads it on start.

### Discord

1. Open https://discord.com/developers/applications and click **New Application**
   (name it "Atomic Borders").
2. Go to **OAuth2**. Copy the **Client ID**, then **Reset Secret** and copy the
   **Client Secret**.
3. Under **Redirects**, add:
   - `http://localhost:8787/auth/callback/discord` (dev)
   - `https://api.<your-domain>/auth/callback/discord` (production)
4. In `.env.local`:
   ```
   DISCORD_CLIENT_ID=...
   DISCORD_CLIENT_SECRET=...
   ```

### Google

1. Open https://console.cloud.google.com/, create a project, then go to
   **APIs & Services > OAuth consent screen** and set it up as **External**
   (app name "Atomic Borders", scopes `openid` and `email`).
2. **Credentials > Create credentials > OAuth client ID**, type **Web application**.
3. **Authorized redirect URIs**:
   - `http://localhost:8787/auth/callback/google` (dev)
   - `https://api.<your-domain>/auth/callback/google` (production)
4. In `.env.local`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

Restart the server after changing `.env.local`.

## How sessions work

- Every visitor gets a session: `POST /auth/refresh` without a cookie creates a
  guest player. Signing in with Discord or Google attaches that identity to the
  guest, so stats earned as a guest are kept.
- The refresh token is an HttpOnly cookie (30 days, rotated on every refresh).
  The JWT lives 15 minutes and is verified by game servers with the public key
  at `/.well-known/jwks.json`.
- Game servers call server-only routes with `x-api-key: $API_KEY`.

Not available (OpenFront paid/platform features): store, cosmetics,
subscriptions, Steam, email magic links, clan funds.
