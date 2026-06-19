// Hand-rolled warp starfield — the ambient layer behind everything.
// Stars drift slowly outward from the aperture; warpBurst() kicks the field
// into a brief light-speed surge (drag-enter, link copy, transfer start).
// Zero dependencies: one 2D canvas, a few hundred points, ~60 lines of math.
// Honors prefers-reduced-motion (static field, no animation loop) and pauses
// while the tab is hidden.

interface Star {
  a: number; // angle around the aperture
  r: number; // radius, 0 (center) .. 1 (edge)
  z: number; // depth, drives size/brightness/speed
}

let burstFn: (() => void) | null = null;

/** Surge the field briefly. Safe to call before init or under reduced motion. */
export function warpBurst(): void {
  burstFn?.();
}

export function initStarfield(): void {
  const canvas = document.createElement("canvas");
  canvas.className = "space";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const IDLE = 0.16;

  let stars: Star[] = [];
  let w = 0;
  let h = 0;
  let cx = 0;
  let cy = 0;
  let maxR = 0;

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = w / 2;
    cy = h * 0.42; // the aperture sits above center
    maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    const count = Math.min(240, Math.round((w * h) / 9000));
    stars = Array.from({ length: count }, () => ({
      a: Math.random() * Math.PI * 2,
      r: Math.pow(Math.random(), 0.7),
      z: Math.random(),
    }));
  }

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

  function draw(): void {
    ctx!.clearRect(0, 0, w, h);
    for (const s of stars) {
      const px = cx + Math.cos(s.a) * s.r * maxR;
      const py = cy + Math.sin(s.a) * s.r * maxR;
      const size = (0.4 + s.z * 1.2) * (0.6 + s.r * 0.8);
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

  burstFn = () => {
    warp = 1.8;
  };

  function frame(now: number): void {
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
