/**
 * Generates Atomic Borders' original music and alert sound with ElevenLabs.
 *
 * Run once, offline, by a developer; the results are committed as ordinary
 * audio files in resources/, so players and the game server never need an
 * ElevenLabs key. The SDK reads ELEVENLABS_API_KEY from the environment:
 *
 *   npm run gen-audio                 # generate only files that are missing
 *   npm run gen-audio -- --force      # regenerate everything
 *   npm run gen-audio -- menu-theme   # (re)generate just the named tracks
 *
 * (gen-audio loads .env.local via `node --env-file`; never put the key in code.)
 */
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Asset =
  | {
      kind: "music";
      name: string;
      out: string;
      lengthMs: number;
      prompt: string;
    }
  | {
      kind: "sfx";
      name: string;
      out: string;
      seconds: number;
      prompt: string;
    };

// Shared direction so the four tracks sound like one soundtrack.
const STYLE =
  "Instrumental only, no vocals. Cold-war tactical strategy game score: " +
  "dark analog synthesizers, deep pulsing bass, cinematic military percussion, " +
  "tense and atmospheric, clean mix, suitable as a seamless background loop.";

const ASSETS: Asset[] = [
  {
    kind: "music",
    name: "menu-theme",
    out: "resources/sounds/music/menu-theme.mp3",
    lengthMs: 90_000,
    prompt: `${STYLE} Main menu theme: slow and brooding, wide atmospheric pads, a distant radar-like synth ping, a restrained snare roll building quietly, ominous but inviting.`,
  },
  {
    kind: "music",
    name: "gameplay",
    out: "resources/sounds/music/gameplay.mp3",
    lengthMs: 120_000,
    prompt: `${STYLE} In-game track: steady mid-tempo pulse, driving sequenced bass arpeggio, low strings, focused and strategic, keeps momentum without distracting.`,
  },
  {
    kind: "music",
    name: "gameplay-2",
    out: "resources/sounds/music/gameplay-2.mp3",
    lengthMs: 120_000,
    prompt: `${STYLE} In-game track: rising tension, heavier taiko-style drums, brass-like synth stabs, a sense of escalating conflict and mobilization.`,
  },
  {
    kind: "music",
    name: "gameplay-3",
    out: "resources/sounds/music/gameplay-3.mp3",
    lengthMs: 120_000,
    prompt: `${STYLE} In-game track: eerie and sparse, Geiger-counter-like ticking textures, low drones, slow heartbeat kick, the calm before a nuclear exchange.`,
  },
  {
    kind: "sfx",
    name: "game-start-alert",
    out: "resources/sounds/effects/game-start-alert.mp3",
    seconds: 2.5,
    prompt:
      "Military command center alert: two rising electronic warning tones followed by a short radar ping, clean, punchy, no voice.",
  },
];

/** Collects an SDK audio response (Node or web stream) into one buffer. */
async function toBuffer(audio: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  if (audio && typeof (audio as ReadableStream).getReader === "function") {
    const reader = (audio as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } else {
    for await (const chunk of audio as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error(
      "ELEVENLABS_API_KEY is not set. Run `npx -y @elevenlabs/cli@latest onboard init`, then `npm run gen-audio`.",
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const only = args.filter((a) => !a.startsWith("--"));
  const unknown = only.filter((n) => !ASSETS.some((a) => a.name === n));
  if (unknown.length > 0) {
    console.error(
      `Unknown asset(s): ${unknown.join(", ")}. Known: ${ASSETS.map((a) => a.name).join(", ")}`,
    );
    process.exit(1);
  }

  const client = new ElevenLabsClient();
  let failed = 0;

  for (const asset of ASSETS) {
    if (only.length > 0 && !only.includes(asset.name)) continue;
    const outPath = path.join(root, asset.out);
    if (!force && only.length === 0 && fs.existsSync(outPath)) {
      console.log(`skip  ${asset.name} (exists; --force to regenerate)`);
      continue;
    }

    console.log(`gen   ${asset.name} ...`);
    try {
      const audio =
        asset.kind === "music"
          ? await client.music.compose({
              prompt: asset.prompt,
              musicLengthMs: asset.lengthMs,
              modelId: "music_v2_5",
            })
          : await client.textToSoundEffects.convert({
              text: asset.prompt,
              modelId: "eleven_text_to_sound_v3",
              durationSeconds: asset.seconds,
              promptInfluence: 0.6,
            });
      const bytes = await toBuffer(audio);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, bytes);
      console.log(
        `wrote ${asset.out} (${(bytes.length / 1024).toFixed(0)} KiB)`,
      );
    } catch (err) {
      failed++;
      console.error(
        `FAIL  ${asset.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (failed > 0) process.exit(1);
}

await main();
