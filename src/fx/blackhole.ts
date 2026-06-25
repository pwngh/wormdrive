/**
 * @pwngh/wormdrive
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// Gargantua — the lensed black hole that IS the landing's centerpiece.
// A single full-viewport WebGL2 fragment pass raymarches each pixel's photon
// along its bent path: light curves toward the hole, wraps the accretion disk
// up and over the event horizon, and a thin photon ring rims the shadow. The
// approaching side of the disk beams brighter and bluer (relativistic Doppler);
// the inner edge dims and reddens (gravitational redshift). Tuned amber to match
// the brand. The hole is centered on the drop target, so its dark shadow sits
// under the CTA.
//
// It rides one layer above the hand-rolled starfield (fx/starfield): the sky is
// transparent so the field drifts through, while the shadow is painted opaque so
// no stars bleed into the void.
//
// Deliberate cheats (background fidelity, not a physics demo): the geodesic is
// rantonels' Newtonian-force trick (a = -1.5 h² r̂ / r⁵, tuned to 1.25 in code) integrated with plain
// Euler steps, not a Schwarzschild metric solve — looks identical at this scale.
//
// Zero dependencies. Honors prefers-reduced-motion (one static frame), pauses
// while the tab is hidden, caps resolution on 4K, auto-drops quality if frames
// run long. With no WebGL2 the starfield alone remains as the backdrop.

import { warpBurst as starfieldBurst } from "./starfield";

let burstFn: (() => void) | null = null;

/** Surge the disk + the ambient field together. Safe before init. */
export function warpBurst(): void {
  burstFn?.();      // spin up the accretion disk (no-op if WebGL2 is absent)
  starfieldBurst(); // and kick the starfield drifting behind it
}

// ── shader ──────────────────────────────────────────────────────────────────
// STEPS / STEP are injected per quality tier (the quality knob).

const VERT = `#version 300 es
// Full-screen triangle, no attributes — three verts cover the viewport.
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG_BODY = `precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
uniform vec2  uCenter; // where the hole's shadow centers, in backing pixels
uniform float uTime;
uniform float uWarp;   // 0 idle .. ~1 burst
uniform float uFov;    // field-of-view multiplier — smaller = bigger apparent hole

// Geometry (units of the gravitational radius; horizon = 1).
const float HORIZON  = 1.0;   // event horizon — captured rays end here
const float PHOTON   = 1.5;   // photon sphere — the ring lives just outside it
const float DISK_IN  = 2.45;  // inner disk edge (near-extremal Kerr reaches in) — hugs the rim
const float DISK_OUT = 12.0;  // outer disk edge — wide span, just inside the camera

// ── value noise + fbm, for the disk's turbulent gas ──
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 34.56);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1, 0));
  float c = hash(i + vec2(0, 1)), d = hash(i + vec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, amp = 0.5;
  for (int i = 0; i < 5; i++) { v += amp * noise(p); p *= 2.04; amp *= 0.5; }
  return v;
}

// Interstellar palette: deep red embers -> amber-gold -> cream white-hot, with a
// whisper of blue only at the very hottest inner edge. Warm and slightly muted.
vec3 diskColor(float h) {
  vec3 c = mix(vec3(0.34, 0.05, 0.01), vec3(0.95, 0.42, 0.13), smoothstep(0.0, 0.42, h)); // ember -> orange
  c = mix(c, vec3(1.0, 0.74, 0.42), smoothstep(0.42, 0.70, h));  // amber-gold
  c = mix(c, vec3(1.0, 0.93, 0.80), smoothstep(0.70, 0.93, h));  // cream white-hot
  c = mix(c, vec3(0.86, 0.93, 1.0), smoothstep(0.98, 1.18, h));  // faint blue, hottest edge only
  return c;
}

// Sparse procedural stars sampled in a direction. We feed it the photon's BENT
// escape direction, so stars near the rim smear into arcs — real gravitational
// lensing of the background sky, the signature Interstellar effect.
vec3 stars(vec3 d) {
  vec2 sv = vec2(atan(d.z, d.x), asin(clamp(d.y, -1.0, 1.0))) * 16.0;
  vec2 cell = floor(sv);
  float hh = hash(cell + 3.1); float hh2 = hh * hh; float hh4 = hh2 * hh2;
  float b = step(0.93, hash(cell)) * (hh4 * hh4 * hh); // hh^9 exactly, no pow
  vec2 f = fract(sv) - 0.5;
  float g = exp(-dot(f, f) * 32.0);
  vec3 tint = hash(cell + 7.0) > 0.85 ? vec3(1.0, 0.85, 0.6) : vec3(0.86, 0.9, 1.0);
  return tint * b * g;
}

void main() {
  // y-normalized screen coords, centered on the drop target.
  vec2 uv = (gl_FragCoord.xy - uCenter) / uRes.y;

  // Camera: near edge-on (~10° above the disk) — the angle that throws the disk
  // up and over the shadow. It continuously ORBITS the hole, so the disk sweeps
  // around and the Doppler-bright ansa rotates past the rim — alive, like the film.
  float az = uTime * 0.07; // ~90 s/rev — majestic but clearly rotating; uTime = pause-aware clock
  vec3 ro = vec3(sin(az) * 13.0, 0.62, -cos(az) * 13.0); // near edge-on -> symmetric top/bottom halo
  vec3 fwd = normalize(-ro);
  vec3 rgt = normalize(cross(vec3(0, 1, 0), fwd));
  vec3 up  = cross(fwd, rgt);
  vec3 rd  = normalize(fwd + (uv.x * rgt + uv.y * up) * uFov);

  vec3 pos = ro, vel = rd;
  float h2 = dot(cross(pos, vel), cross(pos, vel)); // angular momentum², conserved
  vec3 col = vec3(0.0);
  float transp = 1.0;   // remaining transparency (front-to-back over the disk)
  float rmin = 1e9;     // closest approach — drives the photon ring
  bool captured = false;

  for (int i = 0; i < STEPS; i++) {
    float r2 = dot(pos, pos);
    if (r2 < HORIZON * HORIZON) { captured = true; break; } // horizon needs only r2 — test before the sqrt
    float r = sqrt(r2);
    rmin = min(rmin, r);
    if (r2 > 484.0 && dot(pos, vel) > 0.0) break; // escaped & receding — stop (484 = 22^2; buys resolution)

    // Adaptive step: fine near the hole where light curves hard, long strides in
    // empty space. STEP folded into the clamp bounds (k*clamp(x,a,b)=clamp(kx,ka,kb)).
    float h = clamp(r * (0.4 * STEP), STEP, 7.0 * STEP);

    // Bend the ray: central force that reproduces GR light deflection. The
    // coefficient sets how hard light curves — lower pulls the lensed top/bottom
    // arcs in toward the band so they wisp and morph together.
    float r5 = r2 * r2 * r;                         // r^5 exactly (r already computed) — drops a per-step pow
    vel += (-1.25 * h2 * h / r5) * pos;
    vec3 npos = pos + vel * h;

    // Disk crossing: the equatorial plane (y = 0) was straddled this step.
    if (pos.y * npos.y < 0.0 && transp > 0.01) {
      vec3 cp = mix(pos, npos, pos.y / (pos.y - npos.y));
      float rr = length(cp.xz);
      if (rr > DISK_IN && rr < DISK_OUT) {
        float x = DISK_IN / rr;                          // 1 at the inner edge .. ->0 outward
        float t = (rr - DISK_IN) / (DISK_OUT - DISK_IN);
        // Emission ~ r^-2.2 (softened from the ideal T ∝ r^-3/4 / emission ∝ r^-3): blazing inner, dimming outward — steep so
        // the band tapers instead of flaring into wide white wings.
        float radial = pow(x, 2.2) * smoothstep(1.0, 0.5, t); // less steep -> fuller bands

        // Edge-on path length: a ray grazing the plane at a shallow angle looks
        // through a long column of gas, so it blazes — widened so the band has
        // body and the lensed arcs read full, not thin and wiry.
        float edge = 1.0 + 1.0 * smoothstep(0.55, 0.0, abs(normalize(vel).y));

        // Clumpy fine filaments sheared by differential rotation (two octaves).
        float omega = x * sqrt(x) * (0.5 + uWarp * 1.6); // x^1.5 exactly, no pow
        float a = uTime * omega;
        mat2 R = mat2(cos(a), -sin(a), sin(a), cos(a));
        vec2 q = R * cp.xz;
        // Rich organic gas: domain-warped flow turbulence (swirls/eddies) at three
        // scales — broad streaks, medium clumps, fine grit — sheared by the
        // differential rotation. The warp is what turns straight noise into flowing gas.
        vec2 warp = vec2(fbm(q * 1.4 + 3.0), fbm(q * 1.4 + 8.0)) - 0.5;
        vec2 qw = q + warp * 0.6;
        float f1 = fbm(qw * vec2(0.7, 1.9) + 4.0);              // less anisotropic -> fuller, not wiry
        float f2 = fbm(qw * vec2(1.6, 4.2) + 11.0);
        float f3 = fbm(qw * vec2(3.0, 7.5) + 21.0);             // fine detail, gentler streak
        float tex = (0.55 + 0.6 * f1) * (0.7 + 0.45 * f2);     // higher floor -> solid body, not gaps
        // Mass-accumulation knots: where the fine and medium gas both peak, dense
        // bright clumps glow — matter piling up along the band and the lensed rings.
        float knots = smoothstep(0.56, 0.82, f3 * (0.5 + 0.95 * f2));
        knots += 0.5 * smoothstep(0.62, 0.86, f2 * (0.4 + f1)); // a second, larger clump scale
        tex *= (0.86 + 0.28 * f3) * (1.0 + 1.5 * knots);

        // Relativistic Doppler beaming + shift — toned (as in the film).
        vec3 vdir = normalize(cross(vec3(0, 1, 0), cp));
        float beta = clamp(0.46 * sqrt(x), 0.0, 0.8);
        float gamma = inversesqrt(1.0 - beta * beta);
        float D = 1.0 / (gamma * (1.0 + beta * dot(vdir, normalize(vel))));
        float beam = pow(D, 1.7); // toned so HDR bloom doesn't blow the approaching side
        float grav = sqrt(max(0.0, 1.0 - HORIZON / rr)); // gravitational redshift

        float bright = radial * tex * beam * grav * edge * 2.1; // fuller bands cover more area -> trim gain

        float heat = clamp((0.5 + 0.5 * x) * mix(1.0, D, 0.5), 0.0, 1.1); // hottest at the inner edge
        vec3 emit = diskColor(heat) * bright;

        col += emit * transp;                            // front-to-back: nearer image wins
        transp *= clamp(1.0 - radial * tex * 0.4, 0.0, 1.0); // semi-transparent -> the halo layers
      }
    }
    pos = npos;
  }

  // Photon ring: light that grazed the photon sphere piles into a razor-thin,
  // blazing loop rimming the event horizon — the signature of the shadow. A
  // razor core plus a soft surrounding glow gives it the cinematic bloom.
  if (rmin > HORIZON) {
    // Piled-up lensed gas at the shadow edge, not a drawn line: a thicker band
    // broken by strong orbiting clumps + dim gaps, plus a radial wobble (all
    // seam-free via cos/sin of the screen angle) so it isn't a perfect circle.
    float ar = atan(uv.y, uv.x) - uTime * 0.35;
    float n1 = fbm(vec2(cos(ar), sin(ar)) * 8.0 + 2.0);
    float n2 = fbm(vec2(cos(ar * 2.1), sin(ar * 2.1)) * 19.0 + 7.0);
    float d = abs(rmin - PHOTON - (n1 - 0.5) * 0.04);     // wobbled radius (gentler wobble)
    float band = smoothstep(0.17, 0.0, d);                // thick rim band, not a wire
    float core = smoothstep(0.055, 0.0, d);               // hot inner core of the rim
    // Fuller floor + gentler breaks: a continuous bright rim with clumping ON it,
    // rather than a thin loop chopped into wisps.
    float clump = clamp(0.7 + 0.85 * n1 * n2 + 0.3 * n1, 0.0, 2.0);
    vec3 tint = vec3(1.0, 0.93, 0.78);
    // Front-to-back component: correctly occluded by foreground lensed gas.
    col += (band * 0.8 + core * 0.95) * clump * 1.25 * tint * transp;
    // Always-on rim: a clean bright loop hugging the shadow that is NOT gated by
    // transp, so the event horizon stays fully encircled even where the lensed disk
    // passes in front of the top — this kills the dark notches bitten out of the rim.
    col += core * 0.95 * tint;
  }

  // Lensed stars (toned + sparser so they read as distant sky, not bright specks).
  // Gate on rmin < 7.0: smoothstep(7.0,1.7,rmin) is exactly 0 beyond 7 (most off-hole
  // pixels), so skipping stars() there drops its atan/asin/exp with no pixel change.
  if (!captured && rmin < 7.0) col += stars(normalize(vel)) * smoothstep(7.0, 1.7, rmin) * 1.7 * transp;

  // The shadow is a clean, near-black dark grey-blue — no rings, no tunnel.
  if (captured) col += vec3(0.016, 0.02, 0.03);

  // Output LINEAR HDR (exposure baked in) — the composite blooms then tonemaps.
  col *= 1.12;

  // Deep-space backing around the hole: the gap between the shadow and the disk
  // must read as black space, NOT the page's purple nebula bleeding up through the
  // transparent canvas. So near the hole the pixel is opaque (covering the nebula),
  // fading to transparent far out where the nebula can still tint the corners.
  float nearHole = smoothstep(10.0, 2.55, rmin);
  float lum = max(max(col.r, col.g), col.b);
  float alpha = captured ? 1.0 : max(clamp(lum * 1.5, 0.0, 1.0), nearHole);
  fragColor = vec4(col, alpha);
}`;

// Composite pass = bloom. The raymarch renders into a mipmapped texture; sampling
// progressively blurred mip levels (bright-passed) is a cheap, smooth multi-scale
// glow — the soft cinematic aura around the disk and ring. The glow also lifts
// alpha so it washes over the starfield/void around the hole.
const COMPOSITE_FRAG = `precision highp float;
out vec4 fragColor;
uniform sampler2D uScene;
uniform vec2 uRes;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 scene = texture(uScene, uv);                          // linear HDR
  // HDR bloom: bright light (value above threshold) bleeds from blurred mip
  // levels — three tight scales for the core glow plus one very wide lobe for the
  // broad cinematic aura. Done in HDR so the hottest cores bleed with magnitude.
  vec3 b = max(textureLod(uScene, uv, 2.5).rgb - 1.0, 0.0) * 0.35;
  b += max(textureLod(uScene, uv, 4.5).rgb - 0.7, 0.0) * 0.45;
  b += max(textureLod(uScene, uv, 6.5).rgb - 0.5, 0.0) * 0.55;
  vec3 col = aces(scene.rgb + b * 0.6);                       // bloom, THEN tonemap
  float a = max(scene.a, dot(aces(b * 0.6), vec3(0.3)));      // glow lifts alpha over the field
  fragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;

// ── quality tiers ─────────────────────────────────────────────────────────
interface Tier {
  steps: number; // raymarch iterations
  step: number;  // march length (fewer steps -> longer step, same reach)
  scale: number; // internal render scale vs CSS pixels
  dprCap: number;
  maxPx: number; // backing-store ceiling (the 4K guard)
}
// Capable hardware renders at FULL devicePixelRatio (retina-crisp, even
// supersampled) at HIGH — the reference image. pickTier() starts weaker GPUs
// lower, and a runtime panic guard can step HIGH -> MID -> SOFT. Demotion now
// drops BACKING RESOLUTION too (smaller dprCap/maxPx/scale), so it relieves
// fill-rate + per-frame mipmap cost, not just step count — what actually keeps a
// weak GPU from hanging. HIGH's numbers are the reference; never change them.
const HIGH: Tier = { steps: 165, step: 0.09, scale: 1.0, dprCap: 2.0, maxPx: 6_000_000 };
// MID: integrated/mobile GPUs and very large panels. dprCap 1.5 + 3MP ceiling
// roughly halves fill vs HIGH while staying retina-crisp.
const MID: Tier = { steps: 130, step: 0.11, scale: 1.0, dprCap: 1.5, maxPx: 3_000_000 };
// SOFT: software rasterizers and the runtime panic floor. dpr 1, 60% scale,
// ~1.3MP — "renders without hanging the tab", not crispness.
const SOFT: Tier = { steps: 90, step: 0.15, scale: 0.6, dprCap: 1.0, maxPx: 1_300_000 };

function fragSource(t: Tier): string {
  return `#version 300 es\n#define STEPS ${t.steps}\n#define STEP ${t.step.toFixed(3)}\n${FRAG_BODY}`;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function buildProgram(gl: WebGL2RenderingContext, tier: Tier): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSource(tier));
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
}

// The composite (bloom) program. Separate so a context-loss restore can rebuild
// it; a null result just means "draw straight to the canvas, no bloom".
function buildComposite(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es\n${COMPOSITE_FRAG}`);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
}

/**
 * Stand up the lensed-black-hole backdrop and wire it into the page.
 *
 * Idempotently degrades rather than throwing: if WebGL2 is missing or a software
 * context is refused (failIfMajorPerformanceCaveat), this returns having done
 * nothing and the starfield from main.ts remains the backdrop — so callers can fire
 * it unconditionally on load. Everything it owns (canvas, GL objects, rAF loop,
 * resize/visibility/context-loss listeners) is captured in this closure; there is no
 * teardown handle by design, because the only exits are context loss (handled
 * internally by teardown(), which drops back to the starfield) and page unload.
 *
 * Side effect: sets the module-level burstFn so warpBurst() can surge the disk; that
 * binding is the only state that escapes the closure.
 */
export function initBlackhole(): void {
  const canvas = document.createElement("canvas");
  canvas.className = "space space-bh"; // sits one layer above the starfield
  canvas.setAttribute("aria-hidden", "true");

  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    powerPreference: "low-power",        // it's wallpaper, not a game
    failIfMajorPerformanceCaveat: true,  // refuse a software context — it can't raymarch 6MP; show the starfield instead
  });
  // No WebGL2 (or a software-only context refused above): the starfield from
  // main.ts stays as the backdrop and warpBurst routes to it — graceful
  // degradation, nothing else to do.
  if (!gl) return;
  const glc = gl; // non-null alias for the loss/restore handlers and helpers
  // HDR bloom needs a float render target; near-universal on WebGL2 desktop. If
  // absent we fall back to an RGBA8 scene buffer (bloom still works, just LDR).
  const hdrOk = !!gl.getExtension("EXT_color_buffer_float");
  document.body.prepend(canvas);

  // ── rebuildable GL state (a context-loss restore reruns rebuildGL) ───────────
  let tier: Tier = HIGH;                  // overwritten by pickTier() before the first build
  let prog: WebGLProgram | null = null;
  let compProg: WebGLProgram | null = null;
  let fbo: WebGLFramebuffer | null = null;
  let sceneTex: WebGLTexture | null = null;
  let uRes: WebGLUniformLocation | null = null;
  let uCenter: WebGLUniformLocation | null = null;
  let uTime: WebGLUniformLocation | null = null;
  let uWarp: WebGLUniformLocation | null = null;
  let uFov: WebGLUniformLocation | null = null;
  let uScene: WebGLUniformLocation | null = null;
  let uCompRes: WebGLUniformLocation | null = null;
  let lost = false;                       // true between contextlost and a successful restore
  let raf = 0;                            // current rAF id (handlers cancel it)
  let last = 0;                           // last frame timestamp (set when the loop starts)
  let warp = 0;                           // burst surge, eased back to 0 each frame
  let clock = 0;                          // pause-aware seconds: advances only while visible
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function bindUniforms(): void {
    glc.useProgram(prog);
    uRes = glc.getUniformLocation(prog!, "uRes");
    uCenter = glc.getUniformLocation(prog!, "uCenter");
    uTime = glc.getUniformLocation(prog!, "uTime");
    uWarp = glc.getUniformLocation(prog!, "uWarp");
    uFov = glc.getUniformLocation(prog!, "uFov");
  }

  // Pick the initial tier from cheap synchronous signals so a weak GPU never
  // allocates a 6MP float target / 165-step march on frame 1 (the frame-1 TDR
  // cause). Capable/unknown hardware falls through to HIGH unchanged.
  function pickTier(): Tier {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    let r = "";
    try {
      const dbg = glc.getExtension("WEBGL_debug_renderer_info");
      if (dbg) r = String(glc.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "").toLowerCase();
    } catch { /* privacy-blocked renderer string -> unknown -> HIGH */ }
    const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
    const cores = navigator.hardwareConcurrency || 8;
    const cssPx = window.innerWidth * window.innerHeight *
      Math.min(window.devicePixelRatio || 1, 2);
    if (/swiftshader|llvmpipe|software|microsoft basic|paravirtual/.test(r)) return SOFT;
    const weakGpu = /intel.*(hd|uhd)|mali|adreno|powervr|videocore|apple a\d/.test(r);
    if (coarse || weakGpu || mem <= 4 || cores <= 4 || cssPx > 8_300_000) return MID;
    return HIGH;
  }

  // ── bloom pipeline ────────────────────────────────────────────────────────
  // Raymarch -> offscreen mipmapped texture -> composite (bright-pass mip blur).
  // Every draw is a full-screen overwrite, so no blending: the canvas ends up
  // with straight (colour, alpha) and the browser composites it over the
  // starfield. If the composite can't be built (or the float target fails) we
  // draw straight to the canvas (no bloom) — never a blank screen.
  function allocSceneTex(): void {
    if (!compProg) return;
    if (sceneTex) glc.deleteTexture(sceneTex);
    sceneTex = glc.createTexture();
    glc.bindTexture(glc.TEXTURE_2D, sceneTex);
    // Float (RGBA16F) so the raymarch's HDR light survives into the bloom; RGBA8
    // otherwise (clips at 1.0 — bloom still runs, just without HDR magnitude).
    let floatOk = hdrOk;
    if (floatOk) {
      glc.getError(); // drain so the next check reflects only this allocation
      glc.texImage2D(glc.TEXTURE_2D, 0, glc.RGBA16F, canvas.width, canvas.height, 0,
        glc.RGBA, glc.HALF_FLOAT, null);
      if (glc.getError() === glc.OUT_OF_MEMORY) floatOk = false; // runtime OOM -> LDR fallback
    }
    if (!floatOk) {
      glc.texImage2D(glc.TEXTURE_2D, 0, glc.RGBA8, canvas.width, canvas.height, 0,
        glc.RGBA, glc.UNSIGNED_BYTE, null);
    }
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_MIN_FILTER, glc.LINEAR_MIPMAP_LINEAR);
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_MAG_FILTER, glc.LINEAR);
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_WRAP_S, glc.CLAMP_TO_EDGE);
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_WRAP_T, glc.CLAMP_TO_EDGE);
    glc.bindFramebuffer(glc.FRAMEBUFFER, fbo);
    glc.framebufferTexture2D(glc.FRAMEBUFFER, glc.COLOR_ATTACHMENT0, glc.TEXTURE_2D, sceneTex, 0);
    // If the FBO isn't complete (OOM / non-renderable target), drop bloom rather
    // than sampling a black/garbage attachment — render()'s useBloom turns false.
    const ok = glc.checkFramebufferStatus(glc.FRAMEBUFFER) === glc.FRAMEBUFFER_COMPLETE
      && glc.getError() === glc.NO_ERROR;
    glc.bindFramebuffer(glc.FRAMEBUFFER, null);
    if (!ok) {
      glc.deleteTexture(sceneTex);
      sceneTex = null;
    }
  }

  // (Re)build every GL object — also the context-loss restore path. Returns false
  // if the core raymarch program can't link (caller tears down to the starfield).
  function rebuildGL(): boolean {
    prog = buildProgram(glc, tier);
    if (!prog) return false;
    bindUniforms();
    compProg = buildComposite(glc);
    fbo = compProg ? glc.createFramebuffer() : null;
    if (compProg) {
      glc.useProgram(compProg);
      uScene = glc.getUniformLocation(compProg, "uScene");
      uCompRes = glc.getUniformLocation(compProg, "uRes");
    }
    allocSceneTex();
    return true;
  }

  // A GPU context loss (driver TDR on a heavy frame) would otherwise freeze an
  // opaque black canvas over the page. teardown() removes it so the working
  // starfield (z-index -2) shows through; warpBurst then only kicks the field.
  function teardown(): void {
    lost = true;
    cancelAnimationFrame(raf);
    burstFn = null;
    canvas.remove();
  }
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();                   // REQUIRED so the context can be restored
    lost = true;
    cancelAnimationFrame(raf);
  }, false);
  canvas.addEventListener("webglcontextrestored", () => {
    try {
      if (!rebuildGL()) { teardown(); return; }
      lost = false;
      resize();
      if (!reduced) { last = performance.now(); raf = requestAnimationFrame(frame); }
      else render(8.0, 0);
    } catch { teardown(); }
  }, false);

  tier = pickTier();
  if (!rebuildGL()) { canvas.remove(); return; }

  // FOV frames the whole hole — shadow + ring + lensed disk — with black sky in
  // the corners. The drop target sits over the shadow.
  const FOV = 0.92;

  // Center the hole's shadow on the drop target (falls back to viewport center).
  function holeCenter(): [number, number] {
    const doc = document.documentElement;
    const cssW = Math.max(canvas.clientWidth, window.innerWidth, doc.clientWidth);
    const cssH = Math.max(canvas.clientHeight, window.innerHeight, doc.clientHeight);
    const sx = canvas.width / cssW;
    const sy = canvas.height / cssH;
    // Once files are staged the drop zone docks into a narrow side rail; chasing
    // it there throws the disk off-screen and aliases it into mush. In that mode
    // the hole just centers in the viewport as a calm backdrop behind the panels.
    const target = document.querySelector<HTMLElement>(".dropzone");
    const staged = !!document.querySelector(".wb-right > .panel:not([hidden])");
    if (staged || !target || target.offsetParent === null) {
      return [canvas.width / 2, canvas.height / 2];
    }
    const r = target.getBoundingClientRect();
    // Drop the shadow slightly below the target's middle so the CTA inside the
    // drop zone lands on the dark shadow, not the bright disk edge just beneath.
    const cyCss = r.top + r.height / 2 + r.height * 0.15;
    return [
      (r.left + r.width / 2) * sx,
      canvas.height - cyCss * sy, // flip to GL origin (bottom-left)
    ];
  }

  function render(time: number, warp: number): void {
    if (lost) return; // context gone — don't touch GL until restore or teardown
    const [cx, cy] = holeCenter();
    const useBloom = !!(compProg && sceneTex);
    // Pass 1: raymarch the hole into the offscreen texture (or straight to canvas).
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, useBloom ? fbo : null);
    gl!.useProgram(prog);
    gl!.uniform2f(uRes, canvas.width, canvas.height);
    gl!.uniform2f(uCenter, cx, cy);
    gl!.uniform1f(uTime, time);
    gl!.uniform1f(uWarp, warp);
    gl!.uniform1f(uFov, FOV);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    // Pass 2: mip the scene and composite the bloom onto the canvas.
    if (useBloom) {
      gl!.bindTexture(gl!.TEXTURE_2D, sceneTex);
      gl!.generateMipmap(gl!.TEXTURE_2D);
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
      gl!.useProgram(compProg);
      gl!.activeTexture(gl!.TEXTURE0);
      gl!.bindTexture(gl!.TEXTURE_2D, sceneTex);
      gl!.uniform1i(uScene, 0);
      gl!.uniform2f(uCompRes, canvas.width, canvas.height);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    }
  }

  function resize(): void {
    if (lost) return; // context gone — skip resize until restore
    // Viewport size. The canvas is fixed inset:0 so any of these report it;
    // take the max to ride out a 0 mid-load and flaky clientWidth readings.
    const doc = document.documentElement;
    const cw = Math.max(canvas.clientWidth, window.innerWidth, doc.clientWidth);
    const ch = Math.max(canvas.clientHeight, window.innerHeight, doc.clientHeight);
    if (cw === 0 || ch === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, tier.dprCap);
    let bw = Math.round(cw * dpr * tier.scale);
    let bh = Math.round(ch * dpr * tier.scale);
    const px = bw * bh;
    if (px > tier.maxPx) {
      const k = Math.sqrt(tier.maxPx / px); // 4K guard: shrink to fit the ceiling
      bw = Math.round(bw * k);
      bh = Math.round(bh * k);
    }
    if (bw === canvas.width && bh === canvas.height) return;
    canvas.width = bw;
    canvas.height = bh;
    gl!.viewport(0, 0, bw, bh);
    allocSceneTex(); // realloc the RGBA16F scene+mip target at the new size: on
                     // demotion this is what drops fill-rate, texture bandwidth,
                     // and per-frame generateMipmap cost (not just step count).
    // Re-render synchronously: setting canvas.width/height above cleared the
    // drawing buffer, so without this the canvas is blank until the next rAF — a
    // visible flash while the viewport is being dragged. (Reduced motion has no
    // rAF loop, so this is also its only repaint.)
    render(reduced ? 8.0 : clock, reduced ? 0 : warp);
  }
  // The observer self-fires once the canvas is laid out (closing the load race)
  // and on every viewport change thereafter. The hole re-centers each frame, so
  // layout shifts (staging files) are tracked for free.
  new ResizeObserver(resize).observe(canvas);
  resize();

  if (reduced) return; // one settled frame (drawn by resize); bursts stay no-ops

  last = performance.now(); // raf/last/warp/clock declared up top for the loss handlers + resize
  let ema = 16; // rolling frame time (ms)
  let frames = 0;

  burstFn = () => {
    warp = 1;
  };

  function frame(now: number): void {
    if (lost) return;
    const prevLast = last;                       // raw cost: the 50ms clamp below hides TDR-class frames
    const dt = Math.min(50, now - last) / 1000;
    ema += (now - last - ema) * 0.1;
    last = now;
    clock += dt; // accumulate only elapsed visible time -> no jump after a hidden pause
    warp += (0 - warp) * Math.min(1, dt * 1.6); // ease back to idle

    // Adaptive demotion. demoteTo() rebuilds the program AND (via resize, since
    // MID/SOFT carry smaller dprCap/maxPx/scale) lowers the backing resolution —
    // so it relieves fill-rate, not just step count. HIGH is never demoted into.
    const rawCost = now - prevLast;              // unclamped frame cost
    frames++;
    const demoteTo = (t: Tier): void => {
      const next = buildProgram(glc, t);
      if (!next) return;
      tier = t;                                  // set BEFORE resize() so it adopts the new dprCap/maxPx/scale
      glc.deleteProgram(prog);
      prog = next;
      bindUniforms();
      resize();
    };
    if (frames <= 2 && rawCost > 90 && tier !== SOFT) {
      demoteTo(tier === HIGH ? MID : SOFT);      // frame-1 panic guard (a ~90ms+ frame == TDR risk)
    } else if (frames === 60 && ema > 32 && tier !== SOFT) {
      demoteTo(tier === HIGH ? MID : SOFT);      // slow-burn "consistently over budget"
    }

    render(clock, warp);
    raf = requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", () => {
    if (lost) return; // context torn down — nothing to pause/resume
    if (document.hidden) {
      cancelAnimationFrame(raf);
    } else {
      cancelAnimationFrame(raf); // drop any in-flight loop so we never run two concurrently
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });

  raf = requestAnimationFrame(frame);
}
