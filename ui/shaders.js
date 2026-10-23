// GLSL for the animated backgrounds. One fragment shader draws every pattern (picked by u_mode),
// and every pattern goes through the same touch warps: water ripples, vortex swirl and melt drips.

window.SHADER_SOURCES = {
  vertex: `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`,

  fragment: `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform int u_mode;
uniform vec3 u_color1;
uniform vec3 u_color2;
uniform vec3 u_color3;
// Up to 8 live touches: x, y (0..1, y up), age in seconds (negative = unused), kind (1 water, 2 vortex, 3 melt).
uniform vec4 u_touches[8];

const float TAU = 6.2831853;

// Sine-free hash: the classic fract(sin(x) * 43758.5) amplifies tiny GPU rounding differences
// between neighbouring noise cells, which showed up as square seams across the background.
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float total = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 5; octave++) {
    total += amplitude * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    amplitude *= 0.5;
  }
  return total;
}

vec3 cosinePalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(TAU * (c * t + d)); }
vec3 rainbow(float t) { return cosinePalette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67)); }

// Returns the warped sample position; 'shine' collects highlights (ripple glints, vortex shadow).
vec2 applyTouchWarps(vec2 uv, float aspect, inout float shine) {
  for (int i = 0; i < 8; i++) {
    vec4 touch = u_touches[i];
    float age = touch.z;
    if (age < 0.0) continue;
    vec2 delta = (uv - touch.xy) * vec2(aspect, 1.0);
    float dist = length(delta) + 1e-5;
    vec2 direction = delta / dist;

    if (touch.w < 1.5) {
      // Water: a few rings travelling outward, fading with age and distance.
      float front = age * 0.32;
      float envelope = exp(-abs(dist - front) * 9.0) * exp(-age * 1.1);
      float wave = sin(dist * 70.0 - age * 14.0);
      uv += direction / vec2(aspect, 1.0) * wave * envelope * 0.018;
      shine += wave * envelope;
    } else if (touch.w < 2.5) {
      // Vortex: twist in and relax back out over ~3 seconds.
      float strength = sin(clamp(age / 3.0, 0.0, 1.0) * 3.14159);
      float falloff = exp(-dist * 3.5);
      float angle = strength * falloff * 9.0;
      float s = sin(angle);
      float c = cos(angle);
      vec2 twisted = vec2(c * delta.x - s * delta.y, s * delta.x + c * delta.y);
      twisted *= 1.0 + strength * falloff * 0.8;
      uv = touch.xy + twisted / vec2(aspect, 1.0);
      shine -= strength * exp(-dist * 9.0) * 1.5;
    } else {
      // Melt: uneven drips run down from the touch point, then the picture slowly re-forms.
      float grow = smoothstep(0.0, 2.0, age) * (1.0 - smoothstep(5.0, 8.0, age));
      float column = exp(-pow(delta.x * 3.5, 2.0));
      float dripLength = 0.25 + 0.75 * noise(vec2(uv.x * 28.0, 3.0)) * noise(vec2(uv.x * 7.0, 5.0));
      float below = smoothstep(0.05, -0.15, delta.y);
      float pull = grow * column * dripLength * below * 0.45;
      uv.y += pull;
      shine += pull * 2.0 * noise(vec2(uv.x * 40.0, uv.y * 4.0));
    }
  }
  return uv;
}

vec3 tieDye(vec2 p, float t) {
  float n = fbm(p * 2.5 + t * 0.08);
  float radius = length(p);
  float angle = atan(p.y, p.x);
  float swirl = angle / TAU + log(radius + 0.04) * 0.8 - t * 0.04 + n * 0.7;
  vec3 color = rainbow(swirl * 3.0 + n * 0.5);
  // Crinkled white streaks where the dye didn't soak in.
  float crinkle = smoothstep(0.62, 0.8, fbm(vec2(swirl * 9.0, radius * 6.0) + n * 3.0));
  color = mix(color, vec3(1.0, 0.97, 0.95), crinkle * 0.45);
  return color * (0.85 + 0.25 * n);
}

vec3 sunset(vec2 uv, float t) {
  float n = fbm(uv * vec2(2.0, 4.0) + vec2(t * 0.05, 0.0));
  float h = uv.y + n * 0.25;
  vec3 color = mix(vec3(1.0, 0.55, 0.15), vec3(0.95, 0.25, 0.45), smoothstep(0.1, 0.5, h));
  color = mix(color, vec3(0.35, 0.12, 0.45), smoothstep(0.45, 0.95, h));
  float sun = exp(-length((uv - vec2(0.5, 0.25)) * vec2(1.6, 1.0)) * 6.0);
  return color + vec3(1.0, 0.8, 0.4) * sun * 0.6;
}

vec3 ocean(vec2 uv, float t) {
  vec2 p = uv * 6.0;
  float caustic = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    p += vec2(sin(p.y * 0.9 + t * 0.6 + fi), cos(p.x * 0.8 - t * 0.5 + fi)) * 0.6;
    caustic += abs(sin(p.x + p.y));
  }
  caustic = pow(1.0 - caustic / 3.0, 3.0);
  vec3 deep = mix(vec3(0.0, 0.12, 0.3), vec3(0.0, 0.45, 0.6), uv.y);
  return deep + vec3(0.4, 0.9, 1.0) * caustic * 0.7;
}

vec3 aurora(vec2 uv, float t) {
  vec3 color = mix(vec3(0.01, 0.02, 0.08), vec3(0.03, 0.06, 0.18), uv.y);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float curtainY = 0.55 + fi * 0.1 + 0.12 * fbm(vec2(uv.x * 2.0 + t * 0.06 + fi * 3.0, t * 0.05));
    float band = exp(-abs(uv.y - curtainY) * (10.0 + fi * 4.0));
    float rays = 0.6 + 0.4 * noise(vec2(uv.x * 40.0 + t * 0.3, fi));
    vec3 tint = mix(vec3(0.1, 1.0, 0.55), vec3(0.6, 0.25, 1.0), fi / 2.0 + 0.3 * sin(t * 0.2));
    color += tint * band * rays * 0.7;
  }
  float stars = step(0.997, hash(floor(uv * u_resolution / 2.0))) * (0.5 + 0.5 * sin(t * 3.0 + uv.x * 50.0));
  return color + stars;
}

vec3 neonAcid(vec2 p, float t) {
  float v = sin(p.x * 8.0 + t) + sin(p.y * 7.0 - t * 1.3) + sin((p.x + p.y) * 6.0 + t * 0.7)
          + sin(length(p) * 12.0 - t * 2.0);
  vec3 color = cosinePalette(v * 0.25 + t * 0.05, vec3(0.5), vec3(0.6), vec3(1.0, 1.0, 1.0), vec3(0.3, 0.2, 0.2));
  return pow(color, vec3(0.8)) * 1.1;
}

vec3 lavaLamp(vec2 p, float t) {
  float field = 0.0;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    vec2 center = vec2(sin(t * 0.21 * (1.0 + fi * 0.13) + fi * 2.1) * 0.55,
                       sin(t * 0.17 * (1.0 + fi * 0.11) + fi * 1.3) * 0.45);
    float radius = 0.12 + 0.05 * sin(fi * 4.0);
    field += radius * radius / dot(p - center, p - center);
  }
  vec3 background = mix(vec3(0.25, 0.02, 0.25), vec3(0.45, 0.05, 0.2), p.y + 0.5);
  vec3 wax = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.85, 0.2), smoothstep(1.0, 3.0, field));
  return mix(background, wax, smoothstep(0.9, 1.1, field));
}

vec3 cosmic(vec2 uv, vec2 p, float t) {
  float n = fbm(p * 1.8 + vec2(t * 0.02, -t * 0.015));
  float n2 = fbm(p * 3.5 - n + t * 0.01);
  vec3 color = vec3(0.02, 0.0, 0.06);
  color += vec3(0.6, 0.1, 0.7) * pow(n, 2.5) * 1.8;
  color += vec3(0.1, 0.4, 0.9) * pow(n2, 3.0) * 1.6;
  vec2 cell = floor(uv * u_resolution / 3.0);
  float star = step(0.996, hash(cell));
  color += star * (0.6 + 0.4 * sin(t * 2.0 + hash(cell) * 40.0));
  return color;
}

vec3 vortexTunnel(vec2 p, float t) {
  float radius = length(p) + 1e-3;
  float angle = atan(p.y, p.x);
  float depth = 0.35 / radius + t * 0.6;
  float spin = angle / TAU + depth * 0.15 + t * 0.05;
  float stripes = 0.5 + 0.5 * sin(spin * TAU * 6.0 + depth * 4.0);
  vec3 color = rainbow(depth * 0.15 + spin) * (0.45 + 0.55 * stripes);
  return color * smoothstep(0.0, 0.35, radius) + vec3(1.0) * exp(-radius * 18.0) * 0.6;
}

vec3 customGradient(vec2 uv, float t) {
  float f = uv.y + 0.3 * (fbm(uv * 2.0 + t * 0.08) - 0.5) + 0.1 * sin(uv.x * 3.0 + t * 0.3);
  vec3 color = mix(u_color1, u_color2, smoothstep(0.0, 0.5, f));
  return mix(color, u_color3, smoothstep(0.5, 1.0, f));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float aspect = u_resolution.x / u_resolution.y;
  float shine = 0.0;
  uv = applyTouchWarps(uv, aspect, shine);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float t = u_time;

  vec3 color;
  if (u_mode == 0) color = tieDye(p, t);
  else if (u_mode == 1) color = sunset(uv, t);
  else if (u_mode == 2) color = ocean(uv, t);
  else if (u_mode == 3) color = aurora(uv, t);
  else if (u_mode == 4) color = neonAcid(p, t);
  else if (u_mode == 5) color = lavaLamp(p, t);
  else if (u_mode == 6) color = cosmic(uv, p, t);
  else if (u_mode == 7) color = vortexTunnel(p, t);
  else color = customGradient(uv, t);

  color += vec3(0.85, 0.95, 1.0) * clamp(shine, -0.6, 1.0) * 0.35;
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`,
};
