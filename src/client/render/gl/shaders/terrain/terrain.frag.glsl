#version 300 es
precision highp float;

uniform sampler2D uTerrain;

in vec2 vUV;
out vec4 fragColor;

// Cheap integer-ish hash of a tile coordinate -> [0, 1).
float tileHash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

void main() {
  vec4 base = texture(uTerrain, vUV);
  // Per-tile brightness jitter: gives the map a dithered, pixel-grid texture
  // that stays fixed to each tile at every zoom level.
  vec2 tile = floor(vUV * vec2(textureSize(uTerrain, 0)));
  float n = tileHash(tile) - 0.5;
  fragColor = vec4(clamp(base.rgb * (1.0 + n * 0.09), 0.0, 1.0), base.a);
}
