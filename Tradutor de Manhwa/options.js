const $ = id => document.getElementById(id);

const DEFAULTS = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-3.6-flash',
  apiKey: '',
  model: 'claude-haiku-5-5',
  customModel: '',
  targetLang: 'português do Brasil',
  useCache: true,
  useMemory: true,
  prefetchNext: true,
  reviewPass: true
};

const HINTS = {
  'claude-haiku-5-5': 'Custo estimado: uns US$ 0,025 por capítulo (US$ 5 ≈ 190 capítulos).',
  'claude-sonnet-5-5': 'Custo estimado: uns US$ 0,40 por capítulo.',
  'claude-opus-5-5': 'Custo estimado: uns US$ 0,80 por capítulo.'
};

function provider() {
  const r = document.querySelector('input[name=provider]:checked');
  return r ? r.value : 'gemini';
}

function refreshView() {
  const p = provider();
  $('sec-gemini').hidden = p !== 'gemini';
  $('sec-google').hidden = !(p === 'google' || p === 'nano');
  $('sec-nano').hidden = p !== 'nano';
  if (p === 'google' || p === 'nano') checkGoogle();
  if (p === 'nano') checkNano();
  $('sec-claude').hidden = p !== 'claude';
  $('costHint').textContent = $('customModel').value.trim() ? '' : (HINTS[$('model').value] || '');
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  document.querySelector(`input[name=provider][value=${s.provider}]`).checked = true;
  $('geminiKey').value = s.geminiKey;
  $('geminiModel').value = s.geminiModel;
  if (!$('geminiModel').value) $('geminiModel').value = DEFAULTS.geminiModel;
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  if (!$('model').value) $('model').value = DEFAULTS.model;
  $('customModel').value = s.customModel;
  $('targetLang').value = s.targetLang;
  $('useCache').checked = s.useCache;
  $('useMemory').checked = s.useMemory;
  $('prefetchNext').checked = s.prefetchNext;
  $('reviewPass').checked = s.reviewPass;
  refreshView();
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
    targetLang: $('targetLang').value.trim() || DEFAULTS.targetLang,
    useCache: $('useCache').checked,
    useMemory: $('useMemory').checked,
    prefetchNext: $('prefetchNext').checked,
    reviewPass: $('reviewPass').checked
  };
  await chrome.storage.local.set(values);
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
  try { installed = !!(await chrome.runtime.sendMessage({ type: 'ocrStatus' })).installed; } catch (_) {}
  $('ocrStatus').textContent = installed ? '✅ instalado' : '❌ falta instalar (siga os passos abaixo)';
  $('ocrSteps').hidden = installed;
  let mt = 'unavailable';
  if ('Translator' in window) {
    try { mt = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'pt' }); } catch (_) {}
  }
  $('mtStatus').textContent = mt === 'available' ? '✅ pronto' :
    mt === 'unavailable' ? 'não disponível neste Chrome (vai usar o Google Tradutor pela internet)' :
    'falta baixar (botão abaixo)';
  $('mtRow').hidden = !(mt === 'downloadable' || mt === 'downloading');
  return installed;
}

$('ocrDownload').onclick = async () => {
  $('ocrStatus').textContent = 'baixando para a pasta Downloads…';
  const r = await chrome.runtime.sendMessage({ type: 'downloadOcr' });
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
      sourceLanguage: 'en', targetLanguage: 'pt',
      monitor(m) { m.addEventListener('downloadprogress', e => { $('mtStatus').textContent = `baixando… ${Math.round(e.loaded * 100)}%`; }); }
    });
    $('mtStatus').textContent = '✅ pronto';
    $('mtRow').hidden = true;
  } catch (e) {
    $('mtStatus').textContent = 'não deu para baixar agora (' + e.message + '). Vai usar o Google Tradutor pela internet.';
  }
};

$('save').onclick = save;
document.querySelectorAll('input[name=provider]').forEach(r => r.onchange = refreshView);
$('model').onchange = refreshView;
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

$('clearMemory').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'clearMemory' });
  $('cacheMsg').textContent = r && r.ok ? `Memória de ${r.removed} ${r.removed === 1 ? 'série apagada' : 'séries apagadas'}.` : 'Não deu para apagar.';
};

load();
