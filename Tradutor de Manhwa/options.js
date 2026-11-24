const $ = id => document.getElementById(id);

const DEFAULTS = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-3.6-flash',
  apiKey: '',
  model: 'claude-haiku-5-5',
  customModel: '',
  srcLang: 'en',
  dstLang: null,           // null = ainda não migrou do campo antigo (targetLang, texto livre)
  targetLang: '',
  useCache: true,
  useMemory: true,
  prefetchNext: true,
  reviewPass: true,
  localTranslator: 'llama'
};

const HINTS = {
  'claude-haiku-5-5': 'Custo estimado: uns US$ 0,025 por capítulo (US$ 5 ≈ 190 capítulos).',
  'claude-sonnet-5-5': 'Custo estimado: uns US$ 0,40 por capítulo.',
  'claude-opus-5-5': 'Custo estimado: uns US$ 0,80 por capítulo.'
};

function fillLangs(sel, codes, value) {
  sel.textContent = '';
  for (const c of codes) sel.add(new Option(LANGS[c].label, c));
  sel.value = codes.includes(value) ? value : codes[0];
}

function mtPair() {
  return { sourceLanguage: langMt($('srcLang').value), targetLanguage: langMt($('dstLang').value) };
}

function refreshLangHint() {
  const src = $('srcLang').value, dst = $('dstLang').value;
  $('mtPair').textContent = `(${LANGS[src].label.toLowerCase()} → ${LANGS[dst].label.toLowerCase()})`;
  const notes = [];
  if (src === 'auto') notes.push('"Detectar sozinho" funciona bem com Gemini, Claude e o servidor local. No modo Google, o leitor de texto assume inglês.');
  if (['ko', 'ja', 'zh', 'zh-Hant'].includes(src)) notes.push('Para coreano, japonês e chinês, o leitor de texto do modo Google erra bastante (principalmente texto na vertical). Prefira Gemini, Claude ou o servidor local.');
  if (src !== 'auto' && src === dst) notes.push('A entrada e a saída estão no mesmo idioma.');
  $('langHint').textContent = notes.join(' ');
}

function provider() {
  const r = document.querySelector('input[name=provider]:checked');
  return r ? r.value : 'gemini';
}

// ---------- Abas Local / Cloud ----------

const CLOUD_PROVIDERS = ['gemini', 'claude'];
const PROVIDER_NAMES = {
  local: 'Servidor local (llama.cpp)',
  nano: 'Gemini Nano (IA do Chrome)',
  google: 'Leitor de texto + Google Tradutor',
  gemini: 'Gemini',
  claude: 'Claude'
};
const TRANSLATOR_NAMES = { llama: 'llama.cpp', gemini: 'Gemini', claude: 'Claude', google: 'Google Tradutor' };

const tabOf = p => (CLOUD_PROVIDERS.includes(p) ? 'cloud' : 'local');

function showTab(tab) {
  for (const t of ['local', 'cloud']) {
    $('tab-' + t).setAttribute('aria-selected', String(t === tab));
    $('panel-' + t).hidden = t !== tab;
  }
  // #aba-local / #aba-cloud: não pode ser igual a um id da página, senão o navegador rola até ele
  history.replaceState(null, '', '#aba-' + tab);
}

let saved = null;   // o que está salvo (o que a extensão usa de verdade)

function describe(p, translator) {
  return PROVIDER_NAMES[p] + (p === 'local' ? ` · traduz com ${TRANSLATOR_NAMES[translator]}` : '');
}

document.querySelectorAll('.tab').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });

// Link para a outra aba dentro de um texto ("chave na aba Cloud").
function tabLink(tab, text) {
  const a = document.createElement('a');
  a.href = '#aba-' + tab;
  a.textContent = text;
  a.onclick = e => { e.preventDefault(); showTab(tab); window.scrollTo(0, 0); };
  return a;
}

function refreshView() {
  const p = provider();
  const lt = $('localTranslator').value;

  // aba que está em uso
  const inUse = saved ? saved.provider : p;
  for (const t of ['local', 'cloud']) $('tab-' + t).classList.toggle('active-provider', tabOf(inUse) === t);
  const cur = $('current');
  cur.textContent = 'Em uso agora: ';
  const b = document.createElement('b');
  b.textContent = saved ? describe(saved.provider, saved.localTranslator) : describe(p, lt);
  cur.append(b, ` (aba ${tabOf(inUse) === 'cloud' ? 'Cloud' : 'Local'}).`);
  const chosen = describe(p, lt);
  if (saved && chosen !== b.textContent) cur.append(` Você escolheu ${chosen}: clique em "Salvar e testar" para trocar.`);

  // aba Local: só mostra a seção do modo escolhido
  $('sec-local').hidden = p !== 'local';
  $('sec-nano').hidden = p !== 'nano';
  $('sec-google').hidden = !(p === 'google' || p === 'nano');
  if (p === 'google' || p === 'nano') checkGoogle();
  if (p === 'nano') checkNano();
  if (p === 'local') {
    const hint = $('localHint');
    hint.textContent = {
      llama: 'Tudo no seu PC: só precisa do llama.cpp instalado (abaixo).',
      gemini: 'O texto lido vai para o Gemini traduzir (só o texto, sem a imagem). A chave fica na ',
      claude: 'O texto lido vai para o Claude traduzir (só o texto, sem a imagem). A chave fica na ',
      google: 'O texto lido vai para o Google Tradutor. Tradução mais literal.'
    }[lt];
    if (lt === 'gemini' || lt === 'claude') hint.append(tabLink('cloud', 'aba Cloud'), '.');
  }

  // aba Cloud: as duas chaves ficam sempre à mostra; avisa quando o modo local usa uma delas
  const note = $('cloudNote');
  note.hidden = !(p === 'local' && (lt === 'gemini' || lt === 'claude'));
  if (!note.hidden) {
    note.textContent = `O modo Servidor local (aba Local) está usando o ${TRANSLATOR_NAMES[lt]} para traduzir: só a chave dele precisa estar preenchida aqui.`;
  }
  $('costHint').textContent = $('customModel').value.trim() ? '' : (HINTS[$('model').value] || '');
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  saved = { provider: s.provider, localTranslator: s.localTranslator };
  document.querySelector(`input[name=provider][value=${s.provider}]`).checked = true;
  $('geminiKey').value = s.geminiKey;
  $('geminiModel').value = s.geminiModel;
  if (!$('geminiModel').value) $('geminiModel').value = DEFAULTS.geminiModel;
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  if (!$('model').value) $('model').value = DEFAULTS.model;
  $('customModel').value = s.customModel;
  fillLangs($('srcLang'), SOURCE_LANGS, LANGS[s.srcLang] ? s.srcLang : 'en');
  fillLangs($('dstLang'), TARGET_LANGS, s.dstLang || migrateTargetLang(s.targetLang));
  $('useCache').checked = s.useCache;
  $('useMemory').checked = s.useMemory;
  $('prefetchNext').checked = s.prefetchNext;
  $('reviewPass').checked = s.reviewPass;
  $('localTranslator').value = s.localTranslator;
  refreshView();
  refreshLangHint();
  // #aba-local / #aba-cloud abrem a aba; #local (link do ícone da extensão) abre a aba Local já no servidor
  const want = location.hash.slice(1);
  const tab = { 'aba-cloud': 'cloud', cloud: 'cloud', 'aba-local': 'local', local: 'local' }[want] || tabOf(s.provider);
  showTab(tab);
  if (want === 'local') requestAnimationFrame(() => document.getElementById('local').scrollIntoView());
}

function setMsg(text, cls) {
  $('msg').textContent = text;
  $('msg').className = cls || '';
}

async function save() {
  const values = {
    provider: provider(),
    geminiKey: $('geminiKey').value.trim(),
    geminiModel: $('geminiModel').value,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    customModel: $('customModel').value.trim(),
    srcLang: $('srcLang').value,
    dstLang: $('dstLang').value,
    useCache: $('useCache').checked,
    useMemory: $('useMemory').checked,
    prefetchNext: $('prefetchNext').checked,
    reviewPass: $('reviewPass').checked,
    localTranslator: $('localTranslator').value
  };
  await chrome.storage.local.set(values);
  saved = { provider: values.provider, localTranslator: values.localTranslator };
  refreshView();
  if (values.provider === 'local') {
    let st = null;
    try { st = await chrome.runtime.sendMessage({ type: 'localStatus' }); } catch (_) {}
    const need = ['llama'];
    const names = { llama: 'llama.cpp' };
    const missing = st && st.host ? need.filter(e => !(st.host.engines[e].runtime.installed && st.host.engines[e].model.installed)) : need;
    const keyMissing = (values.localTranslator === 'gemini' && !values.geminiKey) || (values.localTranslator === 'claude' && !values.apiKey);
    if (!st || !st.host) setMsg('Salvo. Falta instalar o ajudante do servidor local (passo 5).', 'bad');
    else if (missing.length) setMsg('Salvo. Falta instalar no passo 5: ' + missing.map(e => names[e]).join(' e ') + '.', 'bad');
    else if (keyMissing) setMsg('Salvo. Falta a chave do ' + (values.localTranslator === 'gemini' ? 'Gemini' : 'Claude') + '.', 'bad');
    else setMsg('Tudo certo! Ao traduzir, a extensão liga os servidores sozinha.', 'ok');
    return;
  }
  if (values.provider === 'nano') {
    const ok = await checkNano();
    setMsg(ok ? 'Tudo certo! Pode ir ler.' : 'Salvo. Falta baixar o Gemini Nano (passo 2).', ok ? 'ok' : 'bad');
    return;
  }
  if (values.provider === 'google') {
    const ok = await checkGoogle();
    setMsg(ok ? 'Tudo certo! Pode ir ler.' : 'Salvo. Falta instalar o leitor de texto (passo 2).', ok ? 'ok' : 'bad');
    return;
  }
  const key = values.provider === 'gemini' ? values.geminiKey : values.apiKey;
  if (!key) { setMsg('Salvo. Falta a chave.', 'bad'); return; }

  setMsg('Salvo. Testando a chave…', 'muted');
  const r = await chrome.runtime.sendMessage({ type: 'testKey' });
  if (r && r.ok) setMsg(`Tudo certo! O ${r.model} respondeu. Pode ir ler.`, 'ok');
  else setMsg('⚠ ' + ((r && r.error) || 'Não consegui testar.'), 'bad');
}

async function checkGoogle() {
  let installed = false;
  try { installed = !!(await chrome.runtime.sendMessage({ type: 'ocrStatus', lang: langTess($('srcLang').value) })).installed; } catch (_) {}
  $('ocrStatus').textContent = installed ? '✅ instalado' : '❌ falta instalar (siga os passos abaixo)';
  $('ocrSteps').hidden = installed;
  let mt = 'unavailable';
  if ('Translator' in window) {
    if ($('srcLang').value !== 'auto') {
      try { mt = await Translator.availability(mtPair()); } catch (_) {}
    }
  }
  $('mtStatus').textContent = mt === 'available' ? '✅ pronto' :
    mt === 'unavailable' ? 'não disponível neste Chrome (vai usar o Google Tradutor pela internet)' :
    'falta baixar (botão abaixo)';
  $('mtRow').hidden = !(mt === 'downloadable' || mt === 'downloading');
  return installed;
}

$('ocrDownload').onclick = async () => {
  $('ocrStatus').textContent = 'baixando para a pasta Downloads…';
  const r = await chrome.runtime.sendMessage({ type: 'downloadOcr', lang: langTess($('srcLang').value) });
  $('ocrStatus').textContent = r && r.ok
    ? '⬇️ baixado em Downloads\\tesseract. Agora faça os passos 2, 3 e 4.'
    : '⚠ não deu para baixar: ' + ((r && r.error) || 'erro');
};
$('ocrRecheck').onclick = () => checkGoogle();

async function checkNano() {
  let a = 'unavailable';
  if ('LanguageModel' in window) {
    try { a = await LanguageModel.availability({ expectedInputs: [{ type: 'image' }] }); } catch (_) {}
  }
  $('nanoStatus').textContent = a === 'available' ? '✅ pronto' :
    a === 'downloading' ? 'baixando…' :
    a === 'downloadable' ? 'falta baixar (botão abaixo)' :
    '❌ este PC ou este Chrome não roda o Gemini Nano';
  $('nanoRow').hidden = !(a === 'downloadable' || a === 'downloading');
  return a === 'available';
}

$('nanoDownload').onclick = async () => {
  $('nanoStatus').textContent = 'baixando… 0%';
  try {
    const s = await LanguageModel.create({
      expectedInputs: [{ type: 'image' }, { type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
      monitor(m) { m.addEventListener('downloadprogress', e => { $('nanoStatus').textContent = `baixando… ${Math.round(e.loaded * 100)}%`; }); }
    });
    s.destroy();
    $('nanoStatus').textContent = '✅ pronto';
    $('nanoRow').hidden = true;
  } catch (e) {
    $('nanoStatus').textContent = '⚠ não deu para baixar: ' + e.message;
  }
};
$('mtDownload').onclick = async () => {
  $('mtStatus').textContent = 'baixando… 0%';
  try {
    await Translator.create({
      ...mtPair(),
      monitor(m) { m.addEventListener('downloadprogress', e => { $('mtStatus').textContent = `baixando… ${Math.round(e.loaded * 100)}%`; }); }
    });
    $('mtStatus').textContent = '✅ pronto';
    $('mtRow').hidden = true;
  } catch (e) {
    $('mtStatus').textContent = 'não deu para baixar agora (' + e.message + '). Vai usar o Google Tradutor pela internet.';
  }
};

$('save').onclick = save;
$('srcLang').onchange = () => { refreshLangHint(); if (!$('sec-google').hidden) checkGoogle(); };
$('dstLang').onchange = () => { refreshLangHint(); if (!$('sec-google').hidden) checkGoogle(); };
document.querySelectorAll('input[name=provider]').forEach(r => r.onchange = refreshView);
$('model').onchange = refreshView;
$('localTranslator').onchange = refreshView;
$('customModel').oninput = refreshView;
document.querySelectorAll('button.show').forEach(b => {
  b.onclick = () => {
    const i = $(b.dataset.for);
    i.type = i.type === 'password' ? 'text' : 'password';
    b.textContent = i.type === 'password' ? 'Mostrar' : 'Esconder';
  };
});
$('clearCache').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'clearCache' });
  $('cacheMsg').textContent = r && r.ok ? `${r.removed} traduções apagadas.` : 'Não deu para apagar.';
};

// ---------- Servidor local (llama.cpp) ----------

const L_PHASES = {
  start: 'Começando a instalação…',
  runtime: 'Baixando o programa',
  extract: 'Descompactando',
  model: 'Baixando o modelo',
  vc: 'Instalando o runtime do Visual C++'
};

const L_INSTALL_ERRORS = {
  NETWORK: 'O download falhou. Confira a internet e clique em "Baixar e instalar" de novo: ele continua de onde parou.',
  NO_GGUF: 'Esse repositório do Hugging Face não tem um modelo .gguf.',
  NOT_FOUND: 'Um dos arquivos não existe mais no servidor de download.',
  HTTP: 'O Hugging Face ou o GitHub recusou o pedido. Confira se o nome do repositório está certo.',
  VC_DENIED: 'O Windows não deixou instalar o runtime do Visual C++ (permissão de administrador negada).',
  INTERRUPTED: 'A instalação parou no meio. Clique em "Baixar e instalar" para continuar de onde parou.',
  CANCELED: 'Download cancelado. Clique em "Baixar e instalar" para continuar de onde parou.'
};

const L_ENGINE_NAMES = { llama: 'llama.cpp' };
const L_BACKENDS = { vulkan: 'Vulkan', cuda: 'CUDA', cpu: 'só processador' };

let lTimer = null;
let lTouched = false;     // o usuário mexeu nas escolhas: não sobrescrever com o que está instalado
let lSample = null;       // última leitura do progresso, para calcular a velocidade
let lGpu;                 // undefined = ainda não detectou

const eBox = engine => document.querySelector(`.engine[data-engine="${engine}"]`);
const eEl = (engine, cls) => eBox(engine).querySelector('.' + cls);

function lBytes(n) {
  if (!n) return '0 MB';
  return n >= 1e9
    ? (n / 1e9).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' GB'
    : Math.round(n / 1e6) + ' MB';
}

function lRepo() {
  return $('lModel').value === 'custom' ? $('lModelCustom').value.trim() : $('lModel').value;
}

function lSetRepo(repo) {
  const known = [...$('lModel').options].some(o => o.value === repo);
  $('lModel').value = known ? repo : 'custom';
  $('lModelCustom').hidden = known;
  if (!known) $('lModelCustom').value = repo;
}

function lModelName(repo) {
  const o = [...$('lModel').options].find(x => x.value === repo);
  return o ? o.textContent.split(' · ')[0] : repo;
}

async function lDetectGpu() {
  if (lGpu !== undefined) return lGpu;
  lGpu = null;
  try {
    const a = navigator.gpu && await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const info = (a && a.info) || {};
    if (a && !info.isFallbackAdapter && !a.isFallbackAdapter) {
      lGpu = { vendor: info.vendor || 'desconhecida', desc: info.description || info.architecture || '' };
    }
  } catch (_) {}
  return lGpu;
}

async function lCall(type, extra) {
  const r = await chrome.runtime.sendMessage({ type, ...(extra || {}) });
  if (!r || !r.ok) throw Object.assign(new Error((r && r.error) || 'Sem resposta da extensão.'), { code: r && r.code });
  return r;
}

function lSchedule(ms) {
  clearTimeout(lTimer);
  lTimer = setTimeout(refreshLocal, ms);
}

async function refreshLocal() {
  let st;
  try {
    st = await lCall('localStatus');
  } catch (e) {
    st = { engines: {}, hostError: { code: e.code, error: e.message } };
  }
  await renderLocal(st);
}

function renderProgress(inst) {
  $('lProgressRow').hidden = false;
  const pct = inst.total ? inst.done / inst.total : 0;
  $('lProgress').value = pct;
  let text = (L_ENGINE_NAMES[inst.engine] ? L_ENGINE_NAMES[inst.engine] + ' · ' : '') + (inst.label || '');
  if (inst.total) text += ` · ${lBytes(inst.done)} de ${lBytes(inst.total)} (${Math.floor(pct * 100)}%)`;
  if (inst.steps > 1) text += ` · arquivo ${inst.step} de ${inst.steps}`;
  const now = Date.now();
  if (lSample && lSample.label === inst.label && inst.done > lSample.done) {
    const speed = (inst.done - lSample.done) / ((now - lSample.t) / 1000);
    if (speed > 0) {
      text += ` · ${lBytes(speed)}/s`;
      if (inst.total) {
        const left = Math.round((inst.total - inst.done) / speed);
        text += left > 90 ? ` · faltam ~${Math.round(left / 60)} min` : ` · faltam ~${left} s`;
      }
    }
  }
  lSample = { label: inst.label, done: inst.done, t: now };
  $('lProgressText').textContent = text;
}

// Devolve true se o servidor deste motor está ligando (para atualizar mais rápido).
function renderEngine(engine, he, hs, installing, vulkanOk) {
  const dot = eBox(engine).querySelector('h3 .dot');
  dot.className = 'dot';
  const ready = hs.runtime.installed && hs.model.installed;
  const up = he.health === 'ok';
  const starting = !up && (he.health === 'loading' || hs.server.running);
  let text;
  if (up) { dot.classList.add('on'); text = 'Ligado'; }
  else if (starting) { dot.classList.add('busy'); text = 'Ligando… carregando o modelo'; }
  else if (ready) text = 'Instalado · desligado';
  else text = 'Não instalado';
  if (ready) {
    const model = engine === 'llama' ? `${lModelName(hs.model.repo)} (${hs.model.file})` : hs.model.file;
    text += ` · ${model} · llama.cpp ${hs.runtime.tag} · ${L_BACKENDS[hs.runtime.backend] || hs.runtime.backend} · porta ${he.port}`;
    if (engine === 'llama' && !hs.model.vision) text += ' · ⚠ este modelo não lê imagens (sem mmproj)';
    if (hs.runtime.backend === 'vulkan' && vulkanOk === false) {
      text += engine === 'llama'
        ? ' · ⚠ o Vulkan deste PC é antigo: o llama.cpp está rodando no processador'
        : ' · ⚠ não abre com Vulkan neste PC: escolha "Sem placa de vídeo" acima e clique em "Atualizar"';
    }
  }
  eEl(engine, 'estatus').textContent = text;
  const b = cls => eEl(engine, cls);
  b('eInstall').disabled = installing;
  b('eInstall').textContent = ready ? (engine === 'llama' ? 'Atualizar / trocar modelo' : 'Atualizar') : 'Baixar e instalar';
  b('eStart').disabled = !ready || up || starting;
  b('eStop').disabled = !(up || starting);
  b('eTest').disabled = !up;
  return starting;
}

// Vulkan antigo (driver da placa de vídeo): o ggml precisa da versão 1.2 ou mais nova.
let lVulkan = null;
function lVulkanHint(h) {
  if (h) lVulkan = { ok: h.vulkanOk, version: h.vulkanLoader };
  let warn = $('lVulkanWarn');
  if (!warn) { warn = document.createElement('p'); warn.id = 'lVulkanWarn'; warn.className = 'bad'; $('lGpuHint').after(warn); }
  const bad = lVulkan && lVulkan.ok === false && $('lBackend').value === 'vulkan';
  warn.hidden = !bad;
  if (bad) {
    warn.textContent = lVulkan.version
      ? `⚠ O Vulkan deste PC é da versão ${lVulkan.version} e o llama.cpp precisa da 1.2 ou mais nova para usar a placa (senão roda no processador). Escolha "Sem placa de vídeo" ou atualize o driver da placa de vídeo.`
      : '⚠ Este PC não tem Vulkan. Escolha "Sem placa de vídeo" ou instale o driver da placa de vídeo.';
  }
}

async function renderLocal(st) {
  const h = st.host, he = st.hostError;
  const dot = $('lDot');
  dot.className = 'dot';
  $('lHostSteps').hidden = true;
  $('lConfig').hidden = true;
  $('lProgressRow').hidden = true;
  $('lError').hidden = true;
  $('lVc').hidden = true;

  if (he) {
    if (he.code !== 'NO_HOST') dot.classList.add('err');
    $('lTitle').textContent = he.code === 'NO_HOST' ? 'Falta instalar o ajudante' : 'O ajudante não respondeu';
    $('lDetail').textContent = he.code === 'NO_HOST' ? 'Siga os passos abaixo. É só uma vez.' : he.error;
    $('lHostSteps').hidden = false;
    lSchedule(he.code === 'NO_HOST' ? 5000 : 10000);
    return;
  }

  $('lConfig').hidden = false;
  const inst = h.install;
  const installing = !!(inst && !inst.finished);

  if (!lTouched) {
    const saved = await chrome.storage.local.get({ localBackend: '', localRepo: 'ggml-org/Qwen3.5-4B-GGUF' });
    const gpu = await lDetectGpu();
    const installedBackend = h.engines.llama.runtime.backend;
    $('lBackend').value = installedBackend || saved.localBackend || (gpu && h.vulkanOk !== false ? 'vulkan' : 'cpu');
    lSetRepo(h.engines.llama.model.repo || saved.localRepo);
    $('lGpuHint').textContent = gpu
      ? `Placa de vídeo encontrada: ${gpu.vendor}${gpu.desc ? ' (' + gpu.desc + ')' : ''}.` + (gpu.vendor === 'nvidia' ? ' Vulkan já funciona; CUDA costuma ser um pouco mais rápido.' : '')
      : 'Não achei uma placa de vídeo que o Chrome reconheça. Se você tiver uma, escolha Vulkan.';
  }

  let starting = false;
  for (const e of ['llama']) {
    if (renderEngine(e, st.engines[e], h.engines[e], installing, h.vulkanOk)) starting = true;
  }
  lVulkanHint(h);

  // ajudante instalado é de uma versão antiga: precisa rodar o instalador de novo
  if (st.hostOutdated) {
    $('lHostSteps').hidden = false;
    $('lHostIntro').textContent = 'Esta versão da extensão trouxe um ajudante novo. Baixe e rode o instalador de novo (não perde os modelos já baixados):';
  }
  const anyUp = Object.values(st.engines).some(x => x.health === 'ok');
  const anyReady = Object.values(h.engines).some(x => x.runtime.installed && x.model.installed);

  let next = 10000;
  if (installing) {
    dot.classList.add('busy');
    $('lTitle').textContent = L_PHASES[inst.phase] || 'Instalando…';
    $('lDetail').textContent = 'Pode fechar esta aba: o download continua. Se o PC desligar, ele continua de onde parou.';
    renderProgress(inst);
    next = 1500;
  } else {
    lSample = null;
    if (anyUp) dot.classList.add('on');
    else if (starting) dot.classList.add('busy');
    $('lTitle').textContent = anyUp ? 'Ligado' : starting ? 'Ligando…' : anyReady ? 'Instalado · desligado' : 'Ajudante pronto · nada instalado ainda';
    $('lDetail').textContent = `Espaço livre no disco: ${lBytes(h.freeBytes)}. Pasta: ${h.root}`;
    if (starting) next = 1500;
  }
  $('lCancel').hidden = !installing;

  const errs = [];
  if (inst && inst.finished && inst.error) errs.push((L_ENGINE_NAMES[inst.engine] ? L_ENGINE_NAMES[inst.engine] + ': ' : '') + (L_INSTALL_ERRORS[inst.code] || inst.error));
  const vcMissing = !h.vcRuntime && !Object.values(h.engines).some(x => x.runtime.vcRuntime);
  if (vcMissing) { errs.push('Falta o runtime do Visual C++ no Windows (os servidores precisam dele para abrir).'); $('lVc').hidden = false; }
  if (errs.length) { $('lError').hidden = false; $('lError').textContent = '⚠ ' + errs.join(' '); }
  lSchedule(next);
}

async function lAction(btn, msgEl, type, extra, okText) {
  btn.disabled = true;
  msgEl.classList.remove('bad');
  msgEl.classList.add('muted');
  msgEl.textContent = 'Aguarde…';
  try {
    const r = await lCall(type, extra);
    msgEl.textContent = typeof okText === 'function' ? okText(r) : (okText || '');
  } catch (e) {
    msgEl.classList.remove('muted');
    msgEl.classList.add('bad');
    msgEl.textContent = '⚠ ' + e.message;
  }
  await refreshLocal();
}

async function lDownloadHostInstaller() {
  const btn = $('lHostDownload');
  btn.disabled = true;
  try {
    const [tpl, hostPs, instPs] = await Promise.all(
      ['servidor/instalador.bat.tpl', 'servidor/host.ps1', 'servidor/instalar.ps1'].map(async f => {
        const r = await fetch(chrome.runtime.getURL(f));
        if (!r.ok) throw new Error('faltou o arquivo ' + f + ' na pasta da extensão');
        return r.text();
      }));
    const b64 = s => {
      const bytes = new TextEncoder().encode(s);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    };
    const text = tpl
      .replace('__EXT_ID__', () => chrome.runtime.id)
      .replace('__HOST_PS1__', () => b64(hostPs))
      .replace('__INSTALAR_PS1__', () => b64(instPs))
      .replace(/\r?\n/g, '\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
    const id = await chrome.downloads.download({ url, filename: 'instalar-servidor-tradutor.bat', conflictAction: 'overwrite', saveAs: false });
    const onChanged = d => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') { chrome.downloads.show(id); }
      if (d.state.current !== 'in_progress') { chrome.downloads.onChanged.removeListener(onChanged); URL.revokeObjectURL(url); }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  } catch (e) {
    alert('Não consegui gerar o instalador: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

$('lHostDownload').onclick = lDownloadHostInstaller;
$('lRecheck').onclick = refreshLocal;
$('lBackend').onchange = () => { lTouched = true; lVulkanHint(); };
$('lModel').onchange = () => {
  lTouched = true;
  $('lModelCustom').hidden = $('lModel').value !== 'custom';
  if (!$('lModelCustom').hidden) $('lModelCustom').focus();
};
$('lModelCustom').oninput = () => { lTouched = true; };
$('lCancel').onclick = () => lAction($('lCancel'), $('lProgressText'), 'localCancelInstall', null, 'Download cancelado.');
$('lVc').onclick = () => lAction($('lVc'), $('lDetail'), 'localInstallVc', null, 'O Windows vai pedir permissão de administrador para instalar o Visual C++.');

for (const engine of ['llama']) {
  const msgEl = eEl(engine, 'emsg');
  eEl(engine, 'eInstall').onclick = () => {
    const repo = lRepo();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      msgEl.classList.add('bad');
      msgEl.textContent = '⚠ Escreva o repositório no formato dono/nome, por exemplo ggml-org/Qwen3-VL-2B-Instruct-GGUF.';
      return;
    }
    lTouched = false;
    lAction(eEl(engine, 'eInstall'), msgEl, 'localInstall', { engine, backend: $('lBackend').value, repo }, 'Download começou.');
  };
  eEl(engine, 'eStart').onclick = () => lAction(eEl(engine, 'eStart'), msgEl, 'localStart', { engine },
    r => r.already ? 'Já estava ligado.' : 'Ligando… o modelo leva alguns segundos para carregar.');
  eEl(engine, 'eStop').onclick = () => lAction(eEl(engine, 'eStop'), msgEl, 'localStop', { engine }, 'Desligado.');
  eEl(engine, 'eTest').onclick = () => lAction(eEl(engine, 'eTest'), msgEl, 'localTest', { engine }, r =>
    `✅ Respondeu "${r.reply}" em ${(r.ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s` +
    (r.tokensPerSecond ? ` (${r.tokensPerSecond} tokens/s).` : '.'));
  eEl(engine, 'eLog').onclick = async () => {
    const pre = eEl(engine, 'elog');
    if (!pre.hidden) { pre.hidden = true; return; }
    try {
      const r = await lCall('localLog', { engine, which: 'server' });
      pre.textContent = r.text || '(vazio: o servidor ainda não foi ligado)';
    } catch (e) {
      pre.textContent = '⚠ ' + e.message;
    }
    pre.hidden = false;
  };
}

$('lInstallLog').onclick = async () => {
  const pre = $('lLogText');
  if (!pre.hidden) { pre.hidden = true; return; }
  try {
    const r = await lCall('localLog', { which: 'install' });
    pre.textContent = r.text || '(vazio)';
  } catch (e) {
    pre.textContent = '⚠ ' + e.message;
  }
  pre.hidden = false;
};
$('lUninstall').onclick = () => {
  if (!confirm('Isso desliga os servidores e apaga o llama.cpp, os modelos baixados e o ajudante deste PC. Continuar?')) return;
  lAction($('lUninstall'), $('lDetail'), 'localUninstall', null, 'Desinstalado.');
};

refreshLocal();

$('clearMemory').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'clearMemory' });
  $('cacheMsg').textContent = r && r.ok ? `Memória de ${r.removed} ${r.removed === 1 ? 'série apagada' : 'séries apagadas'}.` : 'Não deu para apagar.';
};

load();
