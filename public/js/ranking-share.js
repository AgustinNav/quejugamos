// Saves/shares the final ranking as a PNG poster drawn with Canvas 2D, or copies it as text.
// Text and shapes only: no remote images, so the canvas is never tainted (toBlob keeps working)
// and the CSP needs no change. The data comes from ranking-export.js (frozen server results).
import { formatRankingText, likersLabel, SITE } from './ranking-export.js';

const W = 1080;
const H = 1350;
const PAD = 72;
const COLORS = { bg: '#0e0f14', panel: '#20232f', border: '#2c3040', text: '#f1f2f6', muted: '#9aa0b4', accent: '#ff4f7b', accent2: '#ff8a3d', gold: '#ffc542' };
const SHARE_TITLE = 'Nuestro ranking de ¿Qué Jugamos?';

const fontFamily = () => getComputedStyle(document.body).fontFamily || 'sans-serif';

/** Cuts `text` with an ellipsis until it fits `maxWidth` in the context's current font. */
function fit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

function drawBackground(ctx) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(220, 0, 0, 220, 0, 700);
  glow.addColorStop(0, 'rgba(255, 79, 123, 0.28)');
  glow.addColorStop(1, 'rgba(255, 79, 123, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function drawHeader(ctx, model, family) {
  const gradient = ctx.createLinearGradient(PAD, 0, 700, 0);
  gradient.addColorStop(0, COLORS.accent);
  gradient.addColorStop(1, COLORS.accent2);
  ctx.fillStyle = gradient;
  ctx.font = `700 76px ${family}`;
  ctx.fillText('¿Qué Jugamos?', PAD, 128);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `500 32px ${family}`;
  ctx.fillText(`Ranking del ${model.date}`, PAD, 186);
  const players = model.players.length ? `Jugaron: ${model.players.join(', ')}` : '';
  ctx.fillText(fit(ctx, players, W - PAD * 2), PAD, 232);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawRow(ctx, item, y, rowH, family) {
  const inner = rowH - 12;
  roundRect(ctx, PAD, y, W - PAD * 2, inner, 18);
  ctx.fillStyle = COLORS.panel;
  ctx.fill();
  ctx.strokeStyle = item.match ? COLORS.gold : COLORS.border;
  ctx.lineWidth = item.match ? 3 : 1.5;
  ctx.stroke();
  const mid = y + inner / 2;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.muted;
  ctx.font = `700 34px ${family}`;
  ctx.fillText(item.match ? '💘' : String(item.position), PAD + 44, mid);
  ctx.textAlign = 'left';
  const likes = `${item.likes} 👍`;
  ctx.font = `700 32px ${family}`;
  const likesW = ctx.measureText(likes).width;
  const textX = PAD + 92;
  const textW = W - PAD - 24 - likesW - textX - 16;
  const who = likersLabel(item.likers);
  ctx.font = `700 34px ${family}`;
  ctx.fillStyle = COLORS.text;
  ctx.fillText(fit(ctx, item.name, textW), textX, who ? mid - 16 : mid);
  if (who) {
    ctx.font = `400 25px ${family}`;
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(fit(ctx, who, textW), textX, mid + 22);
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.text;
  ctx.font = `700 32px ${family}`;
  ctx.fillText(likes, W - PAD - 24, mid);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawFooter(ctx, model, family) {
  ctx.fillStyle = COLORS.muted;
  if (model.played.length) {
    ctx.font = `400 26px ${family}`;
    ctx.fillText(fit(ctx, `✅ Ya jugados: ${model.played.join(', ')}`, W - PAD * 2), PAD, H - 120);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.accent2;
  ctx.font = `700 34px ${family}`;
  ctx.fillText(SITE, W / 2, H - 56);
  ctx.textAlign = 'left';
}

/** Draws the poster and resolves to a PNG Blob. Waits for the page font so text is not drawn in a fallback. */
export async function renderPoster(model) {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const family = fontFamily();
  drawBackground(ctx);
  drawHeader(ctx, model, family);
  const top = 280;
  const rowH = Math.min(94, Math.floor((H - top - 170) / Math.max(1, model.items.length)));
  model.items.forEach((item, i) => drawRow(ctx, item, top + i * rowH, rowH, family));
  if (model.total > model.items.length) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `400 26px ${family}`;
    ctx.fillText(`… y ${model.total - model.items.length} más`, PAD, top + model.items.length * rowH + 28);
  }
  drawFooter(ctx, model, family);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))), 'image/png');
  });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke on the next tick: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Shares the PNG through the system share sheet where files are supported (phones), else downloads it.
 * Resolves to 'shared' | 'downloaded' | 'cancelled'.
 */
export async function savePoster(model) {
  const blob = await renderPoster(model);
  const filename = `ranking-${model.code}.png`;
  const file = new File([blob], filename, { type: 'image/png' });
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: SHARE_TITLE });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled'; // the user closed the sheet
      console.warn('[ranking-share] share failed, downloading instead:', err);
    }
  }
  download(blob, filename);
  return 'downloaded';
}

/** Copies the plain-text ranking. Rejects when the clipboard is unavailable or denied. */
export async function copyRankingText(model) {
  if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
  await navigator.clipboard.writeText(formatRankingText(model));
}
