/*
 * Painted frames for the preview. There is no real stream to decode here, so
 * each title gets a small landscape in the style of the nature footage it
 * names: a dawn lake, a snowfield, a storm over the desert, an aurora. Real
 * use shows real video frames; these only have to read like them, at the
 * size the engine captures (256 by 144). The same title always paints the
 * same frame.
 */

const W = 256;
const H = 144;
type Ctx = CanvasRenderingContext2D;
type Rand = () => number;

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function seeded(seed: number): Rand {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function sky(ctx: Ctx, stops: [number, string][], y1 = H): void {
  const g = ctx.createLinearGradient(0, 0, 0, y1);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function glow(ctx: Ctx, x: number, y: number, r: number, color: string): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** A ridge across the frame: smooth hills from two sine waves, plus a little grit, filled to the bottom. */
function ridge(ctx: Ctx, rand: Rand, base: number, amp: number, fill: string | CanvasGradient, grit = 0.15): void {
  const f1 = 0.8 + rand() * 1.6;
  const f2 = 2.5 + rand() * 4;
  const p1 = rand() * 6.28;
  const p2 = rand() * 6.28;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 3) {
    const n = 0.62 * Math.sin((x / W) * Math.PI * f1 + p1) + 0.28 * Math.sin((x / W) * Math.PI * f2 + p2) + grit * (rand() - 0.5);
    ctx.lineTo(x, base - amp * (n * 0.5 + 0.5));
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();
}

function vertical(ctx: Ctx, y0: number, y1: number, top: string, bottom: string): CanvasGradient {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  return g;
}

function pines(ctx: Ctx, rand: Rand, y: number, count: number, min: number, max: number, color: string): void {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = rand() * W;
    const h = min + rand() * (max - min);
    const w = h * 0.32;
    for (let tier = 0; tier < 3; tier++) {
      const top = y - h + tier * h * 0.22;
      const half = w * (0.55 + tier * 0.25);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x - half, top + h * 0.45);
      ctx.lineTo(x + half, top + h * 0.45);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillRect(x - 0.7, y - h * 0.12, 1.4, h * 0.14);
  }
}

function stars(ctx: Ctx, rand: Rand, count: number, maxY: number): void {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.25 + rand() * 0.65})`;
    const r = rand() < 0.1 ? 1.1 : 0.6;
    ctx.beginPath();
    ctx.arc(rand() * W, rand() * maxY, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Soft horizontal haze: blurred ellipses of light. */
function haze(ctx: Ctx, rand: Rand, y: number, color: string, count = 4, spread = 10): void {
  ctx.save();
  ctx.filter = 'blur(6px)';
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    ctx.beginPath();
    ctx.ellipse(rand() * W, y + (rand() - 0.5) * spread, 50 + rand() * 60, 5 + rand() * 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** The frame above `horizon`, mirrored below it, dimmed and tinted like still water. */
function reflect(ctx: Ctx, horizon: number, tint: string): void {
  const copy = document.createElement('canvas');
  copy.width = W;
  copy.height = H;
  copy.getContext('2d')!.drawImage(ctx.canvas, 0, 0);
  ctx.save();
  ctx.translate(0, horizon * 2);
  ctx.scale(1, -1);
  ctx.globalAlpha = 0.55;
  ctx.drawImage(copy, 0, 0, W, horizon, 0, 0, W, horizon);
  ctx.restore();
  ctx.fillStyle = tint;
  ctx.fillRect(0, horizon, W, H - horizon);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  for (let y = horizon + 3; y < H; y += 4) ctx.fillRect(0, y, W, 0.6);
}

/** Film grain and a soft vignette, the two things that make flat shapes read as footage. */
function finish(ctx: Ctx, rand: Rand): void {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 14;
    d[i] = d[i]! + n;
    d[i + 1] = d[i + 1]! + n;
    d[i + 2] = d[i + 2]! + n;
  }
  ctx.putImageData(img, 0, 0);
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

const scenes: { match: RegExp; paint: (ctx: Ctx, r: Rand, title: string) => void }[] = [
  {
    match: /aurora|northern lights/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#030a17'], [0.6, '#0a2236'], [1, '#12354a']]);
      stars(ctx, r, 90, 90);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.filter = 'blur(5px)';
      for (const [color, off] of [['rgba(60,255,170,0.55)', 0], ['rgba(140,90,255,0.35)', 18], ['rgba(60,220,255,0.3)', -14]] as const) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let x = -10; x <= W + 10; x += 6) ctx.lineTo(x, 40 + off + Math.sin(x / 28 + off) * 12);
        for (let x = W + 10; x >= -10; x -= 6) ctx.lineTo(x, 70 + off + Math.sin(x / 22 + off) * 10);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ridge(ctx, r, 112, 34, '#071420', 0.25);
      ridge(ctx, r, 132, 14, vertical(ctx, 110, H, '#9fb7c9', '#c9dbe8'), 0.05);
    },
  },
  {
    match: /bioluminescent/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#020611'], [0.55, '#06162b'], [1, '#041026']]);
      stars(ctx, r, 70, 70);
      ridge(ctx, r, 78, 16, '#030a14', 0.1);
      ctx.fillStyle = vertical(ctx, 78, H, '#041a2e', '#02101d');
      ctx.fillRect(0, 78, W, H - 78);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 70; i++) glow(ctx, r() * W, 86 + r() * 58, 3 + r() * 9, `rgba(40,220,255,${0.15 + r() * 0.35})`);
      ctx.restore();
    },
  },
  {
    match: /coral|reef/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#2fb7d6'], [0.5, '#0f6f9e'], [1, '#08355a']]);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.filter = 'blur(3px)';
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = 'rgba(200,255,255,0.10)';
        const x = r() * W;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + 30, 0);
        ctx.lineTo(x - 20 + r() * 40, H);
        ctx.lineTo(x - 50, H);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      for (let i = 0; i < 9; i++) {
        const x = r() * W;
        const colors = ['#ff7f6b', '#ffb347', '#e05fa0', '#f2d06b'];
        ctx.fillStyle = colors[i % colors.length]!;
        ctx.beginPath();
        ctx.ellipse(x, H - 8 - r() * 10, 10 + r() * 16, 8 + r() * 14, 0, Math.PI, 0);
        ctx.fill();
      }
      ridge(ctx, r, H - 4, 8, '#0a2a3e', 0.2);
    },
  },
  {
    match: /whale|ocean|sea\b|maui/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#8cc7ef'], [0.45, '#d6ecf7'], [0.5, '#2a7fb4'], [1, '#0d3f66']]);
      haze(ctx, r, 30, 'rgba(255,255,255,0.55)', 5, 20);
      ctx.fillStyle = vertical(ctx, 72, H, '#2b84ba', '#0c3b61');
      ctx.fillRect(0, 72, W, H - 72);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      for (let i = 0; i < 40; i++) ctx.fillRect(r() * W, 74 + r() * 70, 6 + r() * 16, 0.8);
      // A breaching whale: a dark arc and a splash.
      ctx.fillStyle = '#16232e';
      ctx.beginPath();
      ctx.ellipse(150, 82, 34, 13, -0.5, Math.PI * 0.95, Math.PI * 2.05);
      ctx.fill();
      ctx.save();
      ctx.filter = 'blur(2px)';
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      for (let i = 0; i < 18; i++) {
        ctx.beginPath();
        ctx.arc(120 + r() * 70, 78 + r() * 14, 1.5 + r() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  },
  {
    match: /geyser|faithful/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#4f93d6'], [1, '#bfe0f5']]);
      ctx.save();
      ctx.filter = 'blur(7px)';
      for (let i = 0; i < 16; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.35 + r() * 0.4})`;
        ctx.beginPath();
        ctx.arc(128 + (r() - 0.5) * (14 + i * 4), 104 - i * 6, 10 + i * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      ridge(ctx, r, 104, 10, '#5d6f52', 0.1);
      ridge(ctx, r, 126, 8, vertical(ctx, 110, H, '#a58d6b', '#7a6449'), 0.2);
    },
  },
  {
    match: /storm|monsoon|desert|sonoran/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#1d1b2e'], [0.5, '#4a3f5c'], [0.75, '#c27b4e'], [1, '#e9a066']]);
      ctx.save();
      ctx.filter = 'blur(8px)';
      for (let i = 0; i < 10; i++) {
        ctx.fillStyle = `rgba(20,18,32,${0.45 + r() * 0.35})`;
        ctx.beginPath();
        ctx.ellipse(r() * W, 18 + r() * 34, 40 + r() * 40, 12 + r() * 10, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = 'rgba(235,230,255,0.95)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let x = 150;
      ctx.moveTo(x, 40);
      for (let y = 40; y < 104; y += 8) ctx.lineTo((x += (r() - 0.5) * 14), y);
      ctx.stroke();
      glow(ctx, 150, 70, 40, 'rgba(200,190,255,0.25)');
      ridge(ctx, r, 108, 10, '#5a3a2e', 0.1);
      ridge(ctx, r, 128, 6, vertical(ctx, 115, H, '#b4693f', '#7d4228'), 0.1);
      ctx.fillStyle = '#2e1d18';
      for (const sx of [50, 196]) {
        ctx.fillRect(sx, 98, 4, 30);
        ctx.fillRect(sx - 7, 108, 3, 10);
        ctx.fillRect(sx - 7, 116, 10, 3);
        ctx.fillRect(sx + 8, 104, 3, 12);
        ctx.fillRect(sx + 2, 113, 9, 3);
      }
    },
  },
  {
    match: /fox|snow|leopard|hemis/i,
    paint: (ctx, r, title) => {
      sky(ctx, [[0, '#9cc2e4'], [1, '#e8f1f8']]);
      ridge(ctx, r, 74, 30, vertical(ctx, 40, 90, '#d7e4ef', '#a9bfd3'), 0.2);
      pines(ctx, r, 98, 14, 14, 30, '#2e4a3f');
      ridge(ctx, r, 120, 16, vertical(ctx, 100, H, '#f7fbff', '#cfdeeb'), 0.05);
      if (!/fox/i.test(title)) return;
      // A red fox mid leap.
      ctx.fillStyle = '#c4572a';
      ctx.beginPath();
      ctx.ellipse(118, 112, 12, 5, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(134, 104, 9, 3, -0.6, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    match: /sunset|canyon|grand/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#2b2350'], [0.45, '#e2665a'], [0.7, '#f6a85a'], [1, '#ffd38a']]);
      glow(ctx, 196, 80, 60, 'rgba(255,214,150,0.75)');
      ridge(ctx, r, 92, 18, '#7b3f3b', 0.05);
      ridge(ctx, r, 112, 16, '#5a2c30', 0.05);
      ridge(ctx, r, 134, 12, '#3a1d24', 0.05);
    },
  },
  {
    match: /fog|valley|redwood|forest|canopy/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#c7d6cf'], [1, '#e9efe9']]);
      for (const [y, color, h] of [[70, '#8fa69a', 22], [92, '#5f7d6c', 30], [118, '#2f4a3c', 40], [142, '#17271f', 48]] as const) {
        pines(ctx, r, y, 26, h * 0.55, h, color);
        haze(ctx, r, y - 6, 'rgba(235,242,236,0.55)', 5, 8);
      }
    },
  },
  {
    match: /waterfall|iceland/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#6f8ea6'], [1, '#d4dee4']]);
      haze(ctx, r, 24, 'rgba(255,255,255,0.45)', 4, 14);
      ridge(ctx, r, 58, 18, vertical(ctx, 30, 80, '#5d7f55', '#3d5e3a'), 0.2);
      // A green cliff with a rounded lip, and the fall pouring over it.
      ctx.fillStyle = vertical(ctx, 50, H, '#34503a', '#1b2b20');
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(0, 70);
      ctx.quadraticCurveTo(60, 50, 128, 54);
      ctx.quadraticCurveTo(196, 50, W, 66);
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
      ctx.save();
      ctx.filter = 'blur(1.2px)';
      const fall = ctx.createLinearGradient(0, 54, 0, 128);
      fall.addColorStop(0, 'rgba(250,252,255,0.95)');
      fall.addColorStop(1, 'rgba(225,238,245,0.75)');
      ctx.fillStyle = fall;
      ctx.beginPath();
      ctx.moveTo(118, 54);
      ctx.lineTo(138, 54);
      ctx.lineTo(144, 128);
      ctx.lineTo(112, 128);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      haze(ctx, r, 126, 'rgba(255,255,255,0.75)', 6, 8);
      ctx.fillStyle = vertical(ctx, 128, H, '#5f7f8f', '#2f4a56');
      ctx.fillRect(0, 130, W, 14);
    },
  },
  {
    match: /glacier|perito|ice/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#5d88b8'], [1, '#cfe1ef']]);
      ridge(ctx, r, 66, 26, '#6d7f93', 0.2);
      ctx.fillStyle = vertical(ctx, 64, 102, '#eaf6fb', '#8fd0e6');
      ctx.beginPath();
      ctx.moveTo(0, 102);
      for (let x = 0; x <= W; x += 8) ctx.lineTo(x, 70 + r() * 10);
      ctx.lineTo(W, 102);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = vertical(ctx, 102, H, '#2fa6b7', '#14606e');
      ctx.fillRect(0, 102, W, H - 102);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      for (let i = 0; i < 8; i++) ctx.fillRect(r() * W, 108 + r() * 30, 4 + r() * 8, 2);
    },
  },
  {
    match: /serengeti|wildebeest|elephant|herd|savanna|migration/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#f0a65a'], [0.6, '#f8d58f'], [1, '#f6e2b0']]);
      glow(ctx, 70, 92, 50, 'rgba(255,240,200,0.7)');
      ridge(ctx, r, 104, 6, '#b58a4c', 0.1);
      ctx.fillStyle = vertical(ctx, 104, H, '#c99a55', '#8f6631');
      ctx.fillRect(0, 108, W, H - 108);
      ctx.fillStyle = '#3b2a1c';
      for (let i = 0; i < 40; i++) {
        const x = r() * W;
        const y = 110 + r() * 26;
        const s = 1 + (y - 108) / 20;
        ctx.fillRect(x, y, 4 * s, 2 * s);
      }
      // An acacia.
      ctx.fillRect(196, 70, 3, 38);
      ctx.beginPath();
      ctx.ellipse(198, 70, 28, 7, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    match: /butterfly|monarch/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#2d3d2a'], [1, '#6a7d3e']]);
      glow(ctx, 170, 30, 80, 'rgba(255,220,140,0.45)');
      pines(ctx, r, 144, 18, 50, 110, 'rgba(20,30,18,0.85)');
      for (let i = 0; i < 70; i++) {
        ctx.fillStyle = r() < 0.5 ? '#f08a24' : '#e4661a';
        const x = r() * W;
        const y = r() * H;
        ctx.beginPath();
        ctx.ellipse(x - 1.5, y, 2, 1.2, 0.6, 0, Math.PI * 2);
        ctx.ellipse(x + 1.5, y, 2, 1.2, -0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  {
    match: /coast|trailer|cliff/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#6aa4d4'], [0.5, '#cfe3f2'], [0.52, '#3f86b0'], [1, '#1b4e70']]);
      ctx.fillStyle = '#3c4a3a';
      ctx.beginPath();
      ctx.moveTo(W, 40);
      ctx.lineTo(160, 52);
      ctx.lineTo(140, 90);
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
      haze(ctx, r, 90, 'rgba(255,255,255,0.5)', 4, 6);
    },
  },
];

/** Dawn over mountains and still water: the default, and every lake, crane and alpine title. */
function dawn(ctx: Ctx, r: Rand): void {
  sky(ctx, [[0, '#2c3e6b'], [0.45, '#c96f7a'], [0.75, '#f3b27a'], [1, '#ffe2b0']], 86);
  glow(ctx, 70 + r() * 110, 72, 46, 'rgba(255,228,170,0.85)');
  haze(ctx, r, 40, 'rgba(255,200,190,0.35)', 4, 18);
  ridge(ctx, r, 70, 40, vertical(ctx, 24, 86, '#6a5a86', '#3f3a5e'), 0.12);
  ridge(ctx, r, 86, 18, '#2b2c45', 0.1);
  reflect(ctx, 86, 'rgba(20,30,60,0.35)');
}

/** A 256 by 144 JPEG data URL that reads like a frame of the footage `title` names. */
export function paintScene(title: string): string {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const r = seeded(hash(title));
  (scenes.find((s) => s.match.test(title))?.paint ?? dawn)(ctx, r, title);
  finish(ctx, r);
  return c.toDataURL('image/jpeg', 0.82);
}
