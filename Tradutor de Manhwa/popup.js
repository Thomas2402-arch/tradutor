const $ = id => document.getElementById(id);
let tab = null;

async function sendToTab(msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (_) {
    // página aberta antes de instalar a extensão: injeta o script e tenta de novo
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib.js', 'content.js'] });
    return chrome.tabs.sendMessage(tab.id, msg);
  }
}

function money(usd) {
  if (!usd) return 'US$ 0,00';
  if (usd < 0.01) return 'menos de US$ 0,01';
  return 'US$ ' + usd.toFixed(2).replace('.', ',');
}

let isGemini = true;
let providerName = 'Gemini grátis';

async function refresh() {
  const { stats } = await chrome.runtime.sendMessage({ type: 'getStats' });
  if (stats) {
    const n = stats.calls || 0;
    if (providerName === 'Google grátis') $('stats').textContent = 'Google Tradutor · grátis e sem limite';
    else if (providerName === 'Gemini Nano') $('stats').textContent = 'Gemini Nano no PC · grátis e sem limite';
    else if (providerName === 'No PC') $('stats').textContent = 'IA no seu PC · grátis e sem limite';
    else $('stats').textContent = `Hoje: ${n} ${n === 1 ? 'leitura' : 'leituras'} · ` + (isGemini ? providerName : money(stats.usd));
    $('stats').title = `Total desde que instalou: ${stats.allCalls || 0} leituras, ${money(stats.allUsd)} (estimativa)`;
  }
  if (!tab) return;
  try {
    const s = await sendToTab({ type: 'getStatus' });
    if (!s) return;
    const parts = [];
    if (s.done) parts.push(`${s.done} ${s.done === 1 ? 'página traduzida' : 'páginas traduzidas'}`);
    if (s.pending) parts.push(`${s.pending} na fila`);
    if (s.screen) parts.push(`${s.screen} da tela`);
    $('status').textContent = parts.join(' · ');
  } catch (_) {}
}

function showPower(on) {
  const b = $('power');
  b.textContent = on ? '🟢 Ligado (clique para desligar)' : '⚪ Desligado (clique para ligar)';
  b.className = 'power ' + (on ? 'on' : 'off');
  $('offMsg').hidden = on;
  $('controls').hidden = !on || !tab;
  $('nopage').hidden = !on || !!tab;
  $('status').hidden = !on;
}

async function init() {
  const settings = await chrome.storage.local.get({ enabled: false, provider: 'gemini', geminiKey: '', apiKey: '', autoSites: [] });
  isGemini = settings.provider !== 'claude';
  $('nokey').hidden = ['google', 'nano', 'local'].includes(settings.provider) || !!(settings.provider === 'gemini' ? settings.geminiKey : settings.apiKey);
  providerName = { google: 'Google grátis', nano: 'Gemini Nano', gemini: 'Gemini grátis', claude: '', local: 'No PC' }[settings.provider] || '';

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url ? new URL(tab.url) : null;
  if (!url || !/^https?:$/.test(url.protocol)) {
    tab = null;
    $('nopage').hidden = false;
    $('controls').hidden = true;
  } else {
    $('auto').checked = settings.autoSites.includes(url.hostname);
  }

  const run = (msg, close) => async () => {
    try {
      await sendToTab(msg);
      if (close) window.close(); else refresh();
    } catch (_) {
      $('status').textContent = 'Não consigo funcionar nesta página. Recarregue a página (F5) e tente de novo.';
    }
  };
  $('all').onclick = run({ type: 'cmdTranslateAll' }, true);
  $('screen').onclick = run({ type: 'cmdTranslateScreen' }, true);
  $('toggle').onclick = run({ type: 'cmdToggle' }, true);
  $('clear').onclick = run({ type: 'cmdClear' }, false);
  $('compare').onclick = run({ type: 'cmdCompare' }, true);
  $('compareOcr').onclick = run({ type: 'cmdCompareOcr' }, true);
  $('auto').onchange = async e => {
    const host = url.hostname;
    const { autoSites } = await chrome.storage.local.get({ autoSites: [] });
    const set = new Set(autoSites);
    e.target.checked ? set.add(host) : set.delete(host);
    await chrome.storage.local.set({ autoSites: [...set] });
    await sendToTab({ type: 'cmdSetAuto', on: e.target.checked });
  };
  $('openOpt').onclick = $('openOpt2').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

  let on = settings.enabled;
  showPower(on);
  $('power').onclick = async () => {
    on = !on;
    await chrome.storage.local.set({ enabled: on });
    showPower(on);
    refresh();
  };

  refresh();
  setInterval(refresh, 1500);
  initMode();
}

// ---------- Modo em uso e status dos servidores locais ----------

const MODE_INFO = {
  local: { icon: '💻', tab: 'Local', name: 'Servidor local' },
  nano: { icon: '💻', tab: 'Local', name: 'Gemini Nano (IA do Chrome)' },
  google: { icon: '💻', tab: 'Local', name: 'Leitor de texto + Google Tradutor' },
  gemini: { icon: '☁️', tab: 'Cloud', name: 'Gemini' },
  claude: { icon: '☁️', tab: 'Cloud', name: 'Claude' }
};
const ENGINE_NAMES = { llama: 'llama.cpp' };
const TRANSLATOR_LABELS = { llama: 'llama.cpp (PC)', gemini: 'Gemini (Cloud)', claude: 'Claude (Cloud)', google: 'Google Tradutor' };
const BACKEND_LABELS = { vulkan: 'Vulkan', cuda: 'CUDA', cpu: 'processador' };
const HEALTH = {
  ok: ['on', 'ligado'],
  loading: ['busy', 'carregando o modelo…'],
  off: ['', 'desligado'],
  error: ['err', 'com erro']
};

let modeSettings = null;
let hostStatus = null;        // status completo (pelo ajudante): modelo, placa, instalado...
let hostError = null;
let quickStatus = null;       // status rápido (direto nos servidores)
let srvBusy = {};

const MODE_DEFAULTS = {
  provider: 'gemini', localTranslator: 'llama', srcLang: 'en', dstLang: null, targetLang: '',
  geminiModel: 'gemini-3.6-flash', model: 'claude-haiku-5-5', customModel: '', geminiKey: '', apiKey: ''
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function openOptionsAt(hash) {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html#' + hash) });
}

// quais motores o modo atual usa e para quê
function enginesInUse(s) {
  if (s.provider !== 'local') return {};
  const roles = {};
  roles.llama = s.localTranslator === 'llama' ? ['lê', 'traduz'] : ['lê'];
  return roles;
}

function renderMode() {
  const s = modeSettings;
  if (!s) return;
  const info = MODE_INFO[s.provider] || MODE_INFO.gemini;
  $('modeName').textContent = `${info.icon} ${info.name}`;
  $('modeTab').textContent = 'aba ' + info.tab;

  const lines = [];
  if (s.provider === 'local') {
    lines.push(`Lê: llama.cpp · Traduz: ${TRANSLATOR_LABELS[s.localTranslator]}`);
  } else if (s.provider === 'gemini') {
    lines.push(`Modelo: ${(s.customModel || '').trim() || s.geminiModel}` + (s.geminiKey ? '' : ' · ⚠ falta a chave'));
  } else if (s.provider === 'claude') {
    lines.push(`Modelo: ${(s.customModel || '').trim() || s.model}` + (s.apiKey ? '' : ' · ⚠ falta a chave'));
  }
  const src = LANGS[s.srcLang] ? LANGS[s.srcLang].label : s.srcLang;
  const dst = LANGS[s.dstLang || migrateTargetLang(s.targetLang)].label;
  lines.push(`${src} → ${dst}`);
  $('modeDetail').textContent = lines.join('\n');
  renderServers();
}

function renderServers() {
  const box = $('servers');
  const s = modeSettings;
  if (!s || !quickStatus) return;
  const roles = enginesInUse(s);
  const engines = Object.keys(quickStatus.engines).filter(e => ENGINE_NAMES[e]);   // ignora motores antigos (ex.: OXR)
  const installed = e => hostStatus && hostStatus.engines[e] && hostStatus.engines[e].runtime.installed && hostStatus.engines[e].model.installed;
  // mostra os motores que o modo usa + os que estão instalados ou ligados
  const show = engines.filter(e => roles[e] || installed(e) || quickStatus.engines[e].health !== 'off');
  const relevant = s.provider === 'local' || show.length || quickStatus.installedBefore;
  box.hidden = !relevant;
  if (!relevant) return;
  box.textContent = '';
  box.append(el('div', 'srv-title', 'Servidores no seu PC'));

  if (hostError && hostError.code === 'NO_HOST') {
    const p = el('div', 'srv-note', 'O ajudante do servidor local não está instalado. ');
    const a = el('a', null, 'Instalar');
    a.href = '#';
    a.onclick = e => { e.preventDefault(); openOptionsAt('local'); };
    p.append(a);
    box.append(p);
    if (!show.length) return;
  }

  for (const e of (show.length ? show : engines)) {
    const q = quickStatus.engines[e];
    const h = hostStatus && hostStatus.engines[e];
    const isInstalled = installed(e);
    const running = h && h.server.running;
    let [cls, text] = HEALTH[q.health] || HEALTH.off;
    if (q.health === 'off' && running) [cls, text] = ['busy', 'ligando…'];
    if (q.health === 'off' && hostStatus && !isInstalled) text = 'não instalado';

    const row = el('div', 'srv');
    const dot = el('span', 'dot ' + cls);
    const main = el('div', 'srv-main');
    const head = el('div', 'srv-head');
    head.append(el('b', null, ENGINE_NAMES[e]));
    if (roles[e]) head.append(el('span', 'role', roles[e].join(' e ')));
    head.append(el('span', 'state', text));
    main.append(head);

    const details = [];
    if (h && h.model.installed) details.push(h.model.file);
    if (h && h.runtime.installed) {
      const oldVulkan = h.runtime.backend === 'vulkan' && hostStatus.vulkanOk === false;
      details.push((BACKEND_LABELS[h.runtime.backend] || h.runtime.backend) +
        (oldVulkan ? ' ⚠ Vulkan antigo: usando o processador' : ''));
    }
    if (q.health !== 'off' || running) details.push('porta ' + q.port);
    if (details.length) main.append(el('div', 'srv-detail', details.join(' · ')));
    row.append(dot, main);

    if (isInstalled || q.health !== 'off') {
      const up = q.health !== 'off' || running;
      const b = el('button', 'mini', srvBusy[e] ? '…' : up ? 'Desligar' : 'Ligar');
      b.type = 'button';
      b.disabled = !!srvBusy[e];
      b.onclick = () => serverAction(e, up ? 'localStop' : 'localStart');
      row.append(b);
    } else if (hostStatus) {
      const b = el('button', 'mini', 'Instalar');
      b.type = 'button';
      b.onclick = () => openOptionsAt('local');
      row.append(b);
    }
    box.append(row);
  }

  // modo local com servidor desligado: avisa que liga sozinho
  const needOff = Object.keys(roles).filter(e => quickStatus.engines[e] && quickStatus.engines[e].health !== 'ok');
  if (s.provider === 'local' && needOff.length && !(hostError && hostError.code === 'NO_HOST')) {
    const missing = hostStatus ? needOff.filter(e => !installed(e)) : [];
    box.append(el('div', 'srv-note', missing.length
      ? `Falta instalar ${missing.map(e => ENGINE_NAMES[e]).join(' e ')} (configurações, aba Local).`
      : 'Ao traduzir, a extensão liga sozinha o que estiver desligado (a 1ª página demora um pouco).'));
  }
}

async function serverAction(engine, type) {
  srvBusy[engine] = true;
  renderServers();
  let r;
  try { r = await chrome.runtime.sendMessage({ type, engine }); } catch (_) { r = null; }
  srvBusy[engine] = false;
  if (!r || !r.ok) $('status').textContent = '⚠ ' + ((r && r.error) || 'Não consegui falar com o servidor local.');
  await refreshServers(true);
}

async function refreshServers(full) {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'localStatus', quick: !full });
    if (st && st.ok) {
      quickStatus = st;
      if (full) { hostStatus = st.host || null; hostError = st.hostError || null; }
    }
  } catch (_) {}
  renderServers();
}

async function initMode() {
  modeSettings = await chrome.storage.local.get(MODE_DEFAULTS);
  $('modeChange').onclick = e => {
    e.preventDefault();
    openOptionsAt((MODE_INFO[modeSettings.provider] || MODE_INFO.gemini).tab === 'Cloud' ? 'aba-cloud' : 'aba-local');
  };
  renderMode();
  chrome.storage.onChanged.addListener(async () => {
    modeSettings = await chrome.storage.local.get(MODE_DEFAULTS);
    renderMode();
  });
  await refreshServers(false);
  refreshServers(true);
  setInterval(() => refreshServers(false), 2000);
  setInterval(() => refreshServers(true), 10000);
}

init();
