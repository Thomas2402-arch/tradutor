(() => {
  if (window.__tradutorManhwa) return;
  window.__tradutorManhwa = true;

  // Tamanho mínimo para uma imagem ser considerada página de manhwa.
  const MIN_NATURAL_W = 300, MIN_NATURAL_H = 200;
  const MIN_SHOWN_W = 220, MIN_SHOWN_H = 150;
  const CONCURRENCY = 2;

  const state = new Map();   // img -> { status, src, group, boxes, fitW }
  const screenGroups = [];   // traduções feitas a partir da captura de tela
  const queue = [];
  const contextLines = [];   // últimas falas traduzidas, para manter nomes e tom
  const pendingReqs = new Map(); // reqId -> { img, st } (para mostrar a tradução em partes)
  let running = 0;
  let autoOn = false;
  let showing = true;
  let io = null, scanTimer = null, observed = new WeakSet();
  let fatalShownAt = 0;
  let provider = 'gemini';
  let hasGemini = false;
  let hasClaude = false;
  const isLocal = p => p === 'google' || p === 'nano' || p === 'local';
  // modo "No seu PC": o llama.cpp lê o texto; quem traduz é escolhido (llama/gemini/claude/google)
  let localTranslator = 'llama';
  const LOCAL_CROP = 512;   // lado maior do recorte mandado ao modelo (menor = mais rápido)
  const cacheKeyFor = (src, mode) => (src && /^https?:/i.test(src)) ? `${mode}|${src}` : null;
  let srcLang = 'en', dstLang = 'pt-BR';   // idiomas de entrada e saída (códigos de LANGS, lib.js)
  chrome.storage.local.get({ provider: 'gemini', geminiKey: '', apiKey: '', srcLang: 'en', dstLang: null, targetLang: '', localTranslator: 'llama' })
    .then(r => {
      localTranslator = r.localTranslator;
      provider = r.provider; hasGemini = !!r.geminiKey; hasClaude = !!r.apiKey;
      srcLang = LANGS[r.srcLang] ? r.srcLang : 'en';
      dstLang = r.dstLang || migrateTargetLang(r.targetLang);
    }).catch(() => {});
  chrome.storage.onChanged.addListener(ch => {
    if (ch.srcLang) { srcLang = ch.srcLang.newValue || 'en'; mtTranslator = null; mtTried = false; }
    if (ch.dstLang) { dstLang = ch.dstLang.newValue || 'pt-BR'; mtTranslator = null; mtTried = false; }
    if (ch.provider) provider = ch.provider.newValue;
    if (ch.localTranslator) localTranslator = ch.localTranslator.newValue || 'llama';
    if (ch.geminiKey) hasGemini = !!ch.geminiKey.newValue;
    if (ch.apiKey) hasClaude = !!ch.apiKey.newValue;
  });

  // ---------- Interface (fica num shadow DOM para o site não bagunçar o estilo) ----------

  const CSS = `
    :host { all: initial; }
    .layer { position: absolute; top: 0; left: 0; }
    .layer.off .box { display: none !important; }
    .group { position: absolute; pointer-events: none; }
    .group.hidden-tr .box { display: none; }
    .box {
      position: absolute; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
      text-align: center; padding: 2px 3px; background: #fff; color: #111;
      border-radius: 14px; font-family: "Comic Neue", "Comic Sans MS", "Segoe UI", Arial, sans-serif;
      font-weight: 700; line-height: 1.12; overflow: hidden; pointer-events: auto; cursor: pointer;
      min-width: 34px; min-height: 16px; box-shadow: 0 0 0 1px rgba(0,0,0,.08);
    }
    .box span { display: block; max-width: 100%; overflow-wrap: break-word; hyphens: auto; white-space: pre-line; }
    .box.narration { background: #fffbe6; border-radius: 4px; font-weight: 600; }
    .box.fit { box-shadow: none; border-radius: 6px; padding: 0 2px; }
    .box.sign { background: #f5f5f5; border-radius: 4px; font-weight: 600; }
    .box.sfx { background: rgba(255,255,255,.82); color: #b00020; font-style: italic; border-radius: 8px; }
    .box.grow { overflow: visible; z-index: 1; }
    .box.peek { opacity: .04; }
    .badge {
      position: absolute; left: 8px; top: 8px; background: #1d4ed8; color: #fff;
      font: 600 12px/1.3 system-ui, "Segoe UI", sans-serif; padding: 5px 10px; border-radius: 999px;
      pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,.3); max-width: 80%; white-space: normal;
    }
    .badge.err { background: #b91c1c; pointer-events: auto; cursor: pointer; }
    .badge.soft { background: rgba(17,17,17,.6); font-weight: 500; }
    .cmp { position: fixed; top: 16px; right: 16px; width: 440px; max-height: calc(100vh - 32px); overflow: auto;
      background: #fff; color: #111; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.45); pointer-events: auto;
      font: 14px/1.4 system-ui, "Segoe UI", sans-serif; display: none; }
    .cmp header { position: sticky; top: 0; background: #111; color: #fff; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; font-weight: 700; }
    .cmp header button { background: transparent; color: #fff; border: 0; font-size: 18px; cursor: pointer; }
    .cmp section { padding: 10px 14px; border-bottom: 1px solid #e4e4e7; }
    .cmp h3 { margin: 0 0 6px; font-size: 14px; }
    .cmp h3 small { font-weight: 500; color: #666; }
    .cmp ol { margin: 0; padding-left: 20px; }
    .cmp li { margin: 4px 0; }
    .cmp .orig { display: block; color: #777; font-size: 12px; }
    .cmp .wait { color: #666; font-style: italic; }
    .cmp.wide { width: min(600px, calc(100vw - 32px)); }
    .cmp .sum div { margin: 2px 0; }
    .cmp .sum small { color: #666; }
    .cmp .bub img { display: block; max-width: 100%; max-height: 140px; margin: 0 auto 6px; border: 1px solid #e4e4e7; border-radius: 6px; }
    .cmp .bub ol { list-style: none; padding: 0; }
    .cmp .bub .tr { display: block; color: #1d4ed8; font-size: 13px; }
    .hoverbtn {
      position: fixed; display: none; pointer-events: auto; background: #111; color: #fff; border: 0;
      border-radius: 999px; padding: 7px 13px; font: 600 13px/1 system-ui, "Segoe UI", sans-serif;
      cursor: pointer; opacity: .9; box-shadow: 0 2px 10px rgba(0,0,0,.35);
    }
    .hoverbtn:hover { opacity: 1; }
    .hoverbtn.refine { background: #6d28d9; }
    .hoverbtn:disabled { cursor: default; opacity: .7; }
    .toasts {
      position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
      display: flex; flex-direction: column; gap: 8px; align-items: center;
    }
    .toast {
      pointer-events: auto; background: #111; color: #fff; font: 500 14px/1.4 system-ui, "Segoe UI", sans-serif;
      padding: 10px 14px; border-radius: 10px; max-width: 440px; box-shadow: 0 4px 16px rgba(0,0,0,.4);
      display: flex; gap: 12px; align-items: center;
    }
    .toast button {
      background: #fff; color: #111; border: 0; border-radius: 6px; padding: 6px 10px;
      font: 600 13px system-ui, sans-serif; cursor: pointer; white-space: nowrap;
    }
  `;

  const host = document.createElement('div');
  host.setAttribute('data-tradutor-manhwa', '');
  host.style.cssText = 'position:absolute!important;top:0!important;left:0!important;width:0!important;height:0!important;' +
    'margin:0!important;padding:0!important;border:0!important;z-index:2147483647!important;pointer-events:none!important;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${CSS}</style><div class="layer"></div><button class="hoverbtn" type="button"></button><button class="hoverbtn refine" type="button">✨ Refazer com Gemini</button><div class="toasts"></div><div class="cmp"></div>`;
  const layer = root.querySelector('.layer');
  const hoverBtn = root.querySelector('.hoverbtn:not(.refine)');
  const refineBtn = root.querySelector('.hoverbtn.refine');
  const toasts = root.querySelector('.toasts');
  const cmpPanel = root.querySelector('.cmp');

  function attachHost() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  // Liga/desliga geral (botão na janelinha da extensão). Desligado = não faz nada no site.
  let enabled = false;

  function toast(text, ms = 4500, action) {
    attachHost();
    const t = document.createElement('div');
    t.className = 'toast';
    const span = document.createElement('span');
    span.textContent = text;
    t.appendChild(span);
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.addEventListener('click', e => { e.stopPropagation(); action.fn(); t.remove(); });
      t.appendChild(b);
    }
    toasts.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ---------- Comunicação com o background ----------

  async function send(msg) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      return r || { ok: false, error: 'Sem resposta da extensão.' };
    } catch (_) {
      return { ok: false, code: 'CONTEXT', fatal: true, error: 'A extensão foi atualizada. Recarregue a página (F5).' };
    }
  }

  function handleError(res) {
    if (!res || !res.fatal) return;
    for (const img of queue.splice(0)) {
      const st = state.get(img);
      if (st) { st.status = 'idle'; setBadge(st.group, ''); }
    }
    if (autoOn) stopAuto();
    if (Date.now() - fatalShownAt > 8000) {
      fatalShownAt = Date.now();
      const needsOptions = ['NO_KEY', 'AUTH', 'MODEL', 'NO_NANO', 'NO_HOST', 'NOT_INSTALLED', 'NO_VCRUNTIME', 'START_FAILED', 'VULKAN_OLD', 'LOCAL_TIMEOUT', 'LOCAL_OFF'].includes(res.code);
      const action = (needsOptions || res.code === 'NO_OCR') ? { label: 'Abrir configurações', fn: () => send({ type: 'openOptions' }) } : null;
      toast('⚠ ' + res.error, res.code === 'NO_OCR' ? 30000 : 12000, action);
    }
  }

  // ---------- Desenho das traduções ----------

  function newGroup() {
    const g = document.createElement('div');
    g.className = 'group';
    layer.appendChild(g);
    return g;
  }

  function place(g, left, top, w, h) {
    g.style.left = left + 'px';
    g.style.top = top + 'px';
    g.style.width = w + 'px';
    g.style.height = h + 'px';
  }

  function setBadge(g, text, opts = {}) {
    if (!g) return;
    let b = g.querySelector('.badge');
    if (!text) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('div'); b.className = 'badge'; g.appendChild(b); }
    b.textContent = text;
    b.classList.toggle('err', !!opts.error);
    b.classList.toggle('soft', /^(🔎|✨)/.test(text));
    b.onclick = opts.onClick ? (e => { e.stopPropagation(); e.preventDefault(); opts.onClick(); }) : null;
  }

  function positionBadge(g, top, height) {
    const b = g.querySelector('.badge');
    if (!b) return;
    const t = Math.min(Math.max(8, -top + 8), Math.max(8, height - 40));
    b.style.top = t + 'px';
  }

  function renderBoxes(g, boxes) {
    g.querySelectorAll('.box').forEach(e => e.remove());
    for (const b of boxes) {
      // aumenta um pouco a caixa para cobrir bem o texto original
      const px = b.w * 0.05, py = b.h * 0.05;
      const x = Math.max(0, b.x - px), y = Math.max(0, b.y - py);
      const w = Math.min(1 - x, b.w + 2 * px), h = Math.min(1 - y, b.h + 2 * py);
      const el = document.createElement('div');
      el.className = 'box ' + (b.kind || 'dialogue') + (b.bg ? ' fit' : '');
      if (b.bg) el.style.background = b.bg;
      if (b.caps) el.style.textTransform = 'uppercase';
      el.style.left = x * 100 + '%';
      el.style.top = y * 100 + '%';
      el.style.width = w * 100 + '%';
      el.style.height = h * 100 + '%';
      el.dataset.h = h * 100 + '%';
      const span = document.createElement('span');
      span.lang = dstLang;
      span.textContent = b.text;
      el.appendChild(span);
      el.title = (b.original ? 'Original: ' + b.original + '\n' : '') + '(clique para ver o original)';
      el.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); el.classList.toggle('peek'); });
      g.appendChild(el);
    }
  }

  // Ajusta o tamanho da letra para caber no balão.
  function fitBox(el) {
    const span = el.firstChild;
    if (!span) return;
    el.classList.remove('grow');
    el.style.height = el.dataset.h;
    el.style.minHeight = '';
    const H = el.clientHeight - 4;
    const W = el.clientWidth - 6;
    if (H <= 0 || W <= 0) return;
    const fits = () => span.offsetHeight <= H && span.scrollWidth <= span.clientWidth + 1;
    let lo = 7, hi = Math.max(8, Math.min(30, H)), best = lo;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      span.style.fontSize = mid + 'px';
      if (fits()) { best = mid; lo = mid; } else { hi = mid; }
    }
    span.style.fontSize = best + 'px';
    if (!fits()) {
      el.classList.add('grow');
      el.style.minHeight = el.dataset.h;
      el.style.height = 'auto';
    }
  }

  function fitGroup(g) {
    g.querySelectorAll('.box').forEach(fitBox);
  }

  let layoutPending = false;
  function scheduleLayout() {
    if (layoutPending) return;
    layoutPending = true;
    requestAnimationFrame(() => { layoutPending = false; layout(); });
  }

  function layout() {
    attachHost();
    const vh = innerHeight;
    for (const [img, st] of state) {
      const g = st.group;
      if (!g) continue;
      if (!img.isConnected) { g.remove(); state.delete(img); continue; }
      const r = img.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { g.style.display = 'none'; continue; }
      g.style.display = '';
      place(g, r.left + scrollX, r.top + scrollY, r.width, r.height);
      positionBadge(g, r.top, r.height);
      const near = r.bottom > -vh && r.top < 2 * vh;
      const w = Math.round(r.width);
      if (near && st.boxes && st.fitW !== w) { st.fitW = w; fitGroup(g); }
    }
    for (const sg of screenGroups) {
      const top = sg.rect.top - scrollY;
      positionBadge(sg.group, top, sg.rect.h);
      const near = top + sg.rect.h > -vh && top < 2 * vh;
      if (near && sg.boxes && !sg.fitted) { sg.fitted = true; fitGroup(sg.group); }
    }
    if (hoverImg && hoverBtn.style.display === 'block') showHoverBtn();
  }

  addEventListener('scroll', scheduleLayout, { capture: true, passive: true });
  addEventListener('resize', scheduleLayout, { passive: true });
  setInterval(() => { if (state.size || screenGroups.length) scheduleLayout(); }, 800);

  // ---------- Imagens ----------

  function currentSrc(img) {
    return img.currentSrc || img.src || '';
  }

  function isCandidate(img, allowUnloaded = false) {
    if (!(img instanceof HTMLImageElement) || !img.isConnected) return false;
    const src = currentSrc(img);
    if (!src) return false;
    const r = img.getBoundingClientRect();
    if (r.width < MIN_SHOWN_W) return false;
    if (img.complete && img.naturalWidth) {
      return img.naturalWidth >= MIN_NATURAL_W && img.naturalHeight >= MIN_NATURAL_H && r.height >= MIN_SHOWN_H;
    }
    // ainda não carregou (carregamento preguiçoso do site): serve se for um endereço de imagem de verdade
    return allowUnloaded && /^https?:/i.test(src) && !/^data:/i.test(src);
  }

  function getState(img) {
    let st = state.get(img);
    if (!st) { st = { status: 'idle' }; state.set(img, st); }
    return st;
  }

  function resetImg(img) {
    const st = state.get(img);
    if (st && st.group) st.group.remove();
    state.delete(img);
    const i = queue.indexOf(img);
    if (i >= 0) queue.splice(i, 1);
  }

  function imgToDataUrl(img) {
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h || w * h > 60e6) return null;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/jpeg', 0.92);
    } catch (_) {
      return null; // o site não deixa ler a imagem
    }
  }

  function pushContext(boxes) {
    for (const b of boxes) if (b.kind !== 'sfx') contextLines.push(b.text);
    while (contextLines.length > 30) contextLines.shift();
  }

  function errorText(res) {
    if (res && res.code === 'FETCH_FAILED') return 'Esse site bloqueia a imagem. Use Alt+T para traduzir a tela.';
    return (res && res.error) || 'Erro desconhecido.';
  }

  async function translateImg(img) {
    const st = getState(img);
    if (st.status === 'working' || st.status === 'done') return;
    const src = currentSrc(img);
    if (!src) return;
    st.status = 'working';
    st.src = src;
    if (!st.group) st.group = newGroup();
    setBadge(st.group, '🇧🇷 Traduzindo…');
    scheduleLayout();

    const reqId = Math.random().toString(36).slice(2);
    pendingReqs.set(reqId, { img, st });
    let res = isLocal(provider)
      ? await localTranslate({ src, pageUrl: location.href }, (boxes, done, total) => onPartialBoxes({ reqId, boxes, done, total }))
      : await send({ type: 'translateImage', reqId, src, pageUrl: location.href, context: contextLines.slice(-15) });
    pendingReqs.delete(reqId);
    if (res && !res.ok && res.code === 'FETCH_FAILED' && isLocal(provider)) {
      const dataUrl = imgToDataUrl(img);
      if (dataUrl) res = await localTranslate({ dataUrl }, null);
    } else if (res && !res.ok && res.code === 'FETCH_FAILED') {
      const dataUrl = imgToDataUrl(img);
      if (dataUrl) res = await send({ type: 'translateImage', dataUrl, pageUrl: location.href, context: contextLines.slice(-15) });
    }
    if (state.get(img) !== st) return; // a imagem foi trocada no meio do caminho

    if (!res.ok) {
      st.status = 'error';
      setBadge(st.group, '⚠ ' + errorText(res) + ' (clique para tentar de novo)', {
        error: true,
        onClick: () => { setBadge(st.group, ''); st.status = 'idle'; translateImg(img); }
      });
      handleError(res);
      return;
    }

    st.status = 'done';
    st.boxes = res.boxes;
    st.revised = res.revised !== false; // só o modo Google tem revisão
    st.fitW = null;
    renderBoxes(st.group, res.boxes);
    if (res.boxes.length) {
      setBadge(st.group, '');
    } else {
      setBadge(st.group, 'Sem texto para traduzir');
      setTimeout(() => { if (state.get(img) === st) setBadge(st.group, ''); }, 1500);
    }
    pushContext(res.boxes);
    scheduleLayout();
  }

  function onPartialBoxes(msg) {
    const p = pendingReqs.get(msg.reqId);
    if (!p || state.get(p.img) !== p.st || p.st.status !== 'working') return;
    p.st.boxes = msg.boxes;
    p.st.fitW = null;
    renderBoxes(p.st.group, msg.boxes);
    setBadge(p.st.group, `🇧🇷 Traduzindo… (${msg.done} de ${msg.total})`);
    scheduleLayout();
  }

  // ---------- Modo Google: leitor de texto do Chrome + Google Tradutor ----------

  let mtTranslator = null, mtTried = false;

  // Tradutor do Google embutido no Chrome (roda no PC, grátis, sem limite).
  // Na primeira vez ele precisa baixar o idioma, e isso só pode começar depois de um clique.
  function prepareTranslator() {
    // "detectar sozinho": o tradutor do Chrome precisa saber o idioma; usa o Google pela internet
    if (mtTranslator || mtTried || !('Translator' in self) || srcLang === 'auto') return;
    mtTried = true;
    const pair = { sourceLanguage: langMt(srcLang), targetLanguage: langMt(dstLang) };
    Translator.availability(pair).then(a => {
      if (a === 'unavailable') return;
      if (a !== 'available') toast('Baixando o tradutor do Google para o seu PC (só na primeira vez)…', 6000);
      return Translator.create(pair).then(t => { mtTranslator = t; });
    }).catch(() => { mtTried = false; });
  }

  async function machineTranslate(texts) {
    if (!texts.length) return [];
    if (mtTranslator) {
      try { return await Promise.all(texts.map(t => mtTranslator.translate(t))); } catch (_) { mtTranslator = null; }
    }
    const r = await send({ type: 'googleTranslate', texts });
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
    return r.texts;
  }

  function base64ToBlob(dataUrl) {
    const i = dataUrl.indexOf(',');
    const mime = (dataUrl.slice(5, i).split(';')[0]) || 'image/jpeg';
    const bin = atob(dataUrl.slice(i + 1));
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    return new Blob([bytes], { type: mime });
  }

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
  }

  // Lê o texto de uma fatia: cada balão branco recortado separado (o leitor
  // erra menos assim) + a fatia inteira (pega texto fora de balão).
  async function ocrChunk(canvas, W, H) {
    const k = Math.min(1, 240 / W);
    const sw = Math.max(1, Math.round(W * k)), sh = Math.max(1, Math.round(H * k));
    const small = new OffscreenCanvas(sw, sh);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(canvas, 0, 0, sw, sh);
    const px = sctx.getImageData(0, 0, sw, sh).data;
    const gray = new Uint8Array(sw * sh);
    for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) | 0;
    const { boxes: bubbles, label } = findBubbles(gray, sw, sh);

    const fromCrops = [];
    for (const b of bubbles) {
      const m = bubbleOutsideMask(label, sw, sh, b);
      const x = Math.floor(m.x0 / k), y = Math.floor(m.y0 / k);
      const w = Math.min(W - x, Math.ceil(m.mw / k)), h = Math.min(H - y, Math.ceil(m.mh / k));
      if (w < 30 || h < 16) continue;
      const crop = new OffscreenCanvas(w, h);
      const cctx = crop.getContext('2d', { willReadFrequently: true });
      cctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      // apaga (deixa branco) tudo que está fora do balão
      const id = cctx.getImageData(0, 0, w, h);
      const d = id.data;
      for (let cy = 0; cy < h; cy++) {
        const my = Math.min(m.mh - 1, Math.max(0, Math.floor((y + cy) * k) - m.y0));
        for (let cx = 0; cx < w; cx++) {
          const mx = Math.min(m.mw - 1, Math.max(0, Math.floor((x + cx) * k) - m.x0));
          if (m.outside[my * m.mw + mx]) { const i = (cy * w + cx) * 4; d[i] = d[i + 1] = d[i + 2] = 255; }
        }
      }
      cctx.putImageData(id, 0, 0);
      const r = await send({ type: 'ocr', image: await blobToDataUrl(await crop.convertToBlob({ type: 'image/png' })) });
      if (!r.ok) return r;
      for (const l of r.lines) fromCrops.push({ ...l, x: l.x + x, y: l.y + y });
    }
    const whole = await send({ type: 'ocr', image: await blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })) });
    if (!whole.ok) return whole;
    return mergeLines(fromCrops, whole.lines);
  }

  // Gemini Nano: acha os balões, recorta cada um e a IA do Chrome "olha" e lê o texto.
  // Texto fora de balão: usa o leitor de texto (se estiver instalado).
  async function nanoChunk(canvas, W, H) {
    const out = [];
    for (const c of await bubbleCrops(canvas, W, H, 20)) {
      if (!c.text) continue;   // balão claro sem nenhuma letra
      const r = await send({ type: 'nanoRead', image: await blobToDataUrl(c.blob) });
      if (!r.ok) return r;
      const text = String(r.text || '').replace(/^["“'`]+|["”'`]+$/g, '').replace(/\s+/g, ' ').trim();
      if (!text || /^none\b/i.test(text) || (isLatin(srcLang) && !looksLikeSpeech(text))) continue;
      // a tradução vai só em cima do texto original, com a cor do balão
      out.push({ ...placeTranslation(c.text, c), original: text, bg: c.bg || undefined, caps: isAllCaps(text) });
    }

    // texto fora de balão (narração, placas): leitor de texto, se instalado
    const st = await send({ type: 'ocrStatus' });
    if (st.ok && st.installed) {
      const whole = await send({ type: 'ocr', image: await blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })) });
      if (whole.ok) {
        for (const g of cleanGroups(whole.lines, 65, ocrOptsFor(srcLang))) {
          if (!out.some(o => overlapRatio(o, g) > 0.2)) out.push(g);
        }
      }
    }
    return out;
  }

  // Modo "No seu PC": acha os balões, recorta cada um e o llama.cpp lê o texto.
  // A tradução é feita depois, para a fatia inteira.
  async function localChunk(canvas, W, H) {
    const crops = await bubbleCrops(canvas, W, H, 25, LOCAL_CROP);
    const latin = isLatin(srcLang);
    const out = [];
    for (const c of crops) {
      if (!c.text) continue;   // balão claro sem nenhuma letra: não gasta uma leitura do modelo
      const r = await send({ type: 'ocrCrop', engine: 'llama', image: await blobToDataUrl(c.blob) });
      if (!r.ok) return r;
      const text = String(r.text || '').replace(/\s+/g, ' ').trim();
      if (!text || !isTexty(text, latin) || (latin && !looksLikeSpeech(text))) continue;
      // a tradução vai só em cima do texto original, com a cor do balão
      out.push({ ...placeTranslation(c.text, c), original: text, bg: c.bg || undefined, caps: isAllCaps(text) });
    }
    return out;
  }

  // Tradução das falas lidas: Google no próprio Chrome, ou o background
  // (llama.cpp no PC, Gemini ou Claude), que também usa a memória da série.
  async function translateLines(texts, m, pageUrl) {
    if (!texts.length) return [];
    if (m !== 'local' || localTranslator === 'google') return machineTranslate(texts.map(tidyCaps));
    const r = await send({ type: 'translateTexts', texts: texts.map(tidyCaps), translator: localTranslator, pageUrl: pageUrl || location.href, context: contextLines.slice(-15) });
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code, fatal: r.fatal });
    return r.texts;
  }

  async function localTranslate({ src, dataUrl, pageUrl, crop, mode }, onPartial) {
    const m = mode || provider;
    try {
      const key = cacheKeyFor(src, m === 'local' ? `local2:${localTranslator}` : m   /* local2: tradução melhorada, não reaproveita o cache antigo */);
      if (key) {
        const c = await send({ type: 'cacheGet', key });
        if (c.ok && c.boxes) return { ok: true, boxes: c.boxes, cached: true, revised: c.revised };
      }
      if (m === 'local') {
        // liga os servidores que faltam (o modelo leva alguns segundos para carregar)
        const r = await send({ type: 'localEnsure', engines: ['llama'] });
        if (!r.ok) return r;
      }
      if (!dataUrl) {
        const r = await send({ type: 'fetchImageData', src, pageUrl: pageUrl || location.href });
        if (!r.ok) return r;
        dataUrl = r.dataUrl;
      }
      const bmp = await createImageBitmap(base64ToBlob(dataUrl));
      let region = { x: 0, y: 0, w: bmp.width, h: bmp.height };
      if (crop) {
        const f = bmp.width / crop.viewW;
        const x = Math.max(0, Math.round(crop.x * f)), y = Math.max(0, Math.round(crop.y * f));
        region = { x, y, w: Math.max(1, Math.min(bmp.width - x, Math.round(crop.w * f))), h: Math.max(1, Math.min(bmp.height - y, Math.round(crop.h * f))) };
      }
      const chunks = planChunks(region.w, region.h, OCR_LIMITS);
      const items = [];
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        const outW = Math.max(1, Math.round(region.w * ch.scale));
        const outH = Math.max(1, Math.round(ch.h * ch.scale));
        const canvas = new OffscreenCanvas(outW, outH);
        const c2d = canvas.getContext('2d');
        c2d.fillStyle = '#fff';
        c2d.fillRect(0, 0, outW, outH);
        c2d.drawImage(bmp, region.x, region.y + ch.y0, region.w, ch.h, 0, 0, outW, outH);
        let groups;
        if (m === 'nano') {
          groups = await nanoChunk(canvas, outW, outH);
          if (!Array.isArray(groups)) { bmp.close(); return groups; } // erro
        } else if (m === 'local') {
          groups = await localChunk(canvas, outW, outH);
          if (!Array.isArray(groups)) { bmp.close(); return groups; } // erro
        } else {
          const lines = await ocrChunk(canvas, outW, outH);
          if (!Array.isArray(lines)) { bmp.close(); return lines; } // erro
          groups = cleanGroups(lines, 50, ocrOptsFor(srcLang));
        }
        const trs = await translateLines(groups.map(g => g.original), m, pageUrl);
        const bubbles = groups.map((g, k) => ({ x: g.x, y: g.y, w: g.w, h: g.h, original: g.original, translation: trs[k], kind: 'dialogue', bg: g.bg, caps: g.caps }));
        for (const box of chunkBoxesToRegion(bubbles, ch, outW, outH)) items.push({ box, chunkIndex: i });
        if (onPartial && chunks.length > 1 && i < chunks.length - 1) {
          onPartial(toFractions(dedupeAcrossChunks(items, chunks.slice(0, i + 1)), region.w, region.h), i + 1, chunks.length);
        }
      }
      bmp.close();
      const merged = chunks.length > 1 ? dedupeAcrossChunks(items, chunks) : items.map(it => it.box);
      const boxes = toFractions(merged, region.w, region.h);
      if (key) await send({ type: 'cachePut', key, boxes, revised: false });
      return { ok: true, boxes, revised: false };
    } catch (e) {
      const name = { nano: 'Gemini Nano', local: 'No seu PC' }[m] || 'Google';
      return { ok: false, code: e.code || 'LOCAL', fatal: !!e.fatal, error: `O modo ${name} falhou nesta página: ` + (e.message || e) };
    }
  }

  // ---------- Fila (traduz primeiro o que está perto da tela) ----------

  function enqueue(img) {
    const st = getState(img);
    if (st.status !== 'idle') return;
    st.status = 'queued';
    if (!st.group) st.group = newGroup();
    setBadge(st.group, 'Na fila…');
    queue.push(img);
    scheduleLayout();
    pump();
  }

  function priority(img, ref) {
    const top = img.getBoundingClientRect().top + scrollY;
    return top >= ref ? top : 1e9 - top;
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const ref = scrollY - 300;
      queue.sort((a, b) => priority(a, ref) - priority(b, ref));
      const img = queue.shift();
      const st = state.get(img);
      if (!st || st.status !== 'queued') continue;
      st.status = 'idle';
      running++;
      translateImg(img).catch(e => console.warn('[Tradutor de Manhwa]', e)).finally(() => {
        running--;
        pump();
        if (!queue.length && running === 0) afterFirstPass();
      });
    }
  }

  // ---------- Revisão (modo Google): procura com calma os balões que faltaram ----------

  let revising = false;

  async function afterFirstPass() {
    if (revising) return; // a revisão em andamento chama o próximo passo quando terminar
    if (provider === 'google') {
      const { reviewPass } = await chrome.storage.local.get({ reviewPass: true });
      if (reviewPass) await runRevision();
    }
    maybePrefetchNext();
  }

  async function runRevision() {
    if (revising || !autoOn) return;
    revising = true;
    try {
      for (;;) {
        if (!autoOn || queue.length || provider !== 'google') break;
        // próxima página a revisar: a mais perto de onde você está lendo (para baixo primeiro)
        const ref = scrollY - 300;
        const todo = [...state.entries()]
          .filter(([img, st]) => st.status === 'done' && !st.revised && img.isConnected)
          .sort((a, b) => priority(a[0], ref) - priority(b[0], ref));
        if (!todo.length) break;
        await reviseImg(todo[0][0], todo[0][1]);
      }
    } finally {
      revising = false;
    }
  }

  // Leitura caprichada: imagem ampliada, balões cinza-claros, áreas brancas grandes
  // e texto claro em fundo escuro.
  async function ocrChunkDeep(canvas, W, H) {
    const k = Math.min(1, 240 / W);
    const sw = Math.max(1, Math.round(W * k)), sh = Math.max(1, Math.round(H * k));
    const small = new OffscreenCanvas(sw, sh);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(canvas, 0, 0, sw, sh);
    const px = sctx.getImageData(0, 0, sw, sh).data;
    const gray = new Uint8Array(sw * sh);
    for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) | 0;
    const { boxes: blobs, label } = findBubbles(gray, sw, sh, { white: 205, allowBig: true, max: 25 });

    const crops = [];
    for (const b of blobs) {
      const m = bubbleOutsideMask(label, sw, sh, b);
      const x = Math.floor(m.x0 / k), y = Math.floor(m.y0 / k);
      const w = Math.min(W - x, Math.ceil(m.mw / k)), h = Math.min(H - y, Math.ceil(m.mh / k));
      if (w < 24 || h < 14) continue;
      const up = Math.min(2, 1600 / w, 1600 / h);
      const cw = Math.round(w * up), ch = Math.round(h * up);
      const crop = new OffscreenCanvas(cw, ch);
      const cctx = crop.getContext('2d', { willReadFrequently: true });
      cctx.imageSmoothingQuality = 'high';
      cctx.drawImage(canvas, x, y, w, h, 0, 0, cw, ch);
      const id = cctx.getImageData(0, 0, cw, ch);
      const d = id.data;
      for (let cy = 0; cy < ch; cy++) {
        const my = Math.min(m.mh - 1, Math.max(0, Math.floor((y + cy / up) * k) - m.y0));
        for (let cx = 0; cx < cw; cx++) {
          const mx = Math.min(m.mw - 1, Math.max(0, Math.floor((x + cx / up) * k) - m.x0));
          if (m.outside[my * m.mw + mx]) { const i = (cy * cw + cx) * 4; d[i] = d[i + 1] = d[i + 2] = 255; }
        }
      }
      cctx.putImageData(id, 0, 0);
      const r = await send({ type: 'ocr', mode: 'block', image: await blobToDataUrl(await crop.convertToBlob({ type: 'image/png' })) });
      if (!r.ok) return r;
      for (const l of r.lines) crops.push({ ...l, x: x + l.x / up, y: y + l.y / up, w: l.w / up, h: l.h / up });
    }

    const up = Math.min(1.6, 1400 / W, 3200 / H);
    const bw = Math.round(W * up), bh = Math.round(H * up);
    const passes = [];
    for (const invert of [false, true]) {
      const big = new OffscreenCanvas(bw, bh);
      const bctx = big.getContext('2d');
      bctx.imageSmoothingQuality = 'high';
      if (invert) bctx.filter = 'invert(1) grayscale(1)';
      bctx.drawImage(canvas, 0, 0, bw, bh);
      const r = await send({ type: 'ocr', mode: 'sparse', image: await blobToDataUrl(await big.convertToBlob({ type: 'image/png' })) });
      if (!r.ok) return r;
      for (const l of r.lines) if ((l.conf || 0) >= 65) passes.push({ ...l, x: l.x / up, y: l.y / up, w: l.w / up, h: l.h / up });
    }
    return mergeLines(crops, passes);
  }

  async function reviseImg(img, st) {
    const src = st.src;
    if (!/^https?:/i.test(src || '')) { st.revised = true; return; }
    setBadge(st.group, '🔎 Revisando…');
    positionBadgeSoon();
    try {
      const r = await send({ type: 'fetchImageData', src, pageUrl: location.href });
      if (!r.ok) { st.revised = true; return; }
      const bmp = await createImageBitmap(base64ToBlob(r.dataUrl));
      const region = { x: 0, y: 0, w: bmp.width, h: bmp.height };
      const chunks = planChunks(region.w, region.h, OCR_LIMITS);
      const existing = (st.boxes || []).map(b => ({ x: b.x * region.w, y: b.y * region.h, w: b.w * region.w, h: b.h * region.h }));
      const items = [];
      for (let i = 0; i < chunks.length; i++) {
        if (state.get(img) !== st) { bmp.close(); return; }
        const ch = chunks[i];
        const outW = Math.max(1, Math.round(region.w * ch.scale));
        const outH = Math.max(1, Math.round(ch.h * ch.scale));
        const canvas = new OffscreenCanvas(outW, outH);
        const c2d = canvas.getContext('2d');
        c2d.fillStyle = '#fff';
        c2d.fillRect(0, 0, outW, outH);
        c2d.drawImage(bmp, 0, ch.y0, region.w, ch.h, 0, 0, outW, outH);
        const lines = await ocrChunkDeep(canvas, outW, outH);
        if (!Array.isArray(lines)) { bmp.close(); st.revised = true; return; }
        const groups = cleanGroups(lines, 70, ocrOptsFor(srcLang));
        const asBoxes = chunkBoxesToRegion(groups.map(g => ({ ...g, translation: g.original, kind: 'dialogue' })), ch, outW, outH);
        for (const box of asBoxes) {
          if (existing.some(e => overlapRatio(e, box) > 0.15)) continue;          // esse balão já estava traduzido
          if (items.some(it => overlapRatio(it.box, box) > 0.15)) continue;      // nada de balão em cima de balão
          items.push({ box, chunkIndex: i });
        }
      }
      bmp.close();
      const found = chunks.length > 1 ? dedupeAcrossChunks(items, chunks) : items.map(it => it.box);
      if (found.length) {
        const trs = await machineTranslate(found.map(b => tidyCaps(b.original)));
        found.forEach((b, i) => { b.text = trs[i]; });
        const added = toFractions(found.filter(b => b.text), region.w, region.h);
        if (state.get(img) !== st) return;
        st.boxes = [...(st.boxes || []), ...added];
        st.fitW = null;
        renderBoxes(st.group, st.boxes);
        pushContext(added);
        scheduleLayout();
      }
      st.revised = true;
      await send({ type: 'cachePut', key: cacheKeyFor(src, 'google'), boxes: st.boxes, revised: true });
      setBadge(st.group, found.length ? `✨ +${found.length} ${found.length === 1 ? 'balão' : 'balões'} na revisão` : '');
      if (found.length) setTimeout(() => { if (state.get(img) === st && st.status === 'done') setBadge(st.group, ''); }, 2500);
    } catch (e) {
      console.warn('[Tradutor de Manhwa] revisão', e);
      st.revised = true;
      setBadge(st.group, '');
    }
  }

  function positionBadgeSoon() { scheduleLayout(); }

  // ---------- Próximo capítulo (já deixa traduzido enquanto você lê) ----------

  let prefetchStarted = false;

  const CHAPTER_RE = /^(.*?(?:chapter|capitulo|cap|ch|episode|ep)[-_.]?)(\d+(?:\.\d+)?)\/?$/i;

  function findNextChapterUrl() {
    const here = location.href.split('#')[0];
    const anchors = [...document.querySelectorAll('a[href]')];
    const m = location.pathname.match(CHAPTER_RE);
    if (m) {
      const n = parseFloat(m[2]);
      let best = null;
      for (const a of anchors) {
        let u;
        try { u = new URL(a.href, location.href); } catch (_) { continue; }
        if (u.origin !== location.origin) continue;
        const mm = u.pathname.match(CHAPTER_RE);
        if (!mm || mm[1].toLowerCase() !== m[1].toLowerCase()) continue;
        const k = parseFloat(mm[2]);
        if (k > n && (!best || k < best.k)) best = { k, url: u.href.split('#')[0] };
      }
      if (best) return best.url;
    }
    const a = anchors.find(x => x.rel === 'next' || /^(next|próximo|proximo|seguinte)\b/i.test((x.innerText || '').trim()));
    return a && a.href.split('#')[0] !== here ? a.href : null;
  }

  function dirOf(u) { return u.slice(0, u.lastIndexOf('/')); }

  async function maybePrefetchNext() {
    if (prefetchStarted || !autoOn) return;
    const sts = [...state.values()];
    if (!sts.length || sts.some(st => st.status === 'queued' || st.status === 'working')) return;
    prefetchStarted = true;
    const { prefetchNext } = await chrome.storage.local.get({ prefetchNext: true });
    if (!prefetchNext) return;

    const next = findNextChapterUrl();
    const cur = sts.map(st => st.src).filter(u => /^https?:/i.test(u || ''));
    if (!next || !cur.length) return;

    // pasta onde ficam as páginas deste capítulo, e a "pasta da obra" acima dela
    const counts = new Map();
    for (const u of cur) counts.set(dirOf(u), (counts.get(dirOf(u)) || 0) + 1);
    const curDir = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const prefix = curDir.slice(0, curDir.lastIndexOf('/') + 1);

    let html;
    try { html = await (await fetch(next, { credentials: 'include' })).text(); } catch (_) { return; }
    html = html.replace(/\\\//g, '/').replace(/&amp;/g, '&');
    // procura os endereços das páginas (completos ou começando com /) dentro do HTML
    const pre = new URL(prefix);
    const esc = pre.pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:https?:)?(?://[^/"\'\\s<>]+)?' + esc + '[^"\'\\s)<>\\\\]+?\\.(?:webp|jpe?g|png|avif|gif)', 'gi');
    const all = [...new Set((html.match(re) || []).map(m => {
      try { return new URL(m.startsWith('//') ? pre.protocol + m : m, pre.origin).href; } catch (_) { return null; }
    }))].filter(u => u && u.startsWith(prefix) && dirOf(u) !== curDir);
    if (!all.length) return; // capítulo bloqueado ou site diferente

    // fica só com a pasta que tem mais páginas (as do próximo capítulo)
    const groups = new Map();
    for (const u of all) { const d = dirOf(u); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(u); }
    const urls = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    if (!urls || !urls.length) return;

    toast(`Capítulo traduzido! Já estou traduzindo o próximo (${urls.length} páginas) para ele abrir pronto.`, 6000);
    for (const u of urls) {
      if (!autoOn) return;
      const res = isLocal(provider)
        ? await localTranslate({ src: u, pageUrl: next }, null)
        : await send({ type: 'translateImage', src: u, pageUrl: next });
      if (!res.ok && res.fatal) { handleError(res); return; }
    }
    toast('O próximo capítulo já está traduzido. Pode abrir! 👍', 5000);
  }

  // ---------- Modo automático ----------

  function startAuto() {
    if (autoOn) return;
    autoOn = true;
    observed = new WeakSet();
    io = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting && isCandidate(e.target)) enqueue(e.target);
    }, { rootMargin: '1500px 0px 2500px 0px' });
    scanImages();
    scanTimer = setInterval(scanImages, 3000);
  }

  function scanImages() {
    if (!io) return;
    for (const img of document.images) {
      if (!observed.has(img)) { observed.add(img); io.observe(img); }
    }
  }

  function stopAuto() {
    autoOn = false;
    if (io) io.disconnect();
    io = null;
    clearInterval(scanTimer);
    for (const img of queue.splice(0)) {
      const st = state.get(img);
      if (st && st.status === 'queued') { st.status = 'idle'; setBadge(st.group, ''); }
    }
  }

  // Imagem carregou (ou trocou de endereço): atualiza.
  document.addEventListener('load', e => {
    const t = e.target;
    if (!(t instanceof HTMLImageElement)) return;
    const st = state.get(t);
    if (st && st.src && st.src !== currentSrc(t)) resetImg(t);
    if (autoOn && io) { io.unobserve(t); io.observe(t); observed.add(t); }
    if (autoOn && isCandidate(t)) enqueue(t); // capítulo inteiro: páginas que aparecem depois também entram
    scheduleLayout();
  }, true);

  let localWarned = 0;
  async function warnLocalStarting() {
    if (Date.now() - localWarned < 60000) return;
    const st = await send({ type: 'localStatus', quick: true });
    if (!st.ok) return;
    if (st.engines.llama && st.engines.llama.health !== 'ok') {
      localWarned = Date.now();
      toast('Ligando o servidor local no seu PC… a primeira página demora um pouco enquanto o modelo carrega.', 7000);
    }
  }

  function translateAll(silent = false) {
    if (!enabled) return;
    if (isLocal(provider)) prepareTranslator();
    if (provider === 'local') warnLocalStarting();
    startAuto();
    const imgs = [...document.images].filter(i => isCandidate(i, true));
    for (const img of imgs) {
      const st = state.get(img);
      if (st && st.status === 'error') { st.status = 'idle'; setBadge(st.group, ''); }
      enqueue(img);
    }
    if (silent) return;
    if (imgs.length) {
      toast(`Traduzindo o capítulo inteiro (${imgs.length} ${imgs.length === 1 ? 'página' : 'páginas'}), começando pela que você está lendo.`);
    } else {
      toast('Ainda não achei as páginas do capítulo. Se nada acontecer, use Alt+T para traduzir a tela.', 7000);
    }
  }

  function translateBySrc(srcUrl) {
    const img = [...document.images].find(i => i.currentSrc === srcUrl || i.src === srcUrl);
    if (!img) { toast('Não achei essa imagem na página. Tente Alt+T para traduzir a tela.'); return; }
    const st = getState(img);
    if (st.status === 'done') { st.group.classList.remove('hidden-tr'); return; }
    translateAll();
  }

  // ---------- Traduzir a tela (funciona mesmo quando o site bloqueia as imagens) ----------

  let screenBusy = false;

  function frames(n) {
    return new Promise(resolve => {
      let k = 0;
      const step = () => (++k >= n ? setTimeout(resolve, 40) : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
  }

  // Recorta só a coluna onde estão as páginas, para o texto ficar mais nítido.
  function readingColumn() {
    let minL = Infinity, maxR = -Infinity;
    for (const el of document.querySelectorAll('img, canvas')) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) continue;
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
      minL = Math.min(minL, Math.max(0, r.left));
      maxR = Math.max(maxR, Math.min(innerWidth, r.right));
    }
    if (maxR - minL >= 200) return { x: minL, y: 0, w: maxR - minL, h: innerHeight };
    return { x: 0, y: 0, w: innerWidth, h: innerHeight };
  }

  async function translateScreen() {
    if (screenBusy) return;
    screenBusy = true;
    try {
      const crop = readingColumn();
      host.style.setProperty('visibility', 'hidden', 'important');
      await frames(2);
      let cap;
      try { cap = await send({ type: 'capture' }); }
      finally { host.style.removeProperty('visibility'); }
      if (!cap.ok) { toast('⚠ ' + cap.error); handleError(cap); return; }

      const rect = { left: crop.x + scrollX, top: crop.y + scrollY, w: crop.w, h: crop.h };
      for (let i = screenGroups.length - 1; i >= 0; i--) {
        const r = screenGroups[i].rect;
        if (r.top < rect.top + rect.h && r.top + r.h > rect.top) {
          screenGroups[i].group.remove();
          screenGroups.splice(i, 1);
        }
      }
      const g = newGroup();
      place(g, rect.left, rect.top, rect.w, rect.h);
      const sg = { group: g, rect, boxes: null, fitted: false };
      screenGroups.push(sg);
      setBadge(g, '🇧🇷 Traduzindo a tela…');
      scheduleLayout();

      const res = isLocal(provider)
        ? await localTranslate({ dataUrl: cap.dataUrl, crop: { ...crop, viewW: innerWidth } }, null)
        : await send({
          type: 'translateImage',
          dataUrl: cap.dataUrl,
          pageUrl: location.href,
          crop: { ...crop, viewW: innerWidth },
          context: contextLines.slice(-15)
        });
      if (!screenGroups.includes(sg)) return;
      if (!res.ok) {
        setBadge(g, '⚠ ' + errorText(res) + ' (clique para fechar)', {
          error: true,
          onClick: () => { g.remove(); const i = screenGroups.indexOf(sg); if (i >= 0) screenGroups.splice(i, 1); }
        });
        handleError(res);
        return;
      }
      sg.boxes = res.boxes;
      renderBoxes(g, res.boxes);
      if (res.boxes.length) setBadge(g, '');
      else { setBadge(g, 'Sem texto na tela'); setTimeout(() => setBadge(g, ''), 1500); }
      pushContext(res.boxes);
      scheduleLayout();
    } finally {
      screenBusy = false;
    }
  }

  // ---------- Comparar tradutores na página que está na tela ----------

  function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

  async function compareModes() {
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const img = document.elementsFromPoint(cx, cy).find(el => el instanceof HTMLImageElement && isCandidate(el)) ||
      [...document.images].find(i => { if (!isCandidate(i)) return false; const r = i.getBoundingClientRect(); return r.top < cy && r.bottom > cy; });
    if (!img) { toast('Deixe uma página do manhwa no meio da tela e tente de novo.'); return; }
    const src = currentSrc(img);
    const r = img.getBoundingClientRect();
    const k = img.naturalWidth / r.width;
    const top = Math.max(0, -r.top) * k, bottom = Math.min(r.height, innerHeight - r.top) * k;
    const crop = { x: 0, y: top, w: img.naturalWidth, h: Math.max(50, bottom - top), viewW: img.naturalWidth };

    attachHost();
    cmpPanel.classList.remove('wide');
    cmpPanel.style.display = 'block';
    const modes = [
      ['google', 'Google Tradutor (leitor de texto + Google)', true],
      ['nano', 'Gemini Nano (no seu PC)', true],
      ['local', 'No seu PC (llama.cpp + tradutor escolhido)', true],
      ['gemini', 'Gemini Flash (internet, chave grátis)', hasGemini],
      ['claude', 'Claude (API paga)', hasClaude]
    ];
    cmpPanel.innerHTML = `<header>🔬 Comparando o que está na tela <button title="Fechar">✕</button></header>` +
      modes.map(([id, name, ok]) => `<section data-m="${id}"><h3>${esc(name)}</h3><div class="wait">${ok ? 'traduzindo…' : 'sem chave configurada'}</div></section>`).join('');
    cmpPanel.querySelector('header button').onclick = () => { cmpPanel.style.display = 'none'; };

    const data = await send({ type: 'fetchImageData', src, pageUrl: location.href });
    if (!data.ok) { cmpPanel.querySelector('section .wait').textContent = '⚠ ' + errorText(data); return; }

    const show = (id, res, ms) => {
      const sec = cmpPanel.querySelector(`section[data-m="${id}"]`);
      if (!sec) return;
      if (!res.ok) { sec.querySelector('.wait').textContent = '⚠ ' + errorText(res); return; }
      const list = res.boxes.slice().sort((a, b) => a.y - b.y || a.x - b.x);
      sec.querySelector('h3').innerHTML += ` <small>· ${list.length} ${list.length === 1 ? 'fala' : 'falas'} · ${(ms / 1000).toFixed(1)} s</small>`;
      sec.querySelector('.wait').outerHTML = list.length
        ? '<ol>' + list.map(b => `<li>${esc(b.text)}${b.original ? `<span class="orig">${esc(b.original)}</span>` : ''}</li>`).join('') + '</ol>'
        : '<div class="wait">não achou nenhuma fala</div>';
    };

    for (const [id, , ok] of modes) {
      if (!ok) continue;
      const t0 = performance.now();
      let res;
      if (isLocal(id)) {
        if (id === 'google' || id === 'nano' || id === 'local') prepareTranslator();
        res = await localTranslate({ dataUrl: data.dataUrl, crop, mode: id }, null);
      } else {
        res = await send({ type: 'translateImage', providerOverride: id, dataUrl: data.dataUrl, crop, pageUrl: location.href, context: [] });
      }
      show(id, res, performance.now() - t0);
    }
  }

  // ---------- Comparar leitores de texto (OCR) na página que está na tela ----------
  // Recorta os balões da parte visível da página e cada leitor lê os mesmos
  // recortes. Se o llama.cpp estiver ligado, traduz o que cada um leu.

  const OCR_ENGINES = [
    ['llama', 'llama.cpp · no PC'],
    ['tesseract', 'Tesseract · modo Google'],
    ['nano', 'Gemini Nano · Chrome']
  ];

  function centerImage() {
    const cx = innerWidth / 2, cy = innerHeight / 2;
    return document.elementsFromPoint(cx, cy).find(el => el instanceof HTMLImageElement && isCandidate(el)) ||
      [...document.images].find(i => { if (!isCandidate(i)) return false; const r = i.getBoundingClientRect(); return r.top < cy && r.bottom > cy; });
  }

  let ocrCmpRun = 0;

  async function compareOcr() {
    const img = centerImage();
    if (!img) { toast('Deixe uma página do manhwa no meio da tela e tente de novo.'); return; }
    const run = ++ocrCmpRun;
    const src = currentSrc(img);
    const r = img.getBoundingClientRect();
    const k = img.naturalWidth / r.width;
    const top = Math.max(0, -r.top) * k, bottom = Math.min(r.height, innerHeight - r.top) * k;

    attachHost();
    cmpPanel.classList.add('wide');
    cmpPanel.style.display = 'block';
    cmpPanel.innerHTML = `<header>🔎 Comparando a leitura do texto <button title="Fechar">✕</button></header>` +
      `<section class="wait">Recortando os balões da parte que está na tela…</section>`;
    cmpPanel.querySelector('header button').onclick = () => { ocrCmpRun++; cmpPanel.style.display = 'none'; cmpPanel.classList.remove('wide'); };

    const data = await send({ type: 'fetchImageData', src, pageUrl: location.href });
    let dataUrl = data.ok ? data.dataUrl : imgToDataUrl(img);
    if (!dataUrl) { cmpPanel.querySelector('section').textContent = '⚠ ' + errorText(data); return; }
    const bmp = await createImageBitmap(base64ToBlob(dataUrl));
    const W = bmp.width, H = Math.max(50, Math.round(bottom - top));
    const s = Math.min(1, 1000 / W);
    const canvas = new OffscreenCanvas(Math.round(W * s), Math.round(H * s));
    const c2d = canvas.getContext('2d');
    c2d.fillStyle = '#fff';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    c2d.drawImage(bmp, 0, Math.round(top), W, H, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const crops = (await bubbleCrops(canvas, canvas.width, canvas.height, 10, LOCAL_CROP)).filter(c => c.text);
    if (run !== ocrCmpRun) return;
    if (!crops.length) {
      cmpPanel.querySelector('section').textContent = 'Não achei balões brancos na parte que está na tela. Role até uma parte com falas e tente de novo.';
      return;
    }

    // quais leitores estão prontos
    const st = await send({ type: 'localStatus', quick: true });
    const ocrSt = await send({ type: 'ocrStatus' });
    const ready = {
      llama: st.ok && st.engines.llama.health === 'ok' ? null : 'desligado (ligue nas configurações, aba Local)',
      tesseract: ocrSt.ok && ocrSt.installed ? null : 'não instalado (configurações, modo Google)',
      nano: null
    };
    const srcLabel = LANGS[srcLang] ? LANGS[srcLang].label : srcLang;

    cmpPanel.innerHTML = `<header>🔎 Leitura do texto · ${crops.length} ${crops.length === 1 ? 'balão' : 'balões'} · ${esc(srcLabel)} <button title="Fechar">✕</button></header>` +
      `<section class="sum">${OCR_ENGINES.map(([id, name]) =>
        `<div data-sum="${id}"><b>${esc(name)}</b> <small>${ready[id] ? esc(ready[id]) : 'lendo…'}</small></div>`).join('')}</section>` +
      crops.map((c, i) => `<section class="bub" data-i="${i}"><img alt="balão ${i + 1}"><ol>` +
        OCR_ENGINES.filter(([id]) => !ready[id]).map(([id, name]) =>
          `<li data-e="${id}"><b>${esc(name.split(' · ')[0])}:</b> <span class="t wait">…</span><span class="tr"></span></li>`).join('') +
        `</ol></section>`).join('');
    cmpPanel.querySelector('header button').onclick = () => { ocrCmpRun++; cmpPanel.style.display = 'none'; cmpPanel.classList.remove('wide'); };
    const urls = crops.map(c => URL.createObjectURL(c.blob));
    cmpPanel.querySelectorAll('section.bub img').forEach((el, i) => { el.src = urls[i]; });
    const images = await Promise.all(crops.map(c => blobToDataUrl(c.blob)));

    const results = {};
    const cell = (i, id) => cmpPanel.querySelector(`section.bub[data-i="${i}"] li[data-e="${id}"]`);
    const sum = id => cmpPanel.querySelector(`[data-sum="${id}"] small`);

    await Promise.all(OCR_ENGINES.filter(([id]) => !ready[id]).map(async ([id]) => {
      results[id] = [];
      let total = 0, fails = 0;
      for (let i = 0; i < images.length; i++) {
        if (run !== ocrCmpRun) return;
        const res = await send({ type: 'ocrCrop', engine: id, image: images[i] });
        const el = cell(i, id);
        if (!el) return;
        const t = el.querySelector('.t');
        t.classList.remove('wait');
        if (!res.ok) {
          fails++;
          t.textContent = '⚠ ' + (res.error || 'falhou');
          results[id].push('');
          if (res.fatal || ['NO_NANO', 'NO_OCR', 'LOCAL_OFF'].includes(res.code)) {
            for (let j = i + 1; j < images.length; j++) { const e2 = cell(j, id); if (e2) { e2.querySelector('.t').classList.remove('wait'); e2.querySelector('.t').textContent = '—'; } }
            sum(id).textContent = '⚠ ' + res.error;
            return;
          }
          continue;
        }
        total += res.ms;
        results[id].push(res.text);
        t.textContent = res.text || '(nada)';
        t.title = (res.ms / 1000).toFixed(1) + ' s';
        sum(id).textContent = `${i + 1 - fails} de ${images.length} · ${(total / 1000).toFixed(1)} s no total · ${(total / 1000 / (i + 1 - fails || 1)).toFixed(1)} s por balão`;
      }
    }));
    if (run !== ocrCmpRun) return;

    // traduz o que cada leitor leu (um pedido por leitor), para comparar o resultado final
    if (ready.llama) return;
    for (const [id] of OCR_ENGINES) {
      if (!results[id] || !results[id].some(Boolean)) continue;
      const tr = await send({ type: 'localTranslateTexts', texts: results[id] });
      if (run !== ocrCmpRun) return;
      results[id].forEach((_, i) => {
        const el = cell(i, id);
        if (!el) return;
        el.querySelector('.tr').textContent = tr.ok ? (tr.texts[i] ? '→ ' + tr.texts[i] : '') : (i === 0 ? '⚠ tradução: ' + tr.error : '');
      });
    }
  }

  // ---------- Mostrar original / limpar ----------

  function toggleAll() {
    showing = !showing;
    layer.classList.toggle('off', !showing);
    toast(showing ? 'Mostrando a tradução' : 'Mostrando o original', 1500);
  }

  function clearAll() {
    stopAuto();
    for (const [, st] of state) if (st.group) st.group.remove();
    state.clear();
    for (const sg of screenGroups.splice(0)) sg.group.remove();
    contextLines.length = 0;
    showing = true;
    layer.classList.remove('off');
  }

  // ---------- Botão que aparece ao passar o mouse na imagem ----------

  let hoverImg = null, hideTimer = null, mmPending = false, lastMove = null;

  document.addEventListener('mousemove', e => {
    lastMove = e;
    if (mmPending) return;
    mmPending = true;
    requestAnimationFrame(() => { mmPending = false; handleHover(lastMove); });
  }, { capture: true, passive: true });

  function handleHover(e) {
    if (!enabled) { if (hoverImg) hideHoverBtn(); return; }
    if (e.composedPath && e.composedPath().includes(host)) {
      clearTimeout(hideTimer); hideTimer = null;
      return;
    }
    const img = document.elementsFromPoint(e.clientX, e.clientY)
      .find(el => el instanceof HTMLImageElement && isCandidate(el));
    if (img) {
      hoverImg = img;
      clearTimeout(hideTimer); hideTimer = null;
      showHoverBtn();
    } else if (hoverImg && !hideTimer) {
      hideTimer = setTimeout(hideHoverBtn, 1200);
    }
  }

  function hideHoverBtn() {
    hoverBtn.style.display = 'none';
    refineBtn.style.display = 'none';
    hoverImg = null;
    hideTimer = null;
  }

  function showHoverBtn() {
    if (!hoverImg || !hoverImg.isConnected) { hideHoverBtn(); return; }
    const st = state.get(hoverImg);
    const status = st ? st.status : 'idle';
    let label = '🇧🇷 Traduzir capítulo';
    if (status === 'working') label = 'Traduzindo…';
    else if (status === 'queued') label = 'Na fila…';
    else if (status === 'done') label = st.group.classList.contains('hidden-tr') ? '🇧🇷 Ver tradução' : '👁 Ver original';
    else if (status === 'error') label = '🇧🇷 Tentar de novo';
    else if (autoOn) label = '🇧🇷 Traduzir esta página';
    hoverBtn.textContent = label;
    hoverBtn.disabled = status === 'working' || status === 'queued';
    const r = hoverImg.getBoundingClientRect();
    if (r.bottom < 40 || r.top > innerHeight - 40) { hoverBtn.style.display = 'none'; return; }
    hoverBtn.style.display = 'block';
    const bw = hoverBtn.offsetWidth;
    const left = Math.max(Math.max(r.left, 0) + 10, Math.min(r.right, innerWidth) - bw - 10);
    hoverBtn.style.left = left + 'px';
    hoverBtn.style.top = (Math.max(r.top, 0) + 10) + 'px';
    // página ficou ruim no modo Google? refaz só ela com o Gemini
    const canRefine = isLocal(provider) && hasGemini && st && (st.status === 'done' || st.status === 'error') && !st.refined;
    if (canRefine) {
      refineBtn.style.display = 'block';
      refineBtn.style.top = hoverBtn.style.top;
      refineBtn.style.left = Math.max(Math.max(r.left, 0) + 10, left - refineBtn.offsetWidth - 8) + 'px';
    } else {
      refineBtn.style.display = 'none';
    }
  }

  async function refineWithGemini(img) {
    const st = state.get(img);
    if (!st || st.status === 'working' || st.status === 'queued') return;
    st.status = 'working';
    setBadge(st.group, '✨ Refazendo com Gemini…');
    scheduleLayout();
    const res = await send({ type: 'translateImage', providerOverride: 'gemini', src: st.src, pageUrl: location.href, context: contextLines.slice(-15) });
    if (state.get(img) !== st) return;
    if (!res.ok) {
      st.status = 'done';
      setBadge(st.group, '');
      toast('⚠ Gemini: ' + errorText(res), 8000);
      return;
    }
    st.status = 'done';
    st.boxes = res.boxes;
    st.revised = true;
    st.refined = true;
    st.fitW = null;
    renderBoxes(st.group, res.boxes);
    st.group.classList.remove('hidden-tr');
    setBadge(st.group, '✨ Refeito com Gemini');
    setTimeout(() => { if (state.get(img) === st && st.status === 'done') setBadge(st.group, ''); }, 2500);
    pushContext(res.boxes);
    scheduleLayout();
    await send({ type: 'cachePut', key: cacheKeyFor(st.src, provider), boxes: res.boxes, revised: true });
  }

  refineBtn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    if (hoverImg) refineWithGemini(hoverImg);
    refineBtn.style.display = 'none';
  });

  hoverBtn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    if (isLocal(provider)) prepareTranslator();
    const img = hoverImg;
    if (!img) return;
    const st = state.get(img);
    if (st && st.status === 'done') {
      st.group.classList.toggle('hidden-tr');
    } else if (!st || st.status === 'idle' || st.status === 'error') {
      if (st) { st.status = 'idle'; setBadge(st.group, ''); }
      if (autoOn) enqueue(img);   // capítulo já está sendo traduzido: só garante esta página
      else translateAll();         // primeiro clique: traduz o capítulo inteiro, começando por esta página
    }
    setTimeout(showHoverBtn, 0);
  });

  // ---------- Comandos vindos do menu, atalhos e do popup ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!enabled && msg && /^cmd/.test(msg.type)) {
      toast('O Tradutor de Manhwa está desligado. Ligue no ícone da extensão (quebra-cabeça → Tradutor de Manhwa).', 5000);
      sendResponse({ ok: false, disabled: true });
      return;
    }
    switch (msg && msg.type) {
      case 'partialBoxes': onPartialBoxes(msg); break;
      case 'cmdTranslateScreen': translateScreen(); break;
      case 'cmdCompare': compareModes(); break;
      case 'cmdCompareOcr': compareOcr(); break;
      case 'cmdToggle': toggleAll(); break;
      case 'cmdTranslateAll': translateAll(); break;
      case 'cmdTranslateSrc': translateBySrc(msg.srcUrl); break;
      case 'cmdClear': clearAll(); break;
      case 'cmdSetAuto':
        if (msg.on) { translateAll(true); toast('Tradução automática ligada neste site.'); }
        else { stopAuto(); toast('Tradução automática desligada neste site.'); }
        break;
      case 'getStatus': {
        let done = 0, pending = 0, lines = 0;
        for (const [, st] of state) {
          if (st.status === 'done') { done++; lines += st.boxes.length; }
          else if (st.status === 'working' || st.status === 'queued') pending++;
        }
        sendResponse({ ok: true, done, pending, lines, screen: screenGroups.length, auto: autoOn, showing, host: location.hostname });
        return;
      }
      default:
        return;
    }
    sendResponse({ ok: true });
  });

  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    prefetchStarted = false;
    contextLines.length = 0;
    if (autoOn) setTimeout(() => translateAll(true), 1200);
  }, 1000);

  function applyEnabled(on, firstTime) {
    enabled = on;
    if (on) {
      attachHost();
      chrome.storage.local.get({ autoSites: [] }).then(({ autoSites }) => {
        if (autoSites.includes(location.hostname)) setTimeout(() => translateAll(true), firstTime ? 1500 : 300);
      }).catch(() => {});
    } else if (!firstTime) {
      // desligou: para tudo e devolve a página ao original
      clearAll();
      hideHoverBtn();
      host.remove();
    }
  }

  chrome.storage.local.get({ enabled: false }).then(r => applyEnabled(!!r.enabled, true)).catch(() => {});
  chrome.storage.onChanged.addListener(ch => {
    if (ch.enabled) applyEnabled(!!ch.enabled.newValue, false);
  });
})();
