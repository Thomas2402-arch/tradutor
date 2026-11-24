// Roda o leitor de texto (Tesseract) escondido, para o modo Google.
const schedulers = {};
// auto = leitura normal (página); block = um bloco de texto (balão recortado); sparse = texto espalhado
const PSM = { auto: '3', block: '6', sparse: '11' };

function getScheduler(mode = 'auto', lang = 'eng') {
  const key = mode + '|' + lang;
  if (typeof Tesseract === 'undefined') {
    return Promise.reject(Object.assign(new Error('O leitor de texto ainda não foi instalado.'), { code: 'NO_OCR' }));
  }
  if (!schedulers[key]) {
    schedulers[key] = (async () => {
      const scheduler = Tesseract.createScheduler();
      const n = mode === 'auto' ? Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1)) : 1;
      for (let i = 0; i < n; i++) {
        const worker = await Tesseract.createWorker(lang, 1, {
          workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
          corePath: chrome.runtime.getURL('tesseract'),
          langPath: chrome.runtime.getURL('tesseract'),
          workerBlobURL: false,
          cacheMethod: 'none',
          gzip: true
        });
        // modo automático de página: lida melhor com balões espalhados pela imagem
        await worker.setParameters({ tessedit_pageseg_mode: PSM[mode] || '3' });
        scheduler.addWorker(worker);
      }
      return scheduler;
    })().catch(e => { schedulers[key] = null; throw e; });
  }
  return schedulers[key];
}

// ---------- Gemini Nano (IA com "olhos" que vem no Chrome e roda no PC) ----------
const NANO_SYSTEM = 'You read text in comic book images (manhwa, manga, webtoon). ' +
  'Reply with ONLY the exact text written in the image, in reading order, as one line. ' +
  'Do not translate, explain or describe the picture. If there is no readable text, reply exactly: NONE';
const nanoBase = {};
const NANO_LANGS = ['en', 'ja', 'es'];

async function getNano(src) {
  const lang = NANO_LANGS.includes(src) ? src : 'en';
  if (typeof LanguageModel === 'undefined') {
    throw Object.assign(new Error('Este Chrome não tem o Gemini Nano.'), { code: 'NO_NANO' });
  }
  const a = await LanguageModel.availability({ expectedInputs: [{ type: 'image' }] });
  if (a !== 'available') {
    throw Object.assign(new Error(a === 'unavailable'
      ? 'O Gemini Nano não roda neste PC.'
      : 'Falta baixar o Gemini Nano (configurações da extensão, modo Gemini Nano).'), { code: 'NO_NANO' });
  }
  if (!nanoBase[lang]) {
    nanoBase[lang] = LanguageModel.create({
      expectedInputs: [{ type: 'image' }, { type: 'text', languages: [lang] }],
      expectedOutputs: [{ type: 'text', languages: [lang] }],
      initialPrompts: [{ role: 'system', content: NANO_SYSTEM }]
    }).catch(e => { nanoBase[lang] = null; throw e; });
  }
  return nanoBase[lang];
}

async function nanoRead(image, src) {
  const base = await getNano(src);
  const session = await base.clone();
  try {
    const bmp = await createImageBitmap(await (await fetch(image)).blob());
    const out = await session.prompt([{
      role: 'user',
      content: [
        { type: 'text', value: 'What text is written in this speech bubble?' },
        { type: 'image', value: bmp }
      ]
    }]);
    return String(out || '').trim();
  } finally {
    session.destroy();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.kind === 'nano') {
    nanoRead(msg.image, msg.src)
      .then(text => sendResponse({ ok: true, text }))
      .catch(e => sendResponse({ ok: false, code: e.code || 'NANO', error: String((e && e.message) || e) }));
    return true;
  }
  (async () => {
    try {
      const scheduler = await getScheduler(msg.mode, /^[a-z_]{3,8}$/.test(msg.lang || '') ? msg.lang : 'eng');
      const { data } = await scheduler.addJob('recognize', msg.image, {}, { blocks: true, text: false });
      const lines = [];
      const push = l => {
        if (!l || !l.text || !l.text.trim() || l.confidence < 45) return;
        lines.push({
          text: l.text.replace(/\s+/g, ' ').trim(),
          conf: l.confidence,
          x: l.bbox.x0, y: l.bbox.y0, w: l.bbox.x1 - l.bbox.x0, h: l.bbox.y1 - l.bbox.y0
        });
      };
      if (data.blocks) {
        for (const b of data.blocks) for (const p of (b.paragraphs || [])) for (const l of (p.lines || [])) push(l);
      } else {
        (data.lines || []).forEach(push);
      }
      sendResponse({ ok: true, lines });
    } catch (e) {
      sendResponse({ ok: false, code: e.code || 'OCR', error: String((e && e.message) || e) });
    }
  })();
  return true;
});
