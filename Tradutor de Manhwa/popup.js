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
  $('nokey').hidden = settings.provider === 'google' || settings.provider === 'nano' || !!(settings.provider === 'gemini' ? settings.geminiKey : settings.apiKey);
  providerName = { google: 'Google grátis', nano: 'Gemini Nano', gemini: 'Gemini grátis', claude: '' }[settings.provider] || '';

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
}

init();
