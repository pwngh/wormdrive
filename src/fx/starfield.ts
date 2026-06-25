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

// Hand-rolled warp starfield — the ambient layer behind everything.
// Stars drift slowly outward from the aperture; warpBurst() kicks the field
// into a brief light-speed surge (drag-enter, link copy, transfer start).
// Zero dependencies: one 2D canvas, a few hundred points, ~60 lines of math.
// Honors prefers-reduced-motion (static field, no animation loop) and pauses
// while the tab is hidden.

// Polar, not Cartesian: stars are placed by angle + radius around the aperture
// so the warp math is a single outward push on 'r', and recycling a star is just
// a reset to a small radius. Storing x/y would force a re-derive every frame.
interface Star {
  a: number; // angle around the aperture
  r: number; // radius, 0 (center) .. 1 (edge)
  z: number; // depth, drives size/brightness/speed
}

// Module-level handle to the live burst trigger, set by initStarfield once the
// animation loop exists. Null until then (and stays null under reduced motion),
// which is why warpBurst() guards with '?.' rather than assuming a target.
let burstFn: (() => void) | null = null;

/**
 * Surge the field briefly. Safe to call before init or under reduced motion.
 *
 * Decoupled from initStarfield via the module-level 'burstFn' so callers (drag-enter,
 * link copy, transfer start) can fire a burst without holding a reference to the
 * canvas or its loop — they just import this one function. The no-op-when-unset
 * behavior means UI events never have to know whether the field is running.
 */
export function warpBurst(): void {
  burstFn?.();
}

/**
 * Build the ambient warp field, prepend its canvas behind the page, and start
 * (or, under reduced motion, render a single static frame of) the drift loop.
 *
 * Everything lives inside this closure on purpose: the stars, sizing, and loop
 * state are private to one field instance, and the only outside seam is 'burstFn'.
 * The loop is driven by requestAnimationFrame and gated on tab visibility so a
 * hidden tab burns no frames.
 */
export function initStarfield(): void {
  const canvas = document.createElement("canvas");
  canvas.className = "space";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const IDLE = 0.26;

  let stars: Star[] = [];
  let w = 0;
  let h = 0;
  let cx = 0;
  let cy = 0;
  let maxR = 0;

  // Recompute backing-store size, center, and the star pool on every viewport
  // change. Reseeds the whole field rather than rescaling the old one — a resize
  // is rare and a fresh spread looks better than stretched-out survivors.
  function resize(): void {
    // Cap DPR at 2: beyond that the extra pixels are invisible on an ambient
    // backdrop but quadruple the fill cost on hi-DPI displays.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = w / 2;
    cy = h * 0.42; // the aperture sits above center
    // Distance to the farthest corner, so stars at r=1 always reach past the
    // viewport edge and the field never shows an empty rim.
    maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    // Density-based count, capped at 380 so a huge monitor doesn't tank the loop.
    const count = Math.min(380, Math.round((w * h) / 6200));
    stars = Array.from({ length: count }, () => ({
      a: Math.random() * Math.PI * 2,
      // pow(r, 0.7) biases the initial spread outward so the center isn't dense.
      r: Math.pow(Math.random(), 0.7),
      z: Math.random(),
    }));
  }

  // Advance every star outward for one frame. Speed scales with current radius
  // (so motion accelerates toward the edge, the warp look) and with depth 'z',
  // all multiplied by 'warp' and the frame delta. A star past the edge wraps to
  // a fresh near-center position with a new angle and depth, so the pool is
  // fixed-size and never needs reallocation.
  function tick(dt: number, warp: number): void {
    for (const s of stars) {
      s.r += (0.02 + s.r * 0.32) * (0.3 + s.z) * warp * dt;
      if (s.r > 1) {
        s.r = 0.02 + Math.random() * 0.05;
        s.a = Math.random() * Math.PI * 2;
        s.z = Math.random();
      }
    }
  }

  // Project each star from polar (a, r) back to canvas pixels and paint it as a
  // tiny rect — cheaper than arc()/fill() per star at a few hundred points, and
  // sub-pixel squares read as points at this scale. Size and alpha both grow with
  // depth and radius so far stars are small and faint, edge stars bright.
  function draw(): void {
    ctx!.clearRect(0, 0, w, h);
    for (const s of stars) {
      const px = cx + Math.cos(s.a) * s.r * maxR;
      const py = cy + Math.sin(s.a) * s.r * maxR;
      const size = (0.4 + s.z * 1.2) * (0.6 + s.r * 0.8);
      // Fade in over the first sixth of the radius so newly recycled stars
      // appear near the aperture without a hard pop.
      const alpha = (0.18 + s.z * 0.5) * Math.min(1, s.r * 6);
      // A rare amber star keeps the field on-brand without tinting it.
      ctx!.fillStyle =
        s.z > 0.93 ? `rgba(245, 165, 36, ${alpha * 0.9})` : `rgba(232, 228, 216, ${alpha})`;
      ctx!.fillRect(px - size / 2, py - size / 2, size, size);
    }
  }

  resize();
  window.addEventListener("resize", () => {
    resize();
    if (reduced) {
      tick(3, 1);
      draw();
    }
  });

  if (reduced) {
    // One settled, static frame; bursts stay no-ops.
    tick(3, 1);
    draw();
    return;
  }

  let warp = IDLE;
  let last = performance.now();
  let raf = 0;

  // Slam warp to its peak; frame() decays it back toward IDLE on its own, so a
  // burst is a single assignment with no timer to track or cancel.
  burstFn = () => {
    warp = 1.8;
  };

  function frame(now: number): void {
    // Clamp the delta at 50ms so a backgrounded-then-resumed tab (or a long GC
    // pause) doesn't teleport every star across the field in one step.
    const dt = Math.min(50, now - last) / 1000;
    last = now;
    warp += (IDLE - warp) * Math.min(1, dt * 2.2); // ease back to idle drift
    tick(dt, warp);
    draw();
    raf = requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
    } else {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });

  raf = requestAnimationFrame(frame);
}
