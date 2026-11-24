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

// ---------- Idiomas ----------
// code: código BCP 47 usado nas configurações e no tradutor do Chrome
// name: nome em inglês, usado nos prompts das IAs
// tess: dados do leitor de texto (Tesseract); gtx: código do Google Tradutor
// latin: escrita com alfabeto latino (os filtros de lixo do OCR assumem isso)
var LANGS = {
  'auto':    { label: 'Detectar sozinho', name: null, tess: 'eng', gtx: 'auto', latin: true },
  'en':      { label: 'Inglês', name: 'English', tess: 'eng', latin: true },
  'ko':      { label: 'Coreano', name: 'Korean', tess: 'kor' },
  'ja':      { label: 'Japonês', name: 'Japanese', tess: 'jpn' },
  'zh':      { label: 'Chinês simplificado', name: 'Simplified Chinese', tess: 'chi_sim', gtx: 'zh-CN' },
  'zh-Hant': { label: 'Chinês tradicional', name: 'Traditional Chinese', tess: 'chi_tra', gtx: 'zh-TW' },
  'es':      { label: 'Espanhol', name: 'Spanish', tess: 'spa', latin: true },
  'fr':      { label: 'Francês', name: 'French', tess: 'fra', latin: true },
  'de':      { label: 'Alemão', name: 'German', tess: 'deu', latin: true },
  'it':      { label: 'Italiano', name: 'Italian', tess: 'ita', latin: true },
  'pt-BR':   { label: 'Português do Brasil', name: 'Brazilian Portuguese', tess: 'por', mt: 'pt', gtx: 'pt', latin: true },
  'pt-PT':   { label: 'Português de Portugal', name: 'European Portuguese', tess: 'por', mt: 'pt', gtx: 'pt-PT', latin: true },
  'ru':      { label: 'Russo', name: 'Russian', tess: 'rus' },
  'id':      { label: 'Indonésio', name: 'Indonesian', tess: 'ind', latin: true },
  'vi':      { label: 'Vietnamita', name: 'Vietnamese', tess: 'vie', latin: true },
  'th':      { label: 'Tailandês', name: 'Thai', tess: 'tha' }
};
var SOURCE_LANGS = ['en', 'ko', 'ja', 'zh', 'zh-Hant', 'auto', 'es', 'fr', 'de', 'it', 'pt-BR', 'ru', 'id', 'vi', 'th'];
var TARGET_LANGS = ['pt-BR', 'pt-PT', 'en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh', 'zh-Hant', 'ru', 'id', 'vi', 'th'];

function langInfo(code) { return LANGS[code] || LANGS.en; }
function langName(code) { return langInfo(code).name; }                       // null para 'auto'
function langMt(code) { const l = langInfo(code); return l.mt || code; }      // tradutor do Chrome
function langGtx(code) { const l = langInfo(code); return l.gtx || code; }    // Google Tradutor
function langTess(code) { return langInfo(code).tess; }
function isLatin(code) { return !!langInfo(code).latin; }

// Configuração antiga ("traduzir para" era texto livre) -> código.
function migrateTargetLang(old) {
  const t = String(old || '').toLowerCase();
  if (!t || /portugu[eê]s( do)? brasil|brasileiro|pt-br/.test(t)) return 'pt-BR';
  if (/portugal|europeu/.test(t)) return 'pt-PT';
  for (const [code, l] of Object.entries(LANGS)) {
    if (code !== 'auto' && (t === l.label.toLowerCase() || t === String(l.name).toLowerCase() || t === code.toLowerCase())) return code;
  }
  return 'pt-BR';
}

// Linha parece texto de verdade (e não um pedaço do desenho lido errado)?
// latin=false (coreano, japonês, chinês...): basta ter letras da escrita.
function isTexty(t, latin = true) {
  const s = String(t || '').replace(/[\s.,!?…'"“”‘’\-–—。、！？「」『』～]/g, '');
  if (!latin) {
    const letters = (s.match(/\p{L}/gu) || []).length;
    return letters >= 1 && letters / Math.max(1, s.length) >= 0.5;
  }
  const letters = (s.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  return letters >= 2 && letters / Math.max(1, s.length) >= 0.6;
}

// Junta as linhas lidas pelo leitor de texto em balões (linhas próximas,
// uma embaixo da outra e alinhadas, são do mesmo balão).
function groupLines(lines, opts = {}) {
  const latin = opts.latin !== false;
  const L = lines.filter(l => isTexty(l.text, latin) && l.w > 0 && l.h > 0).sort((a, b) => a.y - b.y || a.x - b.x);
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
      const sep = opts.joiner != null ? opts.joiner : ' ';   // japonês e chinês não usam espaço
      text = !text ? t : (/[-‐]$/.test(text) ? text.replace(/[-‐]$/, '') + t : text + sep + t);
    }
    const out = { x: g.x, y: g.y, w: g.w, h: g.h, original: text };
    Object.defineProperty(out, 'lines', { value: g.lines, enumerable: false });
    return out;
  });
}

// Linhas -> balões, já sem o lixo.
// opts: { latin, joiner } — use ocrOptsFor(código do idioma de entrada).
function cleanGroups(lines, minConf = 0, opts = {}) {
  const ok = lines.filter(l => (l.conf == null || l.conf >= minConf) && plausibleLine(l));
  return groupLines(ok, opts).filter(g => goodGroup(g, g.lines, opts));
}

function ocrOptsFor(src) {
  return { latin: isLatin(src), joiner: (src === 'ja' || src === 'zh' || src === 'zh-Hant' || src === 'th') ? '' : ' ' };
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
  const sym = (t.match(/[^\p{L}\p{N}\s.,!?'"“”‘’…\-–—:;()~*。、！？「」『』～・ー]/gu) || []).length;
  return sym / n <= 0.12;
}

// Palavra com mistura estranha de maiúscula/minúscula ("WyZn", "aBc")
function weirdCase(w) {
  return /[a-z][A-Z]/.test(w) || /^[A-Z]{1}[a-z]+[A-Z]/.test(w) || /[A-Z][a-z][A-Z]/.test(w);
}

// O balão montado parece fala de verdade?
function goodGroup(g, lines, opts = {}) {
  const text = String(g.original || '');
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (opts.latin === false) {
    // coreano, japonês, chinês...: as regras de palavra e vogal abaixo são do inglês
    if (letters < 1) return false;
    const sym = (text.match(/[^\p{L}\p{N}\s.,!?…'"“”‘’\-–—:;()~*。、！？「」『』～]/gu) || []).length;
    return sym / Math.max(1, text.replace(/\s/g, '').length) <= 0.2;
  }
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

// Texto todo em maiúsculas (letreiro de quadrinho)? Aí a tradução é desenhada em maiúsculas também.
function isAllCaps(t) {
  const s = String(t || '');
  return /\p{Lu}/u.test(s) && s === s.toUpperCase() && s !== s.toLowerCase();
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

// ---------- Balões recortados: onde está o texto e onde desenhar a tradução ----------

// Dilata uma máscara (1 = fora do balão) em 1 célula, nas 8 direções.
function growMask(mask, w, h) {
  const out = mask.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (mask[y * w + x]) continue;
    for (let dy = -1; dy <= 1 && !out[y * w + x]; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) { out[y * w + x] = 1; break; }
    }
  }
  return out;
}

// Retângulo das linhas/colunas com pelo menos "min" pixels escuros (letras).
// rows/cols: contagem de pixels escuros por linha e por coluna. null = sem texto.
function darkBounds(rows, cols, min = 2) {
  let y0 = -1, y1 = -1, x0 = -1, x1 = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i] >= min) { if (y0 < 0) y0 = i; y1 = i; }
  for (let i = 0; i < cols.length; i++) if (cols[i] >= min) { if (x0 < 0) x0 = i; x1 = i; }
  if (y0 < 0 || x0 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Onde desenhar a tradução: em cima do texto original (não do balão inteiro),
// um pouco mais larga (português costuma ser mais comprido que o original),
// sem sair do miolo do balão. t = área do texto, b = balão. Sem t: miolo do balão.
function placeTranslation(t, b) {
  if (!t || t.w < 4 || t.h < 4) return { x: b.x + b.w * 0.1, y: b.y + b.h * 0.14, w: b.w * 0.8, h: b.h * 0.72 };
  let ix = b.x + b.w * 0.08, iy = b.y + b.h * 0.08;
  let ir = b.x + b.w * 0.92, ib = b.y + b.h * 0.92;
  // o miolo sempre contém o texto todo
  ix = Math.min(ix, t.x); iy = Math.min(iy, t.y);
  ir = Math.max(ir, t.x + t.w); ib = Math.max(ib, t.y + t.h);
  const pad = Math.max(2, Math.min(t.w, t.h) * 0.08);
  // a área medida é só a das letras (sem o espaço da linha): folga para a fonte caber no mesmo tamanho
  const h = Math.min(ib - iy, Math.max(t.h + 2 * pad, t.h * 1.2 + 6));
  const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
  // Como o fundo da caixa tem a cor do balão, alargar não aparece: dá mais espaço
  // para a tradução, até onde o balão (oval) é largo na altura do texto.
  const maxDy = Math.abs(cy - (b.y + b.h / 2)) + h / 2;
  const oval = Math.sqrt(Math.max(0, 1 - Math.pow(2 * maxDy / b.h, 2)));
  const roomy = Math.min(b.w * oval * 0.9, t.w * 1.8);
  const w = Math.min(ir - ix, Math.max(t.w + 2 * pad, t.w * 1.15, roomy));
  const x = Math.max(ix, Math.min(cx - w / 2, ir - w));
  const y = Math.max(iy, Math.min(cy - h / 2, ib - h));
  return { x, y, w, h };
}

// Acha os balões claros da imagem, recorta cada um (o desenho em volta fica
// branco) e ampliado, e mede onde está o texto e a cor do fundo do balão.
// Devolve [{ x, y, w, h, blob, text, bg }] em px do canvas (text = null: balão sem texto).
// maxSide: lado maior do recorte enviado ao modelo (menor = menos tokens de imagem = mais rápido).
async function bubbleCrops(canvas, W, H, max = 10, maxSide = 768) {
  const k = Math.min(1, 240 / W);
  const sw = Math.max(1, Math.round(W * k)), sh = Math.max(1, Math.round(H * k));
  const small = new OffscreenCanvas(sw, sh);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(canvas, 0, 0, sw, sh);
  const px = sctx.getImageData(0, 0, sw, sh).data;
  const gray = new Uint8Array(sw * sh);
  for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) | 0;
  const { boxes, label } = findBubbles(gray, sw, sh, { white: 200, max: 20 });
  const out = [];
  for (const b of boxes) {
    const m = bubbleOutsideMask(label, sw, sh, b);
    // perto da borda do balão: fica o contorno, que não é texto
    const edge = growMask(growMask(m.outside, m.mw, m.mh), m.mw, m.mh);
    const x = Math.floor(m.x0 / k), y = Math.floor(m.y0 / k);
    const w = Math.min(W - x, Math.ceil(m.mw / k)), h = Math.min(H - y, Math.ceil(m.mh / k));
    if (w < 30 || h < 18) continue;
    const up = Math.min(2, maxSide / w, maxSide / h);
    const cw = Math.max(1, Math.round(w * up)), ch = Math.max(1, Math.round(h * up));
    const crop = new OffscreenCanvas(cw, ch);
    const cctx = crop.getContext('2d', { willReadFrequently: true });
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(canvas, x, y, w, h, 0, 0, cw, ch);
    const id = cctx.getImageData(0, 0, cw, ch);
    const d = id.data;
    const rows = new Uint32Array(ch), cols = new Uint32Array(cw);
    let sr = 0, sg = 0, sb = 0, sn = 0;
    for (let cy = 0; cy < ch; cy++) {
      const my = Math.min(m.mh - 1, Math.max(0, Math.floor((y + cy / up) * k) - m.y0));
      for (let cx = 0; cx < cw; cx++) {
        const mx = Math.min(m.mw - 1, Math.max(0, Math.floor((x + cx / up) * k) - m.x0));
        const mi = my * m.mw + mx, i = (cy * cw + cx) * 4;
        if (m.outside[mi]) { d[i] = d[i + 1] = d[i + 2] = 255; continue; }
        if (edge[mi]) continue;
        const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        if (lum < 140) { rows[cy]++; cols[cx]++; }
        else if (lum > 190) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sn++; }
      }
    }
    cctx.putImageData(id, 0, 0);
    // ignora sujeira: linha/coluna precisa de alguns pixels escuros
    const t = darkBounds(rows, cols, Math.max(2, Math.round(up * 1.5)));
    out.push({
      x, y, w, h,
      blob: await crop.convertToBlob({ type: 'image/png' }),
      text: t ? { x: x + t.x / up, y: y + t.y / up, w: t.w / up, h: t.h / up } : null,
      bg: sn ? `rgb(${Math.round(sr / sn)}, ${Math.round(sg / sn)}, ${Math.round(sb / sn)})` : null
    });
  }
  // ordem de leitura: de cima para baixo
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out.slice(0, max);
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
      kind: ['dialogue', 'narration', 'sfx', 'sign'].includes(b.kind) ? b.kind : 'dialogue',
      bg: typeof b.bg === 'string' ? b.bg : undefined,    // cor do balão (desenho justo no texto)
      caps: b.caps ? true : undefined                     // desenhar em maiúsculas, como o original
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
    kind: b.kind,
    bg: b.bg,
    caps: b.caps
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
  module.exports = { isAllCaps, growMask, darkBounds, placeTranslation, LANGS, SOURCE_LANGS, TARGET_LANGS, langInfo, langName, langMt, langGtx, langTess, isLatin, migrateTargetLang, ocrOptsFor, LIMITS: DEFAULT_LIMITS, DEFAULT_LIMITS, GEMINI_LIMITS, OCR_LIMITS, isTexty, groupLines, tidyCaps, findBubbles, bubbleOutsideMask, mergeLines, looksLikeSpeech, plausibleLine, goodGroup, cleanGroups, weirdCase, parseJsonLoose, geminiToBubbles, planChunks, chunkBoxesToRegion, dedupeAcrossChunks, overlapRatio, toFractions, hashString };
}
