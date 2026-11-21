/**
 * The Atomic Borders cosmetics catalog: original patterns, colour palettes and
 * effects, unlocked by player level instead of bought. Served as
 * /cosmetics.json in CosmeticsSchema shape (packages/shared/src/
 * CosmeticSchemas.ts). No item carries a product or price, so the client never
 * offers one for sale; ownership comes only from `player.flares`, which
 * /users/@me fills from UNLOCKS below.
 */

/** Encodes a bitmap for decodePatternData: rows of "#" (secondary) / "." (primary). */
export function encodePattern(rows: string[], scale: number): string {
  const height = rows.length;
  const width = rows[0].length;
  if (width < 2 || width > 129 || height < 2 || height > 65) {
    throw new Error("pattern size out of range");
  }
  if (rows.some((r) => r.length !== width)) throw new Error("ragged pattern");
  const bits = new Uint8Array(3 + Math.ceil((width * height) / 8));
  bits[0] = 0; // version
  bits[1] = (scale & 0x07) | (((width - 2) & 0x1f) << 3);
  bits[2] = (((width - 2) >> 5) & 0x03) | (((height - 2) & 0x3f) << 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rows[y][x] === "#") {
        const idx = y * width + x;
        bits[3 + (idx >> 3)] |= 1 << (idx & 7);
      }
    }
  }
  return Buffer.from(bits).toString("base64url");
}

const PALETTES = {
  olive: { name: "olive", primaryColor: "#7d8f4e", secondaryColor: "#4a5a2c" },
  amber: { name: "amber", primaryColor: "#e8b33f", secondaryColor: "#7a5512" },
  steel: { name: "steel", primaryColor: "#8a9aa8", secondaryColor: "#3c4a56" },
  crimson: {
    name: "crimson",
    primaryColor: "#c8423a",
    secondaryColor: "#5e1814",
  },
  glacier: {
    name: "glacier",
    primaryColor: "#a8d8e8",
    secondaryColor: "#3e7890",
  },
  toxic: { name: "toxic", primaryColor: "#b6e04a", secondaryColor: "#2f4a10" },
  night: { name: "night", primaryColor: "#3a4660", secondaryColor: "#141a28" },
  ivory: { name: "ivory", primaryColor: "#ece6d2", secondaryColor: "#9a9078" },
} as const;
type PaletteName = keyof typeof PALETTES;

interface PatternDef {
  name: string;
  rarity: string;
  scale: number;
  rows: string[];
  palettes: PaletteName[];
}

const PATTERNS: PatternDef[] = [
  {
    name: "frontier_stripes",
    rarity: "common",
    scale: 1,
    rows: ["####....", "####....", "####....", "####...."],
    palettes: ["olive", "steel"],
  },
  {
    name: "hazard_tape",
    rarity: "uncommon",
    scale: 1,
    rows: ["##..##..", ".##..##.", "..##..##", "#..##..#"],
    palettes: ["amber", "crimson"],
  },
  {
    name: "grid_lock",
    rarity: "common",
    scale: 1,
    rows: ["#.......", "#.......", "#.......", "########"],
    palettes: ["steel", "toxic"],
  },
  {
    name: "chevron_march",
    rarity: "uncommon",
    scale: 1,
    rows: ["#......#", ".#....#.", "..#..#..", "...##..."],
    palettes: ["olive", "amber"],
  },
  {
    name: "radar_rings",
    rarity: "rare",
    scale: 0,
    rows: [
      "..######..",
      ".#......#.",
      "#..####..#",
      "#.#....#.#",
      "#.#.##.#.#",
      "#.#.##.#.#",
      "#.#....#.#",
      "#..####..#",
      ".#......#.",
      "..######..",
    ],
    palettes: ["toxic", "glacier"],
  },
  {
    name: "hex_mesh",
    rarity: "rare",
    scale: 0,
    rows: ["..##....", ".#..#...", "#....###", ".#..#...", "..##...."],
    palettes: ["night", "steel"],
  },
  {
    name: "fallout_dots",
    rarity: "epic",
    scale: 1,
    rows: ["#...", "....", "..#.", "...."],
    palettes: ["toxic", "crimson"],
  },
  {
    name: "border_steps",
    rarity: "legendary",
    scale: 0,
    rows: [
      "##......",
      ".##.....",
      "..##....",
      "...##...",
      "....##..",
      ".....##.",
      "......##",
      "#......#",
    ],
    palettes: ["ivory", "amber"],
  },
];

type EffectType =
  | "nukeTrail"
  | "nukeExplosion"
  | "transportShipTrail"
  | "structures"
  | "warship"
  | "train"
  | "railroad";

interface EffectDef {
  name: string;
  effectType: EffectType;
  rarity: string;
  attributes: Record<string, unknown>;
}

const EFFECTS: EffectDef[] = [
  // Nuke trails
  {
    name: "ember_wake",
    effectType: "nukeTrail",
    rarity: "common",
    attributes: {
      type: "gradient",
      colors: ["#e8b33f", "#e0573f", "#5e1814"],
      colorSize: 6,
      movementSpeed: 20,
    },
  },
  {
    name: "isotope_trail",
    effectType: "nukeTrail",
    rarity: "rare",
    attributes: {
      type: "transition",
      colors: ["#b6e04a", "#4ad9a8", "#b6e04a"],
      frequency: 1.2,
    },
  },
  {
    name: "warhead_helix",
    effectType: "nukeTrail",
    rarity: "legendary",
    attributes: {
      type: "spiral",
      colors: ["#ece6d2", "#e8b33f"],
      radius: 2,
      strands: 2,
      rotationSpeed: 6,
    },
  },
  // Nuke explosions
  {
    name: "pressure_wave",
    effectType: "nukeExplosion",
    rarity: "uncommon",
    attributes: {
      type: "shockwave",
      nukeType: "atom",
      colors: ["#ece6d2", "#e8b33f", "#e0573f"],
      size: 60,
      speed: 45,
      thickness: 4,
      transitionSpeed: 2,
    },
  },
  {
    name: "green_flash",
    effectType: "nukeExplosion",
    rarity: "epic",
    attributes: {
      type: "sparkles",
      nukeType: "atom",
      colors: ["#b6e04a", "#e6ffb0", "#4ad9a8"],
      size: 70,
      speed: 50,
      thickness: 1.5,
      transitionSpeed: 3,
      density: 80,
    },
  },
  {
    name: "fusion_embers",
    effectType: "nukeExplosion",
    rarity: "legendary",
    attributes: {
      type: "embers",
      nukeType: "hydro",
      colors: ["#ffe9a8", "#e8b33f", "#c8423a"],
      size: 110,
      speed: 55,
      thickness: 2,
      transitionSpeed: 2,
      density: 120,
    },
  },
  // Transport ship trails
  {
    name: "convoy_wake",
    effectType: "transportShipTrail",
    rarity: "common",
    attributes: {
      type: "gradient",
      colors: ["#a8d8e8", "#3e7890"],
      colorSize: 4,
      movementSpeed: 12,
    },
  },
  {
    name: "signal_flare_wake",
    effectType: "transportShipTrail",
    rarity: "rare",
    attributes: {
      type: "transition",
      colors: ["#e8b33f", "#e0573f"],
      frequency: 1.5,
    },
  },
  // Structures
  {
    name: "command_glow",
    effectType: "structures",
    rarity: "uncommon",
    attributes: {
      type: "gradient",
      colors: ["#9fd46b", "#e8b33f"],
      colorSize: 1,
      movementSpeed: 0.4,
    },
  },
  {
    name: "alert_status",
    effectType: "structures",
    rarity: "epic",
    attributes: {
      type: "transition",
      colors: ["#c8423a", "#e8b33f", "#c8423a"],
      frequency: 1,
    },
  },
  // Warships
  {
    name: "navy_steel",
    effectType: "warship",
    rarity: "uncommon",
    attributes: {
      type: "gradient",
      colors: ["#8a9aa8", "#3c4a56"],
      colorSize: 1,
      movementSpeed: 0.3,
    },
  },
  {
    name: "dreadnought_red",
    effectType: "warship",
    rarity: "epic",
    attributes: {
      type: "transition",
      colors: ["#c8423a", "#5e1814"],
      frequency: 0.8,
    },
  },
  // Trains and railroads
  {
    name: "supply_line",
    effectType: "train",
    rarity: "uncommon",
    attributes: {
      type: "gradient",
      colors: ["#e8b33f", "#7a5512"],
      colorSize: 1,
      movementSpeed: 0.5,
    },
  },
  {
    name: "rail_glow",
    effectType: "railroad",
    rarity: "rare",
    attributes: {
      type: "gradient",
      colors: ["#9fd46b", "#2f4a10"],
      colorSize: 4,
      movementSpeed: 6,
    },
  },
];

/**
 * The level each item unlocks at. Flare strings are what the client and the
 * game server's PrivilegeChecker look for in `player.flares`.
 */
export const UNLOCKS: { flare: string; level: number }[] = [
  { flare: "pattern:frontier_stripes:olive", level: 1 },
  { flare: "effect:ember_wake", level: 1 },
  { flare: "pattern:grid_lock:steel", level: 2 },
  { flare: "effect:convoy_wake", level: 3 },
  { flare: "pattern:frontier_stripes:steel", level: 4 },
  { flare: "pattern:chevron_march:olive", level: 5 },
  { flare: "effect:command_glow", level: 6 },
  { flare: "pattern:hazard_tape:amber", level: 8 },
  { flare: "effect:pressure_wave", level: 10 },
  { flare: "pattern:grid_lock:toxic", level: 12 },
  { flare: "effect:navy_steel", level: 14 },
  { flare: "pattern:chevron_march:amber", level: 16 },
  { flare: "effect:supply_line", level: 18 },
  { flare: "pattern:radar_rings:toxic", level: 20 },
  { flare: "effect:isotope_trail", level: 22 },
  { flare: "pattern:hex_mesh:night", level: 25 },
  { flare: "effect:signal_flare_wake", level: 27 },
  { flare: "pattern:hazard_tape:crimson", level: 30 },
  { flare: "effect:rail_glow", level: 32 },
  { flare: "pattern:radar_rings:glacier", level: 35 },
  { flare: "effect:alert_status", level: 38 },
  { flare: "pattern:hex_mesh:steel", level: 40 },
  { flare: "effect:dreadnought_red", level: 43 },
  { flare: "pattern:fallout_dots:toxic", level: 45 },
  { flare: "effect:green_flash", level: 48 },
  { flare: "pattern:fallout_dots:crimson", level: 50 },
  { flare: "effect:warhead_helix", level: 55 },
  { flare: "pattern:border_steps:ivory", level: 58 },
  { flare: "effect:fusion_embers", level: 60 },
  { flare: "pattern:border_steps:amber", level: 65 },
];

/** Every flare unlocked at or below `level`. */
export function flaresForLevel(level: number): string[] {
  return UNLOCKS.filter((u) => u.level <= level).map((u) => u.flare);
}

function buildCatalog() {
  const colorPalettes: Record<string, unknown> = {};
  for (const p of Object.values(PALETTES)) colorPalettes[p.name] = p;

  const patterns: Record<string, unknown> = {};
  for (const p of PATTERNS) {
    patterns[p.name] = {
      name: p.name,
      product: null,
      rarity: p.rarity,
      artist: "Atomic Borders",
      pattern: encodePattern(p.rows, p.scale),
      colorPalettes: p.palettes.map((name) => ({ name, isArchived: false })),
    };
  }

  const effects: Record<string, Record<string, unknown>> = {};
  for (const e of EFFECTS) {
    (effects[e.effectType] ??= {})[e.name] = {
      name: e.name,
      product: null,
      rarity: e.rarity,
      artist: "Atomic Borders",
      effectType: e.effectType,
      attributes: e.attributes,
    };
  }

  return { colorPalettes, patterns, flags: {}, effects };
}

export const CATALOG = buildCatalog();

/** What a flare unlocks, for the progression reward track. */
export function flareCosmetic(flare: string): { type: string; name: string } {
  const [type, name] = flare.split(":");
  return { type, name };
}
