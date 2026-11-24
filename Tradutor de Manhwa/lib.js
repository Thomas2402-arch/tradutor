// Funções puras usadas pelo background (e testadas fora do Chrome).

var DEFAULT_LIMITS = {
  MAX_WIDTH: 600,        // largura enviada ao Claude (px): texto de webtoon continua legível e sai mais barato
  MAX_EDGE: 1568,        // lado maior máximo antes do Claude reduzir a imagem
  MAX_PIXELS: 1150000,   // ~1,15 megapixel por fatia
  OVERLAP: 0.15          // 15% de sobreposição entre fatias de tiras longas
};

// No Gemini grátis o que conta é o número de pedidos por dia, então as
// fatias são maiores (menos pedidos por capítulo).
var GEMINI_LIMITS = {
  MAX_WIDTH: 600,
  MAX_EDGE: 2000,
  MAX_PIXELS: 1400000,
  OVERLAP: 0.15
};

// Modo Google: o leitor de texto do Chrome lê a fatia no tamanho real (sem custo).
var OCR_LIMITS = {
  MAX_WIDTH: 1000,
  MAX_EDGE: 2000,
  MAX_PIXELS: 2500000,
  OVERLAP: 0.15
};

// Linha parece texto de verdade (e não um pedaço do desenho lido errado)?
function isTexty(t) {
  const s = String(t || '').replace(/[\s.,!?…'"“”‘’\-–—]/g, '');
  const letters = (s.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  return letters >= 2 && letters / Math.max(1, s.length) >= 0.6;
}

// Junta as linhas lidas pelo leitor de texto em balões (linhas próximas,
// uma embaixo da outra e alinhadas, são do mesmo balão).
function groupLines(lines) {
  const L = lines.filter(l => isTexty(l.text) && l.w > 0 && l.h > 0).sort((a, b) => a.y - b.y || a.x - b.x);
  const groups = [];
  for (const l of L) {
    let target = null;
    for (const g of groups) {
      const last = g.lines[g.lines.length - 1];
      const lh = Math.max(last.h, l.h);
      const gap = l.y - (last.y + last.h);
      const overlap = Math.min(l.x + l.w, g.x + g.w) - Math.max(l.x, g.x);
      const dc = Math.abs((l.x + l.w / 2) - (g.x + g.w / 2));
      if (gap < lh * 1.1 && gap > -lh * 0.6 && (overlap > Math.min(l.w, g.w) * 0.2 || dc < Math.max(l.w, g.w) * 0.35)) {
        target = g;
        break;
      }
    }
    if (target) {
      target.lines.push(l);
      const x2 = Math.max(target.x + target.w, l.x + l.w), y2 = Math.max(target.y + target.h, l.y + l.h);
      target.x = Math.min(target.x, l.x); target.y = Math.min(target.y, l.y);
      target.w = x2 - target.x; target.h = y2 - target.y;
    } else {
      groups.push({ x: l.x, y: l.y, w: l.w, h: l.h, lines: [l] });
    }
  }
  return groups.map(g => {
    let text = '';
    for (const l of g.lines) {
      const t = l.text.trim();
      text = !text ? t : (/[-‐]$/.test(text) ? text.replace(/[-‐]$/, '') + t : text + ' ' + t);
    }
    const out = { x: g.x, y: g.y, w: g.w, h: g.h, original: text };
    Object.defineProperty(out, 'lines', { value: g.lines, enumerable: false });
    return out;
  });
}

// Linhas -> balões, já sem o lixo.
function cleanGroups(lines, minConf = 0) {
  const ok = lines.filter(l => (l.conf == null || l.conf >= minConf) && plausibleLine(l));
  return groupLines(ok).filter(g => goodGroup(g, g.lines));
}

// Acha balões brancos numa imagem em tons de cinza (já reduzida).
// gray: Uint8Array (0–255), w x h. Devolve caixas na mesma escala.
function findBubbles(gray, w, h, opts = {}) {
  const white = opts.white || 228;
  const maxOut = opts.max || 15;
  const label = new Int32Array(w * h);
  const out = [];
  let id = 0;
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] || gray[start] < white) continue;
    id++;
    label[start] = id;
    stack.push(start);
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p - x) / w;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && !label[p - 1] && gray[p - 1] >= white) { label[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && !label[p + 1] && gray[p + 1] >= white) { label[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && !label[p - w] && gray[p - w] >= white) { label[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && !label[p + w] && gray[p + w] >= white) { label[p + w] = id; stack.push(p + w); }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    const tooBig = !opts.allowBig && bw > w * 0.9 && bh > h * 0.4;  // fundo branco da página, não balão
    if (bw >= 12 && bh >= 7 && area >= 90 && fill >= 0.45 && !tooBig) {
      out.push({ x: minX, y: minY, w: bw, h: bh, area, id });
    }
  }
  return { boxes: out.sort((a, b) => b.area - a.area).slice(0, maxOut), label };
}

// Marca o que fica FORA do balão (o contorno e o desenho em volta), para ser
// apagado antes de ler — o leitor de texto se confunde com o contorno.
// Devolve uma grade na escala reduzida, cobrindo a caixa do balão com 2 de margem.
function bubbleOutsideMask(label, w, h, b) {
  const x0 = Math.max(0, b.x - 2), y0 = Math.max(0, b.y - 2);
  const x1 = Math.min(w - 1, b.x + b.w + 1), y1 = Math.min(h - 1, b.y + b.h + 1);
  const mw = x1 - x0 + 1, mh = y1 - y0 + 1;
  const outside = new Uint8Array(mw * mh);
  const inBlob = (mx, my) => label[(y0 + my) * w + (x0 + mx)] === b.id;
  const stack = [];
  const seed = (mx, my) => { const i = my * mw + mx; if (!outside[i] && !inBlob(mx, my)) { outside[i] = 1; stack.push(i); } };
  for (let mx = 0; mx < mw; mx++) { seed(mx, 0); seed(mx, mh - 1); }
  for (let my = 0; my < mh; my++) { seed(0, my); seed(mw - 1, my); }
  while (stack.length) {
    const i = stack.pop();
    const mx = i % mw, my = (i - mx) / mw;
    if (mx > 0) seed(mx - 1, my);
    if (mx < mw - 1) seed(mx + 1, my);
    if (my > 0) seed(mx, my - 1);
    if (my < mh - 1) seed(mx, my + 1);
  }
  // cresce 1 casa para engolir o contorno por inteiro
  const grown = outside.slice();
  for (let my = 0; my < mh; my++) for (let mx = 0; mx < mw; mx++) {
    if (outside[my * mw + mx]) continue;
    if ((mx > 0 && outside[my * mw + mx - 1]) || (mx < mw - 1 && outside[my * mw + mx + 1]) ||
        (my > 0 && outside[(my - 1) * mw + mx]) || (my < mh - 1 && outside[(my + 1) * mw + mx])) grown[my * mw + mx] = 1;
  }
  return { x0, y0, mw, mh, outside: grown };
}

// Texto com cara de fala de verdade (para a revisão não inventar balão com lixo do desenho).
const SHORT_WORDS = /^(i|a|o|ok|no|go|so|oh|ah|eh|uh|hm|hmm|hey|yes|yo|my|me|we|he|it|is|us|up|on|of|to|in|at|an|or|be|do|by)$/i;
function looksLikeSpeech(t) {
  const words = String(t || '').split(/[^A-Za-z']+/).filter(Boolean);
  if (!words.length) return false;
  return words.some(w => (w.length >= 3 && /[aeiouy]/i.test(w)) || SHORT_WORDS.test(w));
}

// ---------- Filtro de lixo do leitor de texto ----------

// Linha lida com formato impossível para texto (ex.: "linha" muito alta para
// a quantidade de letras = pedaço do desenho lido errado).
function plausibleLine(l) {
  const t = String(l.text || '').trim();
  const n = t.replace(/\s/g, '').length;
  if (!n || l.w <= 0 || l.h <= 0) return false;
  if (n >= 3 && l.h > 2.6 * (l.w / n)) return false;     // alta demais para o tanto de letras
  if (n >= 2 && l.w > l.h * n * 2.2) return false;       // larga demais (letras muito espaçadas)
  const sym = (t.match(/[^\p{L}\p{N}\s.,!?'"“”‘’…\-–—:;()~*]/gu) || []).length;
  return sym / n <= 0.12;
}

// Palavra com mistura estranha de maiúscula/minúscula ("WyZn", "aBc")
function weirdCase(w) {
  return /[a-z][A-Z]/.test(w) || /^[A-Z]{1}[a-z]+[A-Z]/.test(w) || /[A-Z][a-z][A-Z]/.test(w);
}

// O balão montado parece fala de verdade?
function goodGroup(g, lines) {
  const text = String(g.original || '');
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters < 2) return false;
  if (letters === 2 && !SHORT_WORDS.test(text.replace(/[^\p{L}]/gu, ''))) return false; // "NO!", "OH?" passam
  const ls = lines || [];
  if (ls.length >= 2) {
    const avg = ls.reduce((a, l) => a + l.text.replace(/\s/g, '').length, 0) / ls.length;
    if (avg < 3) return false;                            // letras soltas empilhadas
    const lh = ls.map(l => l.h).sort((a, b) => a - b)[ls.length >> 1];
    if (g.w < lh * 2.2) return false;                     // coluna estreita e alta
  }
  const words = text.split(/[^\p{L}']+/u).filter(Boolean);
  if (!words.length) return false;
  const weird = words.filter(weirdCase).length;
  if (weird / words.length > 0.25) return false;
  const wordy = words.filter(w => (w.length >= 2 && /[aeiouyáéíóúãõ]/i.test(w)) || /^(i|a|o|e)$/i.test(w) || SHORT_WORDS.test(w)).length;
  return wordy / words.length >= 0.6 && looksLikeSpeech(text);
}

// Junta as linhas lidas nos recortes (mais confiáveis) com as da página inteira,
// sem repetir a mesma linha.
function mergeLines(primary, secondary) {
  const out = primary.slice();
  for (const l of secondary) {
    if (!out.some(p => overlapRatio(p, l) > 0.3)) out.push(l);
  }
  return out;
}

// "WHERE ARE YOU GOING?" -> "Where are you going?" (o tradutor erra menos)
function tidyCaps(t) {
  const s = String(t || '').trim();
  if (!/[A-Z]/.test(s) || s !== s.toUpperCase()) return s;
  return s.toLowerCase()
    .replace(/(^|[.!?…]\s+|^["'“(]\s*)([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\bi\b/g, 'I')
    .replace(/\bi'(m|ll|ve|d)\b/g, "I'$1");
}

// Divide uma região (largura x altura, em px da imagem original) em fatias
// que a IA consegue ler sem reduzir demais. Tiras verticais longas de
// webtoon viram várias fatias com sobreposição, para não cortar balões.
function planChunks(regionW, regionH, LIMITS = DEFAULT_LIMITS) {
  const sw = Math.min(1, LIMITS.MAX_WIDTH / regionW);
  const scaledW = Math.max(1, Math.round(regionW * sw));
  const maxScaledH = Math.min(LIMITS.MAX_EDGE, Math.floor(LIMITS.MAX_PIXELS / scaledW));
  const fullScaledH = regionH * sw;

  if (fullScaledH <= maxScaledH * 1.15) {
    const s = Math.min(
      sw,
      LIMITS.MAX_EDGE / Math.max(regionW, regionH),
      Math.sqrt(LIMITS.MAX_PIXELS / (regionW * regionH))
    );
    return [{ y0: 0, h: regionH, scale: s }];
  }

  // Fatias de tamanho igual (sem sobrar uma fatia minúscula no fim, que
  // custaria uma leitura inteira à toa). Cada fatia pode passar até 15% do
  // tamanho ideal; nesse caso ela é reduzida um pouco para caber.
  const chunkH = Math.floor(maxScaledH / sw);
  const ov = Math.floor(chunkH * LIMITS.OVERLAP);
  const n = Math.max(2, Math.ceil((regionH - ov) / (chunkH * 1.15 - ov)));
  const h = Math.ceil((regionH + (n - 1) * ov) / n);
  const step = h - ov;
  const scale = Math.min(sw, LIMITS.MAX_EDGE / h, Math.sqrt(LIMITS.MAX_PIXELS / (regionW * h)));
  const chunks = [];
  for (let i = 0; i < n; i++) {
    const y0 = i * step;
    chunks.push({ y0, h: i === n - 1 ? regionH - y0 : Math.min(h, regionH - y0), scale });
  }
  return chunks;
}

// Converte as caixas que o Claude devolveu (em px da fatia enviada) para
// coordenadas da região original. Aceita também respostas normalizadas (0–1).
function chunkBoxesToRegion(bubbles, chunk, sentW, sentH) {
  const out = [];
  if (!Array.isArray(bubbles)) return out;
  const nums = bubbles.flatMap(b => [b.x, b.y, b.w, b.h]).filter(Number.isFinite);
  const normalized = nums.length > 0 && nums.every(n => n >= 0 && n <= 1.0001);
  for (const b of bubbles) {
    const text = String(b.translation ?? b.text ?? '').trim();
    if (!text) continue;
    let { x, y, w, h } = b;
    if (![x, y, w, h].every(Number.isFinite)) continue;
    if (normalized) { x *= sentW; y *= sentH; w *= sentW; h *= sentH; }
    // corrige caixas fora da imagem
    x = Math.max(0, Math.min(x, sentW - 1));
    y = Math.max(0, Math.min(y, sentH - 1));
    w = Math.max(4, Math.min(w, sentW - x));
    h = Math.max(4, Math.min(h, sentH - y));
    out.push({
      x: x / chunk.scale,
      y: chunk.y0 + y / chunk.scale,
      w: w / chunk.scale,
      h: h / chunk.scale,
      text,
      original: String(b.original ?? '').trim(),
      kind: ['dialogue', 'narration', 'sfx', 'sign'].includes(b.kind) ? b.kind : 'dialogue'
    });
  }
  return out;
}

// Remove balões repetidos que aparecem em duas fatias vizinhas (na faixa de
// sobreposição). Fica com a versão mais longe da borda da fatia, que é a que
// o Claude viu inteira.
function dedupeAcrossChunks(items, chunks) {
  // items: [{box, chunkIndex}]
  const last = chunks.length - 1;
  const scored = items.map(it => {
    const c = chunks[it.chunkIndex];
    const cy = it.box.y + it.box.h / 2;
    const top = it.chunkIndex === 0 ? Infinity : cy - c.y0;
    const bottom = it.chunkIndex === last ? Infinity : c.y0 + c.h - cy;
    return { ...it, edge: Math.min(top, bottom) };
  });
  scored.sort((a, b) => b.edge - a.edge);
  const kept = [];
  for (const it of scored) {
    const dup = kept.some(k => k.chunkIndex !== it.chunkIndex && overlapRatio(k.box, it.box) > 0.4);
    if (!dup) kept.push(it);
  }
  kept.sort((a, b) => (a.box.y - b.box.y) || (a.chunkIndex - b.chunkIndex));
  return kept.map(k => k.box);
}

// Interseção dividida pela área da menor caixa.
function overlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const minArea = Math.min(a.w * a.h, b.w * b.h);
  return minArea > 0 ? inter / minArea : 0;
}

// Caixas em px da região -> frações (0–1) da região, para desenhar por cima
// da imagem em qualquer tamanho de tela.
function toFractions(boxes, regionW, regionH) {
  return boxes.map(b => ({
    x: b.x / regionW,
    y: b.y / regionH,
    w: b.w / regionW,
    h: b.h / regionH,
    text: b.text,
    original: b.original,
    kind: b.kind
  }));
}

// Hash de 64 bits (dois FNV-1a) para chaves de cache.
function hashString(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// Lê o JSON que o Gemini devolve (às vezes vem dentro de ```json ... ```).
function parseJsonLoose(text) {
  if (!text) return null;
  const t = String(text).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
  const c = t.indexOf('['), d = t.lastIndexOf(']');
  if (c >= 0 && d > c) { try { return { bubbles: JSON.parse(t.slice(c, d + 1)) }; } catch (_) {} }
  return null;
}

// O Gemini marca posições como box_2d = [ymin, xmin, ymax, xmax] de 0 a 1000.
// Converte para px da imagem enviada (mesmo formato que o Claude devolve).
function geminiToBubbles(obj, w, h) {
  const list = Array.isArray(obj) ? obj : (obj && (obj.bubbles || obj.items)) || [];
  const out = [];
  for (const b of list) {
    if (!b) continue;
    const box = b.box_2d || b.box || b.bbox;
    if (Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)) {
      let [ymin, xmin, ymax, xmax] = box;
      if (ymax < ymin) [ymin, ymax] = [ymax, ymin];
      if (xmax < xmin) [xmin, xmax] = [xmax, xmin];
      out.push({
        x: xmin / 1000 * w, y: ymin / 1000 * h,
        w: (xmax - xmin) / 1000 * w, h: (ymax - ymin) / 1000 * h,
        original: b.original, translation: b.translation ?? b.text, kind: b.kind
      });
    } else if ([b.x, b.y, b.w, b.h].every(Number.isFinite)) {
      out.push(b);
    }
  }
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { LIMITS: DEFAULT_LIMITS, DEFAULT_LIMITS, GEMINI_LIMITS, OCR_LIMITS, isTexty, groupLines, tidyCaps, findBubbles, bubbleOutsideMask, mergeLines, looksLikeSpeech, plausibleLine, goodGroup, cleanGroups, weirdCase, parseJsonLoose, geminiToBubbles, planChunks, chunkBoxesToRegion, dedupeAcrossChunks, overlapRatio, toFractions, hashString };
}
