/*
 * Painted frames for the preview. There is no real stream to decode here, so
 * each title gets a small landscape in the style of the nature footage it
 * names: a dawn lake, a snowfield, a storm over the desert, an aurora. Real
 * use shows real video frames; these only have to read like them, at the
 * size the engine captures (384 by 216). The same title always paints the
 * same frame.
 */

const W = 256;
const H = 144;
/** Output scale: the engine's frames are 384 by 216. */
const S = 1.5;
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
  copy.width = ctx.canvas.width;
  copy.height = ctx.canvas.height;
  copy.getContext('2d')!.drawImage(ctx.canvas, 0, 0);
  ctx.save();
  ctx.translate(0, horizon * 2);
  ctx.scale(1, -1);
  ctx.globalAlpha = 0.6;
  ctx.filter = 'blur(1.5px)';
  ctx.drawImage(copy, 0, 0, copy.width, horizon * S, 0, 0, W, horizon);
  ctx.restore();
  ctx.fillStyle = tint;
  ctx.fillRect(0, horizon, W, H - horizon);
  // A few soft glints instead of hard ripple lines.
  ctx.save();
  ctx.filter = 'blur(1px)';
  ctx.fillStyle = 'rgba(255,236,210,0.22)';
  for (let i = 0; i < 9; i++) ctx.fillRect(40 + ((i * 53) % 170), horizon + 6 + ((i * 17) % (H - horizon - 10)), 18 + ((i * 7) % 20), 1.2);
  ctx.restore();
}

/** A walking elephant in silhouette, `s` tall at the shoulder, facing left. */
function elephant(ctx: Ctx, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.ellipse(x, y - s * 0.62, s * 0.62, s * 0.38, 0, 0, Math.PI * 2);
  ctx.ellipse(x - s * 0.62, y - s * 0.72, s * 0.24, s * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(x - s * 0.86, y - s * 0.68, s * 0.1, s * 0.62);
  for (const dx of [-0.42, -0.2, 0.2, 0.42]) ctx.fillRect(x + dx * s - s * 0.07, y - s * 0.4, s * 0.14, s * 0.4);
}

/** A crane or other long winged bird in flight, a shallow V. */
function bird(ctx: Ctx, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x - s, y - s * 0.35);
  ctx.quadraticCurveTo(x - s * 0.4, y - s * 0.1, x, y);
  ctx.quadraticCurveTo(x + s * 0.4, y - s * 0.1, x + s, y - s * 0.35);
  ctx.lineWidth = Math.max(1, s * 0.18);
  ctx.stroke();
}

/** Film grain and a soft vignette, the two things that make flat shapes read as footage. */
function finish(ctx: Ctx, rand: Rand): void {
  const img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 14;
    d[i] = d[i]! + n;
    d[i + 1] = d[i + 1]! + n;
    d[i + 2] = d[i + 2]! + n;
  }
  ctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.setTransform(S, 0, 0, S, 0, 0);
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

const scenes: { match: RegExp; paint: (ctx: Ctx, r: Rand, title: string) => void }[] = [
  { match: /alpine|lake/i, paint: (ctx, r) => dawn(ctx, r) },
  {
    match: /dolomites|peaks/i,
    paint: (ctx, r) => {
      // Alpenglow: pale limestone spires lit rose, blue shadow, a green meadow.
      sky(ctx, [[0, '#3b4f86'], [0.55, '#9db2da'], [1, '#e9d6dc']]);
      ctx.fillStyle = vertical(ctx, 20, 100, '#f2b8a8', '#a7879c');
      ctx.beginPath();
      ctx.moveTo(0, 104);
      let x = 0;
      while (x < W) {
        const w = 26 + r() * 40;
        ctx.lineTo(x + w * 0.35, 40 + r() * 20);
        ctx.lineTo(x + w * 0.5, 18 + r() * 30);
        ctx.lineTo(x + w * 0.62, 34 + r() * 20);
        ctx.lineTo(x + w, 74 + r() * 18);
        x += w;
      }
      ctx.lineTo(W, 104);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(60,70,120,0.35)';
      ctx.fillRect(0, 80, W, 30);
      ridge(ctx, r, 116, 12, vertical(ctx, 100, H, '#6f9a52', '#3e6634'), 0.08);
      pines(ctx, r, 132, 10, 10, 20, '#24402a');
    },
  },
  {
    match: /crane|platte|river/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#4b5a8c'], [0.5, '#e7a27a'], [0.8, '#f6cf8f'], [1, '#fbe3b5']], 96);
      glow(ctx, 160, 92, 56, 'rgba(255,226,160,0.9)');
      ctx.fillStyle = '#4a3b3e';
      ctx.fillRect(0, 94, W, 4);
      reflect(ctx, 96, 'rgba(60,40,50,0.25)');
      ctx.strokeStyle = '#2a2230';
      for (let i = 0; i < 9; i++) bird(ctx, 40 + i * 12 + r() * 6, 26 + Math.abs(i - 4) * 5 + r() * 3, 4 + r() * 1.5);
      ctx.fillStyle = '#2a2420';
      for (let i = 0; i < 60; i++) ctx.fillRect(r() * W, 126 + r() * 18, 1, 6 + r() * 10);
    },
  },
  {
    match: /elephant|waterhole|etosha/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#6d5a86'], [0.5, '#d98e86'], [1, '#f2c49b']], 100);
      glow(ctx, 60, 96, 46, 'rgba(255,214,170,0.75)');
      ctx.fillStyle = '#8a6a55';
      ctx.fillRect(0, 98, W, H - 98);
      ctx.fillStyle = vertical(ctx, 108, 132, '#e5a993', '#b98a86');
      ctx.beginPath();
      ctx.ellipse(128, 120, 96, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2b1f1f';
      elephant(ctx, 150, 112, 26);
      elephant(ctx, 186, 110, 20);
      elephant(ctx, 94, 112, 16);
    },
  },
  {
    match: /leopard|hemis/i,
    paint: (ctx, r) => {
      // Cold crags at dusk: steep grey rock streaked with snow.
      sky(ctx, [[0, '#2c3a57'], [1, '#93a6c2']]);
      ctx.fillStyle = vertical(ctx, 20, H, '#c9d4e2', '#5c6a80');
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(0, 70);
      ctx.lineTo(54, 28);
      ctx.lineTo(80, 52);
      ctx.lineTo(126, 18);
      ctx.lineTo(168, 60);
      ctx.lineTo(206, 40);
      ctx.lineTo(W, 74);
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(40,52,74,0.45)';
      for (const [x0, y0] of [[54, 28], [126, 18], [206, 40]] as const) {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + 26, y0 + 70);
        ctx.lineTo(x0 + 6, y0 + 70);
        ctx.closePath();
        ctx.fill();
      }
      haze(ctx, r, 96, 'rgba(230,238,248,0.5)', 5, 10);
      ridge(ctx, r, 132, 10, vertical(ctx, 120, H, '#eef3f8', '#c3cfdb'), 0.05);
    },
  },
  {
    match: /redwood|canopy/i,
    paint: (ctx, r) => {
      // Looking up a redwood grove: tall trunks, green crowns, shafts of light.
      sky(ctx, [[0, '#cfe0c8'], [1, '#6b8a5c']]);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.filter = 'blur(4px)';
      ctx.fillStyle = 'rgba(255,245,200,0.18)';
      for (let i = 0; i < 4; i++) {
        const x = 40 + i * 50;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + 18, 0);
        ctx.lineTo(x + 60, H);
        ctx.lineTo(x + 30, H);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      for (const [depth, alpha] of [[0.5, 0.45], [1, 1]] as const) {
        for (let i = 0; i < 5; i++) {
          const x = r() * W;
          const w = (6 + r() * 14) * depth + 3;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = vertical(ctx, 0, H, '#4a271c', '#8a4a32');
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + w * 0.8, 0);
          ctx.lineTo(x + w, H);
          ctx.lineTo(x - w * 0.2, H);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = 'rgba(255,200,160,0.2)';
          ctx.fillRect(x + w * 0.55, 0, w * 0.18, H);
        }
      }
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.filter = 'blur(3px)';
      ctx.fillStyle = 'rgba(30,60,32,0.85)';
      for (let i = 0; i < 9; i++) {
        ctx.beginPath();
        ctx.ellipse(r() * W, r() * 22, 30 + r() * 30, 12 + r() * 8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      haze(ctx, r, 120, 'rgba(230,240,225,0.55)', 6, 16);
      ctx.fillStyle = '#2f5a2a';
      for (let i = 0; i < 30; i++) {
        ctx.beginPath();
        ctx.ellipse(r() * W, H - r() * 10, 8 + r() * 8, 3, (r() - 0.5) * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  {
    match: /plains|thunderstorm/i,
    paint: (ctx, r) => {
      // A supercell over green prairie, light breaking under the cloud.
      sky(ctx, [[0, '#2a3340'], [0.55, '#5d6b7a'], [0.7, '#e8c98f'], [1, '#c9b57e']], 100);
      ctx.save();
      ctx.filter = 'blur(6px)';
      ctx.fillStyle = 'rgba(30,36,46,0.9)';
      ctx.beginPath();
      ctx.ellipse(128, 34, 130, 30, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(70,80,96,0.8)';
      ctx.beginPath();
      ctx.ellipse(150, 60, 70, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.filter = 'blur(3px)';
      ctx.fillStyle = 'rgba(120,130,150,0.45)';
      for (let i = 0; i < 12; i++) ctx.fillRect(170 + i * 5, 62, 2, 40);
      ctx.restore();
      ctx.fillStyle = vertical(ctx, 100, H, '#7f9a4a', '#46602a');
      ctx.fillRect(0, 100, W, H - 100);
      ctx.fillStyle = 'rgba(255,240,190,0.25)';
      ctx.fillRect(0, 100, W, 3);
    },
  },
  {
    match: /butterfly|monarch/i,
    paint: (ctx, r) => {
      // Fir forest in morning light, thick with monarchs.
      sky(ctx, [[0, '#2d3d2a'], [1, '#6a7d3e']]);
      glow(ctx, 170, 30, 80, 'rgba(255,220,140,0.45)');
      pines(ctx, r, 144, 18, 50, 110, 'rgba(20,30,18,0.85)');
      for (let i = 0; i < 90; i++) {
        ctx.fillStyle = r() < 0.5 ? '#f39a2e' : '#e4661a';
        const x = r() * W;
        const y = r() * H;
        ctx.beginPath();
        ctx.ellipse(x - 1.6, y, 2.2, 1.3, 0.6, 0, Math.PI * 2);
        ctx.ellipse(x + 1.6, y, 2.2, 1.3, -0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
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
      ctx.ellipse(86, 70, 46, 17, -0.75, Math.PI * 0.95, Math.PI * 2.05);
      ctx.fill();
      // Pectoral fin and the white throat grooves catching light.
      ctx.beginPath();
      ctx.ellipse(70, 62, 16, 4, -1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(220,230,240,0.55)';
      ctx.beginPath();
      ctx.ellipse(98, 58, 18, 4, -0.75, 0, Math.PI);
      ctx.fill();
      ctx.save();
      ctx.filter = 'blur(2px)';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let i = 0; i < 26; i++) {
        ctx.beginPath();
        ctx.arc(52 + r() * 80, 76 + r() * 14, 1.5 + r() * 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  },
  {
    match: /geyser|faithful/i,
    paint: (ctx, r) => {
      sky(ctx, [[0, '#2f6fb8'], [1, '#a9d2ef']]);
      ridge(ctx, r, 98, 14, '#47603f', 0.1);
      // The column: a bright narrow jet that billows into steam as it rises.
      ctx.save();
      ctx.filter = 'blur(1.5px)';
      ctx.fillStyle = vertical(ctx, 20, 110, 'rgba(255,255,255,0.7)', 'rgba(255,255,255,0.98)');
      ctx.beginPath();
      ctx.moveTo(112, 110);
      ctx.quadraticCurveTo(118, 60, 108, 24);
      ctx.lineTo(132, 24);
      ctx.quadraticCurveTo(124, 60, 128, 110);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.filter = 'blur(6px)';
      for (let i = 0; i < 14; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.3 + r() * 0.4})`;
        ctx.beginPath();
        ctx.arc(122 + (r() - 0.3) * (20 + i * 5), 40 - i * 2 + r() * 20, 8 + r() * 12, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      // The sinter cone, pale and mineral.
      ctx.fillStyle = vertical(ctx, 100, H, '#d9cdb2', '#9c8a6c');
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(0, 120);
      ctx.quadraticCurveTo(120, 100, W, 122);
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
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
    match: /serengeti|wildebeest|savanna/i,
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
  c.width = W * S;
  c.height = H * S;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.scale(S, S);
  const r = seeded(hash(title));
  (scenes.find((s) => s.match.test(title))?.paint ?? dawn)(ctx, r, title);
  finish(ctx, r);
  return c.toDataURL('image/jpeg', 0.82);
}
