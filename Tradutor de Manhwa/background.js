importScripts('lib.js', 'local-server.js');

const DEFAULTS = {
  provider: 'gemini',            // 'gemini' (grátis), 'google' (grátis e sem limite), 'claude' (pago), 'nano' ou 'local' (no PC)
  geminiKey: '',
  geminiModel: 'gemini-3.6-flash',
  apiKey: '',                    // chave do Claude
  model: 'claude-haiku-5-5',     // modelo do Claude
  customModel: '',
  srcLang: 'en',                 // idioma do texto nas imagens (código de LANGS, lib.js)
  dstLang: null,                 // idioma da tradução; null = ainda não migrou do campo antigo
  targetLang: 'português do Brasil', // campo antigo (texto livre), só para migrar
  useCache: true,
  useMemory: true,      // memória da série (nomes e termos sempre traduzidos igual)
  reviewPass: true,     // modo Google: revisar depois de traduzir
  prefetchNext: true,   // já traduzir o próximo capítulo
  localTranslator: 'llama',      // modo 'local': quem traduz (llama, gemini, claude ou google)
  autoSites: []
};

// Preço em dólar por milhão de tokens [entrada, saída] — só para estimar o gasto.
const PRICES = {
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20]
};

const FATAL = new Set(['NO_KEY', 'AUTH', 'CREDIT', 'MODEL', 'QUOTA', 'NO_OCR', 'NO_NANO',
  'NO_HOST', 'NOT_INSTALLED', 'NO_VCRUNTIME', 'START_FAILED', 'VULKAN_OLD', 'LOCAL_TIMEOUT', 'LOCAL_OFF', 'LOCAL_AUTH']);

// targetLang/sourceLang saem como nome em inglês, que é o que vai nos prompts.
async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  if (!s.dstLang) s.dstLang = migrateTargetLang(s.targetLang);
  if (!LANGS[s.srcLang]) s.srcLang = 'en';
  s.targetLang = langName(s.dstLang);
  s.sourceLang = langName(s.srcLang);   // null = detectar sozinho
  return s;
}

function modelOf(s) {
  const custom = (s.customModel || '').trim();
  if (custom) return custom;
  return s.provider === 'gemini' ? (s.geminiModel || DEFAULTS.geminiModel) : (s.model || DEFAULTS.model);
}

function keyOf(s) {
  if (s.provider === 'google' || s.provider === 'nano' || s.provider === 'local') return 'sem-chave';
  return s.provider === 'gemini' ? s.geminiKey : s.apiKey;
}

function noKeyError(s) {
  return err('NO_KEY', s.provider === 'gemini'
    ? 'Falta colocar sua chave do Gemini nas configurações da extensão.'
    : 'Falta colocar sua chave da API do Claude nas configurações da extensão.');
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Mantém o service worker acordado enquanto uma tradução está em andamento.
function keepAlive() {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  return () => clearInterval(t);
}

// ---------- Mensagens ----------

const HANDLERS = {
  translateImage,
  capture,
  testKey,
  getStats,
  clearCache,
  clearMemory,
  fetchImageData,
  googleTranslate,
  cacheGet,
  cachePut,
  ocr,
  ocrStatus,
  nanoRead: async (msg) => {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', kind: 'nano', image: msg.image, src: (await getSettings()).srcLang });
    if (!r || !r.ok) throw err((r && r.code) || 'NANO', (r && r.error) || 'O Gemini Nano não respondeu.');
    return { text: r.text };
  },
  downloadOcr,
  openOptions: async () => { await chrome.runtime.openOptionsPage(); return {}; },
  ...LOCAL_HANDLERS
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg && msg.type];
  if (!handler) return false;
  const stop = keepAlive();
  // Promise.resolve().then: erro lançado direto (sem await) também vira resposta de erro
  Promise.resolve().then(() => handler(msg, sender))
    .then(r => sendResponse({ ok: true, ...r }))
    .catch(e => {
      console.warn('[Tradutor de Manhwa]', e);
      sendResponse({ ok: false, error: e.message || String(e), code: e.code || null, fatal: FATAL.has(e.code) });
    })
    .finally(stop);
  return true;
});

// ---------- Menu do botão direito e atalhos ----------

chrome.runtime.onInstalled.addListener(details => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'traduzir-imagem', title: 'Traduzir esta imagem para português', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'traduzir-tela', title: 'Traduzir o que está na tela', contexts: ['page', 'image'] });
    updatePowerUi();
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

async function updatePowerUi() {
  const { enabled } = await chrome.storage.local.get({ enabled: false });
  try {
    await chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#15803d' });
    await chrome.action.setTitle({ title: enabled ? 'Tradutor de Manhwa: ligado' : 'Tradutor de Manhwa: desligado' });
  } catch (_) {}
  for (const id of ['traduzir-imagem', 'traduzir-tela']) {
    chrome.contextMenus.update(id, { visible: !!enabled }, () => void chrome.runtime.lastError);
  }
}

chrome.storage.onChanged.addListener(ch => { if (ch.enabled) updatePowerUi(); });
chrome.runtime.onStartup.addListener(updatePowerUi);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === 'traduzir-imagem') sendToTab(tab.id, { type: 'cmdTranslateSrc', srcUrl: info.srcUrl });
  if (info.menuItemId === 'traduzir-tela') sendToTab(tab.id, { type: 'cmdTranslateScreen' });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const { enabled } = await chrome.storage.local.get({ enabled: false });
  if (!enabled) return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  if (command === 'traduzir-tela') sendToTab(tab.id, { type: 'cmdTranslateScreen' });
  if (command === 'alternar-original') sendToTab(tab.id, { type: 'cmdToggle' });
});

// Envia para a aba; se a página foi aberta antes de instalar a extensão,
// injeta o script e tenta de novo.
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['lib.js', 'content.js'] });
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      console.warn('Não deu para falar com a aba', e);
    }
  }
}

// ---------- Tradução ----------

const inflight = new Map();

async function translateImage(msg, sender) {
  let settings = await getSettings();
  if (msg.providerOverride) settings = { ...settings, provider: msg.providerOverride };
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const onPartial = (msg.reqId && tabId != null)
    ? (boxes, done, total) => chrome.tabs.sendMessage(tabId, { type: 'partialBoxes', reqId: msg.reqId, boxes, done, total }).catch(() => {})
    : null;
  if (!keyOf(settings)) throw noKeyError(settings);
  const model = modelOf(settings);

  const cacheable = !msg.dataUrl && /^https?:/i.test(msg.src || '');
  const cacheKey = cacheable ? 'c:' + hashString(settings.provider + '|' + model + '|' + settings.srcLang + '>' + settings.targetLang + '|' + msg.src) : null;
  if (cacheKey && settings.useCache) {
    const hit = (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (hit) return { boxes: hit.boxes, cached: true };
  }
  if (cacheKey && inflight.has(cacheKey)) return inflight.get(cacheKey);
  const job = doTranslate(msg, settings, model, cacheKey, onPartial);
  if (cacheKey) {
    inflight.set(cacheKey, job);
    job.finally(() => inflight.delete(cacheKey)).catch(() => {});
  }
  return job;
}

async function doTranslate(msg, settings, model, cacheKey, onPartial) {
  const memKey = settings.useMemory ? seriesKeyOf(msg.pageUrl) : null;
  if (memKey) settings = { ...settings, glossary: await glossaryFor(memKey) };

  const blob = msg.dataUrl
    ? await (await fetch(msg.dataUrl)).blob()
    : await fetchImage(msg.src, msg.pageUrl);

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (_) {
    throw err('FETCH_FAILED', 'Não consegui abrir essa imagem.');
  }

  // Região a traduzir (imagem inteira, ou um recorte da captura de tela).
  let region = { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  if (msg.crop) {
    const f = bitmap.width / msg.crop.viewW; // CSS px -> px da captura
    const x = Math.max(0, Math.round(msg.crop.x * f));
    const y = Math.max(0, Math.round(msg.crop.y * f));
    region = {
      x, y,
      w: Math.max(1, Math.min(bitmap.width - x, Math.round(msg.crop.w * f))),
      h: Math.max(1, Math.min(bitmap.height - y, Math.round(msg.crop.h * f)))
    };
  }

  try {
    const boxes = await translateRegion(bitmap, region, settings, model, msg.context || [], onPartial);
    if (cacheKey && settings.useCache) {
      await chrome.storage.local.set({ [cacheKey]: { boxes, t: Date.now() } });
    }
    if (memKey) await remember(memKey, boxes);
    return { boxes };
  } finally {
    bitmap.close();
  }
}

async function capture(msg, sender) {
  if (!sender.tab) throw err('CAPTURE', 'Sem aba para capturar.');
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'jpeg', quality: 90 });
    return { dataUrl };
  } catch (e) {
    throw err('CAPTURE', 'Não consegui capturar a tela: ' + (e.message || e));
  }
}

async function fetchImage(src, pageUrl) {
  if (!/^https?:/i.test(src || '')) {
    throw err('FETCH_FAILED', 'Esse tipo de imagem não pode ser baixado direto.');
  }
  // Muitos sites de leitura só entregam a imagem se o "Referer" for o próprio site.
  try { await setReferer(src, pageUrl); } catch (e) { console.warn('referer', e); }

  let res;
  try {
    res = await fetch(src, { credentials: 'include', cache: 'force-cache' });
  } catch (_) {
    throw err('FETCH_FAILED', 'Não consegui baixar a imagem.');
  }
  if (!res.ok) throw err('FETCH_FAILED', `O site recusou a imagem (erro ${res.status}).`);
  return res.blob();
}

async function setReferer(src, pageUrl) {
  if (!pageUrl) return;
  const host = new URL(src).hostname;
  const id = 1000 + (parseInt(hashString(host).slice(0, 7), 16) % 1000000);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'set', value: pageUrl }]
      },
      condition: {
        requestDomains: [host],
        tabIds: [chrome.tabs.TAB_ID_NONE],
        resourceTypes: ['xmlhttprequest', 'other']
      }
    }]
  });
}

async function translateRegion(bitmap, region, settings, model, context, onPartial) {
  const chunks = planChunks(region.w, region.h, settings.provider === 'gemini' ? GEMINI_LIMITS : DEFAULT_LIMITS);
  const items = [];
  const ctx = context.slice(-15);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const outW = Math.max(1, Math.round(region.w * chunk.scale));
    const outH = Math.max(1, Math.round(chunk.h * chunk.scale));
    const canvas = new OffscreenCanvas(outW, outH);
    const c2d = canvas.getContext('2d');
    c2d.fillStyle = '#fff';
    c2d.fillRect(0, 0, outW, outH);
    c2d.drawImage(bitmap, region.x, region.y + chunk.y0, region.w, chunk.h, 0, 0, outW, outH);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
    const b64 = await blobToBase64(jpeg);

    const bubbles = settings.provider === 'gemini'
      ? await callGemini(b64, outW, outH, settings, model, ctx)
      : await callClaude(b64, outW, outH, settings, model, ctx);
    const boxes = chunkBoxesToRegion(bubbles, chunk, outW, outH);
    for (const box of boxes) {
      items.push({ box, chunkIndex: i });
      if (box.kind !== 'sfx') ctx.push(box.text);
    }
    while (ctx.length > 15) ctx.shift();

    // Mostra o que já ficou pronto, sem esperar a imagem inteira.
    if (onPartial && chunks.length > 1 && i < chunks.length - 1) {
      const sofar = dedupeAcrossChunks(items, chunks.slice(0, i + 1));
      onPartial(toFractions(sofar, region.w, region.h), i + 1, chunks.length);
    }
  }

  const merged = chunks.length > 1 ? dedupeAcrossChunks(items, chunks) : items.map(it => it.box);
  return toFractions(merged, region.w, region.h);
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

// ---------- Claude ----------

function systemPrompt(lang, src) {
  return `You translate comics (manhwa, manga, manhua, webtoons) for a reader who speaks ${lang}.${src ? ` The text in the images is written in ${src}.` : ''}

You receive one image: a comic page or a slice of a long vertical webtoon strip. Find every piece of readable text that matters for the story: speech bubbles, thought bubbles, narration boxes, captions, relevant signs or text inside the scene, and sound effects.

For each one report:
- x, y, w, h: bounding box in pixels of THIS image (its size is given). x,y is the top-left corner. Cover the whole inside of the bubble or box where the text sits, so the translation can be drawn over the original text and hide it.
- original: the text exactly as written.
- translation: a natural, fluent translation into ${lang}, written the way a good fan translation group would: keep the tone (slang, swearing, jokes, formality), keep character names, and keep Korean/Japanese honorifics such as -nim, hyung, oppa, noona, sunbae, -san, -kun as they appear. No notes or explanations.
- kind: dialogue, narration, sfx or sign.

List items in reading order (top to bottom; for right-to-left manga pages, right to left).

Rules:
- Text that is already in ${lang}: skip it.
- Skip watermarks, website names, scanlation credits, page numbers and ads.
- Text cut off at the top or bottom edge: include it only if most of it is readable.
- No text in the image: call the tool with an empty list.
Always answer by calling the tool enviar_traducoes.`;
}

const TOOL = {
  name: 'enviar_traducoes',
  description: 'Sends the translated text found in the image, with its position.',
  input_schema: {
    type: 'object',
    properties: {
      bubbles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'left edge, px' },
            y: { type: 'number', description: 'top edge, px' },
            w: { type: 'number', description: 'width, px' },
            h: { type: 'number', description: 'height, px' },
            original: { type: 'string' },
            translation: { type: 'string' },
            kind: { type: 'string', enum: ['dialogue', 'narration', 'sfx', 'sign'] }
          },
          required: ['x', 'y', 'w', 'h', 'translation']
        }
      }
    },
    required: ['bubbles']
  }
};

function glossaryText(settings) {
  const g = settings.glossary || [];
  if (!g.length) return '';
  return '\n\nGlossary from earlier chapters of this same series. When the same name, term or line appears, use exactly this translation:\n' +
    g.map(([o, t]) => `- ${o} => ${t}`).join('\n');
}

async function callClaude(b64, w, h, settings, model, context) {
  let text = `Image size: ${w}x${h} pixels.` + glossaryText(settings);
  if (context.length) {
    text += `\n\nPrevious lines of this chapter, already translated (keep names and tone consistent):\n` +
      context.map(l => '- ' + l.replace(/\s+/g, ' ')).join('\n');
  }
  text += `\n\nTranslate the text in this image into ${settings.targetLang}.`;

  const body = {
    model,
    max_tokens: 4096,
    system: systemPrompt(settings.targetLang, settings.sourceLang),
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text }
      ]
    }]
  };

  const data = await postMessages(body, settings.apiKey);
  await addUsage(model, data.usage);
  const tool = (data.content || []).find(c => c.type === 'tool_use');
  return (tool && tool.input && tool.input.bubbles) || [];
}

async function postMessages(body, apiKey, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      throw err('NETWORK', 'Sem conexão com o Claude. Confira sua internet.');
    }
    clearTimeout(timer);

    if (res.ok) return res.json();

    let detail = '';
    try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch (_) {}
    const s = res.status;

    if ((s === 429 || s === 529 || s >= 500) && attempt < retries) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 3000 * (attempt + 1);
      await sleep(Math.min(wait, 20000));
      continue;
    }
    if (s === 401 || s === 403) throw err('AUTH', 'Chave da API inválida. Confira nas configurações da extensão.');
    if (/credit balance/i.test(detail)) throw err('CREDIT', 'Sua conta da API está sem crédito. Adicione crédito em console.anthropic.com.');
    if (s === 404 || (/model/i.test(detail) && /not.?found|invalid/i.test(detail))) {
      throw err('MODEL', `Modelo não encontrado: ${body.model}. Escolha outro nas configurações.`);
    }
    if (s === 429 || s === 529) throw err('BUSY', 'O Claude está ocupado agora. Tente de novo daqui a pouco.');
    if (s === 413) throw err('TOO_BIG', 'Imagem grande demais.');
    throw err('API', `Erro da API (${s}): ${detail || 'sem detalhes'}`);
  }
}

// ---------- Gemini (Google) ----------

function geminiPrompt(lang, src) {
  return systemPrompt(lang, src)
    .replace(/- x, y, w, h:[^\n]*\n/, '- box_2d: [ymin, xmin, ymax, xmax] of the bubble or box, normalized to 0-1000. Cover the whole inside of the bubble or box where the text sits, so the translation can be drawn over the original text and hide it.\n')
    .replace('- No text in the image: call the tool with an empty list.\n', '')
    .replace('Always answer by calling the tool enviar_traducoes.',
      'Answer ONLY with JSON in this exact shape: {"bubbles":[{"box_2d":[ymin,xmin,ymax,xmax],"original":"...","translation":"...","kind":"dialogue"}]}. If there is no text, answer {"bubbles":[]}.');
}

function geminiText(data) {
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
}

let geminiNoThinkingCfg = false;

async function callGemini(b64, w, h, settings, model, context) {
  let text = glossaryText(settings).trim();
  if (text) text += '\n\n';
  if (context.length) {
    text += 'Previous lines of this chapter, already translated (keep names and tone consistent):\n' +
      context.map(l => '- ' + l.replace(/\s+/g, ' ')).join('\n') + '\n\n';
  }
  text += `Translate the text in this image into ${settings.targetLang}. Answer only with the JSON.`;

  const body = {
    systemInstruction: { parts: [{ text: geminiPrompt(settings.targetLang, settings.sourceLang) }] },
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: b64 } },
        { text }
      ]
    }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 }
  };
  if (!geminiNoThinkingCfg) body.generationConfig.thinkingConfig = { thinkingLevel: 'low' };

  let data;
  try {
    data = await postGemini(model, body, settings.geminiKey);
  } catch (e) {
    if (e.code === 'API' && /thinking/i.test(e.message) && body.generationConfig.thinkingConfig) {
      geminiNoThinkingCfg = true;
      delete body.generationConfig.thinkingConfig;
      data = await postGemini(model, body, settings.geminiKey);
    } else {
      throw e;
    }
  }

  await addUsage(model, data.usageMetadata);
  const block = data.promptFeedback && data.promptFeedback.blockReason;
  if (block) throw err('BLOCKED', 'O Gemini se recusou a ler esta parte da página.');
  const parsed = parseJsonLoose(geminiText(data));
  if (!parsed) throw err('API', 'O Gemini respondeu num formato estranho. Tente de novo.');
  return geminiToBubbles(parsed, w, h);
}

async function postGemini(model, body, key, { retries = 4 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body)
      });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      throw err('NETWORK', 'Sem conexão com o Gemini. Confira sua internet.');
    }
    clearTimeout(timer);
    if (res.ok) return res.json();

    let e = {};
    try { e = (await res.json()).error || {}; } catch (_) {}
    const msg = e.message || '';
    const s = res.status;
    const raw = JSON.stringify(e);

    if (s === 429 || e.status === 'RESOURCE_EXHAUSTED') {
      if (/per ?day|PerDay|daily/i.test(raw)) {
        throw err('QUOTA', 'Acabou o limite grátis de hoje do Gemini. Amanhã libera de novo (ou troque para o Claude nas configurações).');
      }
      if (attempt < retries) {
        const m = raw.match(/"retryDelay":"(\d+(?:\.\d+)?)s"/);
        await sleep(Math.min(m ? Number(m[1]) * 1000 + 500 : 15000, 60000));
        continue;
      }
      throw err('BUSY', 'O Gemini pediu para esperar (limite por minuto). Tente de novo daqui a pouco.');
    }
    if ((s >= 500 || s === 503) && attempt < retries) { await sleep(3000 * (attempt + 1)); continue; }
    if (/API key not valid|API_KEY_INVALID|API key expired/i.test(raw) || s === 401 || s === 403) {
      throw err('AUTH', 'Chave do Gemini inválida. Confira nas configurações da extensão.');
    }
    if (s === 404) throw err('MODEL', `Modelo do Gemini não encontrado: ${model}. Escolha outro nas configurações.`);
    if (/location is not supported|User location/i.test(raw)) throw err('AUTH', 'O Gemini não está liberado para a sua conta ou região.');
    throw err('API', `Erro do Gemini (${s}): ${msg || 'sem detalhes'}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testKey(msg) {
  const settings = { ...(await getSettings()), ...(msg.overrides || {}) };
  if (!keyOf(settings)) throw err('NO_KEY', 'Cole a chave primeiro.');
  const model = modelOf(settings);
  if (settings.provider === 'gemini') {
    const data = await postGemini(model, {
      contents: [{ role: 'user', parts: [{ text: 'Responda só: ok' }] }]
    }, settings.geminiKey, { retries: 1 });
    return { model, reply: geminiText(data) };
  }
  const data = await postMessages({
    model,
    max_tokens: 20,
    messages: [{ role: 'user', content: 'Responda só: ok' }]
  }, settings.apiKey, { retries: 1 });
  return { model, reply: (data.content || []).map(c => c.text || '').join('').trim() };
}

// ---------- Gasto estimado ----------

let statsLock = Promise.resolve();

function addUsage(model, usage) {
  if (!usage) return Promise.resolve();
  if (usage.promptTokenCount != null) {
    usage = { input_tokens: usage.promptTokenCount, output_tokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0) };
  }
  statsLock = statsLock.then(async () => {
    const today = new Date().toLocaleDateString('sv'); // AAAA-MM-DD no fuso local
    const { stats } = await chrome.storage.local.get('stats');
    const s = stats || { day: today, calls: 0, usd: 0, allCalls: 0, allUsd: 0, unknownPrice: false };
    if (s.day !== today) { s.day = today; s.calls = 0; s.usd = 0; }
    const p = /^gemini/i.test(model) ? [0, 0] : PRICES[model];
    const cost = p ? ((usage.input_tokens || 0) * p[0] + (usage.output_tokens || 0) * p[1]) / 1e6 : 0;
    if (!p) s.unknownPrice = true;
    s.calls++; s.allCalls++;
    s.usd += cost; s.allUsd += cost;
    await chrome.storage.local.set({ stats: s });
  }).catch(e => console.warn('stats', e));
  return statsLock;
}

async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  const today = new Date().toLocaleDateString('sv');
  if (!stats) return { stats: { calls: 0, usd: 0, allCalls: 0, allUsd: 0 } };
  if (stats.day !== today) return { stats: { ...stats, calls: 0, usd: 0 } };
  return { stats };
}

// ---------- Modo Google (leitor de texto do Chrome + Google Tradutor) ----------

// Baixa a imagem para a página poder ler o texto dela (o site não deixa a página ler direto).
async function fetchImageData(msg) {
  const blob = await fetchImage(msg.src, msg.pageUrl);
  return { dataUrl: `data:${blob.type || 'image/jpeg'};base64,` + await blobToBase64(blob) };
}

async function cacheGet(msg) {
  const settings = await getSettings();
  if (!settings.useCache || !msg.key) return { boxes: null };
  const k = 'c:' + hashString('google|' + settings.srcLang + '>' + settings.targetLang + '|' + msg.key);
  const hit = (await chrome.storage.local.get(k))[k];
  return { boxes: hit ? hit.boxes : null, revised: !!(hit && hit.revised) };
}

async function cachePut(msg) {
  const settings = await getSettings();
  if (!settings.useCache || !msg.key) return {};
  const k = 'c:' + hashString('google|' + settings.srcLang + '>' + settings.targetLang + '|' + msg.key);
  await chrome.storage.local.set({ [k]: { boxes: msg.boxes, revised: !!msg.revised, t: Date.now() } });
  return {};
}

// Leitor de texto (Tesseract) — roda num documento escondido da extensão.
const OCR_CORE = [
  ['tesseract.min.js', 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'],
  ['worker.min.js', 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js'],
  ['tesseract-core-simd-lstm.wasm.js', 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract-core-lstm.wasm.js', 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-lstm.wasm.js']
];

// Arquivos do leitor de texto para o idioma de entrada (eng, kor, jpn...).
function ocrFiles(tess) {
  return [...OCR_CORE, [tess + '.traineddata.gz', `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${tess}@1.0.0/4.0.0_best_int/${tess}.traineddata.gz`]];
}

async function ocrLang(msg) {
  if (msg && msg.lang && /^[a-z_]{3,8}$/.test(msg.lang)) return msg.lang;
  return langTess((await getSettings()).srcLang);
}

async function ocrStatus(msg) {
  const lang = await ocrLang(msg);
  const missing = [];
  for (const [name] of ocrFiles(lang)) {
    try {
      const r = await fetch(chrome.runtime.getURL('tesseract/' + name), { method: 'HEAD' });
      if (!r.ok) missing.push(name);
    } catch (_) {
      missing.push(name);
    }
  }
  return { installed: missing.length === 0, missing, lang };
}

async function downloadOcr(msg) {
  const files = ocrFiles(await ocrLang(msg));
  for (const [name, url] of files) {
    await chrome.downloads.download({ url, filename: 'tesseract/' + name, conflictAction: 'overwrite', saveAs: false });
  }
  return { count: files.length };
}

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Ler o texto das páginas de manhwa para traduzir.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function ocr(msg) {
  const lang = await ocrLang(msg);
  const st = await ocrStatus({ lang });
  if (!st.installed) {
    throw err('NO_OCR', 'Falta instalar o leitor de texto do modo Google. Abra as configurações da extensão e siga o passo 2.');
  }
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', image: msg.image, mode: msg.mode || 'auto', lang });
  if (!r || !r.ok) throw err((r && r.code) || 'OCR', 'O leitor de texto falhou: ' + ((r && r.error) || 'sem resposta'));
  return { lines: r.lines };
}

// Google Tradutor pela internet (usado quando o tradutor embutido do Chrome não está disponível).
async function googleTranslate(msg) {
  const s = await getSettings();
  const from = msg.from || langGtx(s.srcLang);
  const to = msg.to || langGtx(s.dstLang);
  const out = new Array(msg.texts.length);
  let next = 0;
  async function worker() {
    while (next < msg.texts.length) {
      const i = next++;
      out[i] = await googleOne(msg.texts[i], from, to);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return { texts: out };
}

async function googleOne(text, from, to, attempt = 0) {
  if (!text || !text.trim()) return '';
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + encodeURIComponent(from || 'auto') + '&tl=' +
    encodeURIComponent(to) + '&dt=t&q=' + encodeURIComponent(text);
  let res;
  try {
    res = await fetch(url);
  } catch (_) {
    if (attempt < 2) { await sleep(1500 * (attempt + 1)); return googleOne(text, from, to, attempt + 1); }
    throw err('NETWORK', 'Sem conexão com o Google Tradutor.');
  }
  if (res.status === 429 && attempt < 3) { await sleep(5000 * (attempt + 1)); return googleOne(text, from, to, attempt + 1); }
  if (!res.ok) throw err('API', `O Google Tradutor recusou (erro ${res.status}). Tente de novo daqui a pouco.`);
  const data = await res.json();
  return (data[0] || []).map(seg => seg[0] || '').join('').trim();
}

// ---------- Memória da série ----------

function seriesKeyOf(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const path = u.pathname.replace(/\/+$/, '');
    let p = path.replace(/\/[^/]*?(?:chapter|capitulo|cap|ch|episode|ep)[-_.]?\d[^/]*$/i, '');
    if (p === path) p = path.slice(0, path.lastIndexOf('/'));
    return 'mem:' + u.hostname + p;
  } catch (_) {
    return null;
  }
}

function normLine(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

async function glossaryFor(memKey) {
  const pairs = (await chrome.storage.local.get(memKey))[memKey] || [];
  return pairs.filter(([o]) => o.length <= 60).slice(-40);
}

let memLock = Promise.resolve();

function remember(memKey, boxes) {
  memLock = memLock.then(async () => {
    const pairs = (await chrome.storage.local.get(memKey))[memKey] || [];
    const index = new Map(pairs.map((p, i) => [p[0].toUpperCase(), i]));
    for (const b of boxes) {
      const o = normLine(b.original), t = normLine(b.text);
      if (!o || !t || b.kind === 'sfx' || o.length > 120) continue;
      const k = o.toUpperCase();
      if (index.has(k)) pairs.splice(index.get(k), 1);
      pairs.push([o, t]);
      index.clear();
      pairs.forEach((p, i) => index.set(p[0].toUpperCase(), i));
    }
    while (pairs.length > 300) pairs.shift();
    await chrome.storage.local.set({ [memKey]: pairs });
  }).catch(e => console.warn('memória', e));
  return memLock;
}

async function clearMemory() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith('mem:'));
  if (keys.length) await chrome.storage.local.remove(keys);
  return { removed: keys.length };
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith('c:'));
  if (keys.length) await chrome.storage.local.remove(keys);
  return { removed: keys.length };
}
