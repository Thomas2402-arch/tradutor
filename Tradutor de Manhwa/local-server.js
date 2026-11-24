// Servidores locais: instala, liga, desliga, mostra o status e conversa com eles.
//
// A extensão não pode rodar programas no PC. Quem faz isso é o "ajudante"
// (servidor/host.ps1), que o usuário instala uma vez com o arquivo gerado na
// página de configurações e que o Chrome abre via native messaging.
// O status de "ligado" vem direto de cada servidor (HTTP), sem o ajudante.
//
// Motor: llama = llama.cpp + modelo de visão (lê o texto do balão e traduz).
// A estrutura aceita outros motores; o OXR-1.0 (CrispEmbed) foi testado e
// retirado: o modelo de visão já lê bem, e dois servidores pesam em PC fraco.
//
// Carregado pelo background (importScripts) antes de background.js.

const NATIVE_HOST = 'com.tradutor_manhwa.servidor';
// Versão do ajudante (servidor/host.ps1) que esta extensão espera. Se o instalado
// for mais antigo, a página de configurações pede para rodar o instalador de novo.
const HOST_VERSION = 4;
const LOCAL_MODEL_ALIAS = 'tradutor-local';

const ENGINES = {
  llama: {
    label: 'llama.cpp',
    tag: 'b12588',                       // build do llama.cpp testado com a extensão
    portKey: 'localPort',
    repoKey: 'localRepo',
    quant: 'Q4_K_M,Q4_0,Q8_0',
    health: '/health',
    auth: true
  }
};

const LOCAL_DEFAULTS = {
  localPort: 18080,
  localBackend: '',                      // '' = ainda não escolhido (a página sugere pela placa de vídeo)
  localRepo: 'ggml-org/Qwen3.5-4B-GGUF',
  localCtx: 8192,
  localParallel: 2,
  localKey: '',
  localTranslator: 'llama',              // modo "No seu PC": quem traduz (llama, gemini, claude ou google)
  localInstalled: false                 // já instalou algum motor (para o popup mostrar o status)
};

const HOST_ERRORS = {
  BAD_ARGS: 'Configuração inválida para o servidor local.',
  BUSY: 'Já tem uma instalação em andamento. Espere ela terminar.',
  NOT_INSTALLED: 'Esse motor ainda não foi instalado. Clique em "Baixar e instalar".',
  NO_VCRUNTIME: 'Falta o runtime do Visual C++ no Windows. Clique em "Instalar runtime do Visual C++".',
  START_FAILED: 'O servidor local fechou logo depois de abrir. Veja o registro (log) para saber o motivo.'
};

function engineOf(msg) {
  const e = (msg && msg.engine) || 'llama';
  if (!ENGINES[e]) throw err('BAD_ARGS', 'Motor desconhecido: ' + e);
  return e;
}

function nativeCall(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, res => {
      const le = chrome.runtime.lastError;
      if (le) {
        const m = le.message || String(le);
        if (/not found|forbidden/i.test(m)) {
          reject(err('NO_HOST', 'O ajudante do servidor local não está instalado neste PC.'));
        } else {
          reject(err('HOST', 'O ajudante do servidor local falhou: ' + m));
        }
        return;
      }
      if (!res) { reject(err('HOST', 'O ajudante do servidor local não respondeu.')); return; }
      if (res.ok === false) {
        let text = HOST_ERRORS[res.code] || res.error || 'Erro no ajudante do servidor local.';
        if (res.code === 'VULKAN_OLD') {
          text = `O Vulkan deste PC é antigo demais (versão ${res.vulkanLoader || 'desconhecida'}; precisa da 1.2 ou mais nova). ` +
            'Atualize o driver da placa de vídeo, ou nas configurações (aba Local) escolha "Sem placa de vídeo" e clique em "Atualizar".';
        } else if (res.code === 'START_FAILED' && res.hint) {
          text = 'O servidor local fechou logo depois de abrir' + (res.exitCode ? ` (código ${res.exitCode})` : '') + '. ' + res.hint;
        }
        const e = err(res.code || 'HOST', text);
        if (res.log) e.log = res.log;
        reject(e);
        return;
      }
      resolve(res);
    });
  });
}

async function localSettings() {
  return chrome.storage.local.get(LOCAL_DEFAULTS);
}

async function localApiKey() {
  const { localKey } = await chrome.storage.local.get({ localKey: '' });
  if (localKey) return localKey;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ localKey: key });
  return key;
}

async function enginePort(engine) {
  const s = await localSettings();
  return s[ENGINES[engine].portKey];
}

// 'ok' = pronto, 'loading' = carregando o modelo, 'off' = não responde
async function localHealth(engine, port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${ENGINES[engine].health}`, { signal: ctrl.signal, cache: 'no-store' });
    if (r.ok) return 'ok';
    if (r.status === 503) return 'loading';
    return 'error';
  } catch (_) {
    return 'off';
  } finally {
    clearTimeout(timer);
  }
}

async function localStatus(msg) {
  const s = await localSettings();
  const out = { engines: {}, installedBefore: s.localInstalled };
  await Promise.all(Object.keys(ENGINES).map(async e => {
    const port = s[ENGINES[e].portKey];
    out.engines[e] = { health: await localHealth(e, port), port, tag: ENGINES[e].tag, label: ENGINES[e].label };
  }));
  if (msg && msg.quick) return out;
  try {
    out.host = await nativeCall({ cmd: 'status' });
    out.hostOutdated = (out.host.hostVersion || 0) < HOST_VERSION;
    const installed = Object.values(out.host.engines || {}).some(x => x.runtime.installed && x.model.installed);
    if (installed !== s.localInstalled) await chrome.storage.local.set({ localInstalled: installed });
  } catch (e) {
    out.hostError = { code: e.code, error: e.message };
  }
  return out;
}

async function localInstall(msg) {
  const engine = engineOf(msg);
  const backend = String(msg.backend || '');
  const repo = String(msg.repo || (await localSettings())[ENGINES[engine].repoKey]).trim();
  await chrome.storage.local.set({ localBackend: backend, [ENGINES[engine].repoKey]: repo });
  return nativeCall({ cmd: 'install', engine, backend, repo, tag: ENGINES[engine].tag, quant: ENGINES[engine].quant });
}

async function localStart(msg) {
  const engine = engineOf(msg);
  const s = await localSettings();
  const r = await nativeCall({
    cmd: 'start',
    engine,
    port: s[ENGINES[engine].portKey],
    ctx: s.localCtx,
    parallel: s.localParallel,
    apiKey: await localApiKey(),
    origin: 'chrome-extension://' + chrome.runtime.id
  });
  return { started: !!r.started, already: !!r.already, pid: r.pid };
}

// Liga o servidor (se precisar) e espera ele carregar o modelo. Pedidos ao
// mesmo tempo (várias páginas na fila) esperam a mesma ligação.
const ensuring = {};
function ensureLocalServer(engine, opts) {
  if (!ensuring[engine]) {
    ensuring[engine] = ensureLocalServerOnce(engine, opts).finally(() => { ensuring[engine] = null; });
  }
  return ensuring[engine];
}

async function ensureLocalServerOnce(engine, { timeoutMs = 180000 } = {}) {
  const port = await enginePort(engine);
  if (await localHealth(engine, port) === 'ok') return;
  await localStart({ engine });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1000);
    if (await localHealth(engine, port) === 'ok') return;
  }
  throw err('LOCAL_TIMEOUT', `O ${ENGINES[engine].label} demorou demais para carregar o modelo.`);
}

// Chamada no formato da OpenAI (/v1/chat/completions).
async function localChat(engine, body, { timeoutMs = 180000 } = {}) {
  const port = await enginePort(engine);
  const headers = { 'content-type': 'application/json' };
  if (ENGINES[engine].auth) headers.authorization = 'Bearer ' + await localApiKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers,
      body: JSON.stringify(engine === 'llama' ? { model: LOCAL_MODEL_ALIAS, ...body } : body)
    });
  } catch (e) {
    throw err('LOCAL_OFF', ctrl.signal.aborted
      ? `O ${ENGINES[engine].label} demorou demais para responder.`
      : `O ${ENGINES[engine].label} está desligado. Ligue nas configurações (servidor local).`);
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return res.json();
  let detail = '';
  try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || ''; } catch (_) {}
  if (res.status === 401) throw err('LOCAL_AUTH', 'O servidor local recusou a chave. Desligue e ligue de novo nas configurações.');
  if (res.status === 503) throw err('LOCAL_LOADING', `O ${ENGINES[engine].label} ainda está carregando o modelo.`);
  throw err('LOCAL', `Erro do ${ENGINES[engine].label} (${res.status}): ${detail || 'sem detalhes'}`);
}

function chatText(data) {
  return String((((data.choices || [])[0] || {}).message || {}).content || '').trim();
}

// ---------- Etapa de leitura (OCR) de um recorte ----------

function ocrPrompt(src) {
  const lang = langName(src);
  return 'You read the text in comic speech bubbles (manhwa, manga, manhua, webtoons). ' +
    (lang ? `The text is written in ${lang}. ` : '') +
    'Reply with ONLY the exact text written in the image, in reading order, as one line. ' +
    'Do not translate, explain or describe the picture. If there is no readable text, reply exactly: NONE';
}

// image: data URL (PNG/JPEG) de um balão recortado.
async function localOcr(msg) {
  const engine = engineOf(msg);
  const { srcLang } = await getSettings();
  const t0 = Date.now();
  const body = {
    messages: [{ role: 'user', content: [
      { type: 'text', text: ocrPrompt(srcLang) },
      { type: 'image_url', image_url: { url: msg.image } }
    ] }],
    max_tokens: 160,                     // fala de balão é curta; limita se o modelo desandar
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false }
  };
  const data = await localChat(engine, body, { timeoutMs: 120000 });
  let text = chatText(data).replace(/^```\w*\s*|```$/g, '').replace(/\s+/g, ' ').replace(/^["“'`]+|["”'`]+$/g, '').trim();
  if (/^none\.?$/i.test(text)) text = '';
  return { text, ms: Date.now() - t0 };
}

// ---------- Etapa de tradução (só texto, um pedido por página) ----------

// Glossário da série e falas anteriores do capítulo (mesmo texto para todos os tradutores).
// small: modelo pequeno (llama.cpp no PC) se perde com pedido longo; manda só
// termos curtos (nomes, títulos) e as últimas falas.
function translationExtras(msg, small = false) {
  let out = '';
  let g = msg.glossary || [];
  if (small) g = g.filter(([o]) => String(o).split(/\s+/).length <= 3).slice(-15);
  if (g.length) {
    out += '\n\nGlossary from earlier chapters of this same series (names and terms). Keep these translations consistent:\n' +
      g.map(([o, t]) => `- ${o} => ${t}`).join('\n');
  }
  const ctx = (msg.context || []).filter(Boolean).slice(small ? -6 : -15);
  if (ctx.length) {
    out += '\n\nPrevious lines of this chapter, already translated (keep names and tone consistent):\n' +
      ctx.map(l => '- ' + String(l).replace(/\s+/g, ' ')).join('\n');
  }
  return out;
}

// Exemplos de tradução natural (não palavra por palavra), por idioma de saída.
const NATURAL_EXAMPLES = {
  'pt-BR': [
    ["You'd better leave now.", 'É melhor você ir embora agora.'],
    ["Where do you think you're going?", 'Aonde você pensa que vai?'],
    ["I'm gonna kick your ass!", 'Vou acabar com você!'],
    ['What the hell are you doing?', 'Que diabos você está fazendo?'],
    ["It's been a while, hyung.", 'Quanto tempo, hyung.']
  ],
  'pt-PT': [
    ["You'd better leave now.", 'É melhor ires embora agora.'],
    ["Where do you think you're going?", 'Aonde é que pensas que vais?'],
    ['What the hell are you doing?', 'Que raio estás a fazer?']
  ]
};

// Instruções do pedido de tradução (iguais para o llama.cpp, o Gemini e o Claude).
function translationSystem(s, n, msg, small = false) {
  const ex = NATURAL_EXAMPLES[s.dstLang] || [];
  return `You translate comic dialogue (manhwa, manga, manhua, webtoons) into ${s.targetLang}` +
    (s.sourceLang ? ` from ${s.sourceLang}` : '') + '. ' +
    'Translate the way a good fan translation group would: natural and fluent, keeping the tone (slang, swearing, jokes, formality), ' +
    'character names and honorifics such as -nim, hyung, oppa, noona, sunbae, -san, -kun. ' +
    `Write what a native ${s.targetLang} speaker would actually say, with correct grammar. Never translate word for word.` +
    (ex.length ? '\nExamples:\n' + ex.map(([o, t]) => `- "${o}" => "${t}"`).join('\n') + '\n' : ' ') +
    `You receive a JSON array with ${n} lines in reading order. Answer only with JSON {"t": [...]} holding exactly ${n} translations, in the same order. ` +
    'An empty line stays empty.' + translationExtras(msg, small);
}

// O mesmo pedido de tradução, pelo Gemini ou pelo Claude (pela internet).
async function cloudTranslateTexts(which, msg) {
  const texts = msg.texts;
  const s = await getSettings();
  const n = texts.length;
  const system = translationSystem(s, n, msg);
  let text;
  if (which === 'gemini') {
    if (!s.geminiKey) throw err('NO_KEY', 'Falta colocar sua chave do Gemini nas configurações da extensão.');
    const model = s.geminiModel || DEFAULTS.geminiModel;
    const data = await postGemini(model, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(texts) }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096 }
    }, s.geminiKey);
    await addUsage(model, data.usageMetadata);
    text = geminiText(data);
  } else {
    if (!s.apiKey) throw err('NO_KEY', 'Falta colocar sua chave da API do Claude nas configurações da extensão.');
    const model = (s.customModel || '').trim() || s.model || DEFAULTS.model;
    const data = await postMessages({
      model, max_tokens: 4096, system,
      messages: [{ role: 'user', content: JSON.stringify(texts) }]
    }, s.apiKey);
    await addUsage(model, data.usage);
    text = (data.content || []).map(c => c.text || '').join('');
  }
  const parsed = parseJsonLoose(text);
  const out = parsed && Array.isArray(parsed.t) ? parsed.t.map(x => String(x || '').trim()) : [];
  if (out.length !== n) throw err('API', `O ${which === 'gemini' ? 'Gemini' : 'Claude'} devolveu um número errado de traduções.`);
  return out;
}

// Traduz as falas lidas no modo "No seu PC", com o tradutor escolhido, e
// guarda na memória da série.
async function translateTexts(msg) {
  const texts = (msg.texts || []).map(t => String(t || ''));
  if (!texts.length) return { texts: [] };
  const s = await getSettings();
  const translator = msg.translator || s.localTranslator;
  const memKey = s.useMemory ? seriesKeyOf(msg.pageUrl) : null;
  const extras = { context: (msg.context || []).slice(-15), glossary: memKey ? await glossaryFor(memKey) : [] };
  let out;
  if (translator === 'llama') {
    await ensureLocalServer('llama');
    out = (await localTranslateTexts({ texts, ...extras })).texts;
  } else if (translator === 'gemini' || translator === 'claude') {
    out = await cloudTranslateTexts(translator, { texts, ...extras });
  } else {
    out = (await googleTranslate({ texts })).texts;
  }
  out = out.map((t, i) => (texts[i].trim() ? t : ''));   // linha vazia continua vazia
  if (memKey) await remember(memKey, texts.map((o, i) => ({ original: o, text: out[i], kind: 'dialogue' })));
  return { texts: out };
}

async function localTranslateTexts(msg) {
  const texts = (msg.texts || []).map(t => String(t || ''));
  if (!texts.length) return { texts: [] };
  const s = await getSettings();
  const t0 = Date.now();
  const n = texts.length;
  const schema = {
    type: 'object',
    properties: { t: { type: 'array', items: { type: 'string' }, minItems: n, maxItems: n } },
    required: ['t']
  };
  const system = translationSystem(s, n, msg, true);
  const data = await localChat('llama', {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(texts) }
    ],
    temperature: 0.2,
    max_tokens: Math.min(4096, 200 + texts.join(' ').length * 3),
    response_format: { type: 'json_schema', json_schema: { name: 'traducoes', schema, strict: true } },
    chat_template_kwargs: { enable_thinking: false }
  });
  const parsed = parseJsonLoose(chatText(data));
  const out = parsed && Array.isArray(parsed.t) ? parsed.t.map(x => String(x || '').trim()) : [];
  if (out.length !== n) throw err('LOCAL', 'O modelo local devolveu um número errado de traduções.');
  return { texts: out, ms: Date.now() - t0 };
}

async function localTest(msg) {
  const engine = engineOf(msg);
  const t0 = Date.now();
  const data = await localChat(engine, {
    messages: [{ role: 'user', content: `Translate to ${(await getSettings()).targetLang} and reply with only the translation: "Where are you going?"` }],
    max_tokens: 40,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false }
  }, { timeoutMs: 120000 });
  const t = data.timings || {};
  return {
    reply: chatText(data),
    ms: Date.now() - t0,
    tokensPerSecond: t.predicted_per_second ? Math.round(t.predicted_per_second) : null
  };
}

// ---------- Comparação de leitores de texto ----------

// Lê um recorte com o leitor pedido: llama, tesseract ou nano.
async function ocrCrop(msg) {
  const t0 = Date.now();
  if (msg.engine === 'llama') return localOcr(msg);
  if (msg.engine === 'tesseract') {
    const r = await ocr({ image: msg.image, mode: 'block' });
    const groups = cleanGroups(r.lines, 40, ocrOptsFor((await getSettings()).srcLang));
    return { text: groups.map(g => g.original).join(' '), ms: Date.now() - t0 };
  }
  if (msg.engine === 'nano') {
    const r = await HANDLERS.nanoRead(msg);
    const text = String(r.text || '').replace(/\s+/g, ' ').trim();
    return { text: /^none\b/i.test(text) ? '' : text, ms: Date.now() - t0 };
  }
  throw err('BAD_ARGS', 'Leitor desconhecido: ' + msg.engine);
}

const LOCAL_HANDLERS = {
  localStatus,
  localInstall,
  localStart,
  localStop: msg => nativeCall({ cmd: 'stop', engine: engineOf(msg) }),
  localCancelInstall: () => nativeCall({ cmd: 'cancelInstall' }),
  localInstallVc: () => nativeCall({ cmd: 'installVc' }),
  localLog: msg => nativeCall({ cmd: 'log', engine: engineOf(msg), which: msg.which === 'install' ? 'install' : 'server', lines: 80 }),
  localUninstall: async () => {
    const r = await nativeCall({ cmd: 'uninstall' });
    await chrome.storage.local.set({ localInstalled: false });
    return r;
  },
  localTest,
  localOcr,
  localTranslateTexts,
  ocrCrop,
  translateTexts,
  // liga os servidores pedidos (em paralelo) e espera os modelos carregarem
  localEnsure: async msg => {
    const engines = (msg.engines || []).filter(e => ENGINES[e]);
    await Promise.all(engines.map(e => ensureLocalServer(e)));
    return { engines };
  }
};
