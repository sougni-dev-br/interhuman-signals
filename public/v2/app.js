// ego signals — realtime client
// Browser -> ws://.../ws -> (proxy injects key) -> wss://api.interhuman.ai/v1/stream/analyze

const SIGNAL_TYPES = [
  { key: 'engagement',   label: 'Engagement' },
  { key: 'interest',     label: 'Interest' },
  { key: 'agreement',    label: 'Agreement' },
  { key: 'confidence',   label: 'Confidence' },
  { key: 'confusion',    label: 'Confusion' },
  { key: 'hesitation',   label: 'Hesitation' },
  { key: 'uncertainty',  label: 'Uncertainty' },
  { key: 'skepticism',   label: 'Skepticism' },
  { key: 'disagreement', label: 'Disagreement' },
  { key: 'frustration',  label: 'Frustration' },
  { key: 'stress',       label: 'Stress' },
  { key: 'disengagement',label: 'Disengagement' },
];

const DIMS = ['clarity', 'authority', 'energy', 'rapport', 'learning'];

// ============= Question bank =============
// Confronto direto — força fala >=10s + reação genuína.
const QUESTION_BANK = [
  { id: 'eyes',      text: 'Olhando pra câmera AGORA: você confia 100% nas suas próprias decisões? Justifique sem desviar o olhar.' },
  { id: 'hide',      text: 'Conte UMA coisa que você esconde dos seus pais ou parceiro(a). Pequena tudo bem, mas tem que ser verdade.' },
  { id: 'spicy',     text: 'Sua opinião mais POLÊMICA — daquelas que você normalmente cala. Diga sem suavizar.' },
  { id: 'life',      text: 'Sendo honesto: você está vivendo a vida que VOCÊ QUER, ou a que ESPERAM de você?' },
  { id: 'fear',      text: 'Em uma frase curta: o que você MAIS teme sobre seu futuro?' },
  { id: 'lie',       text: 'Qual a maior MENTIRA que você acredita sobre si mesmo? Responda olhando pra câmera.' },
  { id: 'envy',      text: 'O que você mais INVEJA em alguém próximo de você?' },
  { id: 'regret',    text: 'Conte uma decisão que você se arrepende dos últimos 5 anos. Não suaviza.' },
  { id: 'now',       text: 'Em UMA palavra ou frase curta: como você se sente AGORA, de verdade?' },
  { id: 'control',   text: 'Uma situação dos últimos 12 meses onde você defendeu uma posição que sabia que estava errada.' },
  { id: 'authentic', text: 'Numa escala de 1 a 10, o quanto você se considera autêntico nas redes sociais? Por quê?' },
  { id: 'loverespect', text: 'Você prefere ser amado ou respeitado? Diga e justifique sem hesitar.' },
];

function pickQuestions(n = 5) {
  const arr = QUESTION_BANK.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

// ============= Session config =============
const QUESTION_MS = 20000;
const QUESTIONS_N = 5;
const FINALIZE_MS = 5000;       // flush window for late signals
const AUDIO_SAMPLE_MS = 100;
// 0-128 — calibrated for speech. Mobile mics tend a bit quieter / mais ruído de fundo.
const IS_MOBILE = matchMedia('(max-width: 720px)').matches || /android|iphone|ipad|mobile/i.test(navigator.userAgent);
const AUDIO_RMS_THRESHOLD = IS_MOBILE ? 4.5 : 6;

// ============= State =============
const state = {
  phase: 'idle',
  ws: null,
  mediaStream: null,
  mediaRecorder: null,
  segmentLoopAbort: null,
  startedAt: null,
  segmentsSent: 0,
  bytesSent: 0,
  codec: null,
  activeSignals: new Map(),
  history: [],
  engagement: { current: null, history: [] },
  cqi: { overall: null, timeline: [] },
  logEvents: 0,

  // session quiz state
  session: {
    questions: [],
    currentIdx: -1,
    buckets: [],            // [{ text, signals:[], engagement:[], audio_activity:0, startedMs, endedMs, dominantEng }]
    qTimer: null,
    audioCtx: null,
    analyser: null,
    audioInterval: null,
    audioSamples: [],       // current question rolling samples (0/1)
    barEls: [],
  },
};

// ============= DOM =============
const $ = (sel) => document.querySelector(sel);
const startBtn = $('#startBtn');
const stopBtn = $('#stopBtn');
const preview = $('#preview');
const pipVideo = $('#pipVideo');
const connBadge = $('#connBadge');
const sessionTimer = $('#sessionTimer');
const videoMeta = $('#videoMeta');
const segCount = $('#segCount');
const bytesSentEl = $('#bytesSent');
const lastChunk = $('#lastChunk');
const codecUsed = $('#codecUsed');
const recDot = $('#recDot');
const engageBig = $('#engageBig');
const engageTimeline = $('#engageTimeline');
const signalGrid = $('#signalGrid');
const signalHistory = $('#signalHistory');
const histCount = $('#histCount');
const cqiScore = $('#cqiScore');
const cqiBand = $('#cqiBand');
const gaugeFg = $('#gaugeFg');
const cqiTimelineCanvas = $('#cqiTimeline');
const rawLog = $('#rawLog');
const logCount = $('#logCount');

// overlay elements
const connectingText = $('#connectingText');
const qNum = $('#qNum');
const qTime = $('#qTime');
const qText = $('#qText');
const qProgressBar = $('#qProgressBar');
const micBars = $('#micBars');
const micLabel = $('#micLabel');
const miniSignalsEl = $('#miniSignals');
const reportMd = $('#reportMd');
const reportQList = $('#reportQList');
const reportSubtitle = $('#reportSubtitle');
const rCqi = $('#rCqi');
const rEng = $('#rEng');
const rSig = $('#rSig');
const rDur = $('#rDur');
const reportCloseBtn = $('#reportCloseBtn');
const newSessionBtn = $('#newSessionBtn');
const shareBtn = $('#shareBtn');
const shareSheet = $('#shareSheet');

// ============= Phase machine =============
function setPhase(p) {
  state.phase = p;
  document.body.dataset.phase = p;
}

// ============= Chips =============
function renderChips() {
  signalGrid.innerHTML = '';
  miniSignalsEl.innerHTML = '';
  for (const sig of SIGNAL_TYPES) {
    // main grid chip
    const li = document.createElement('div');
    li.className = 'chip';
    li.dataset.sig = sig.key;
    li.dataset.active = '0';
    li.innerHTML = `
      <div class="chip-name">${sig.label}</div>
      <div class="chip-prob">—</div>
      <div class="chip-rationale"></div>
    `;
    signalGrid.appendChild(li);

    // mini chip in overlay
    const mini = document.createElement('div');
    mini.className = 'mini-chip';
    mini.dataset.sig = sig.key;
    mini.dataset.active = '0';
    mini.style.setProperty('--chip-color', getComputedStyle(li).getPropertyValue('--chip-color'));
    mini.style.setProperty('--chip-glow', getComputedStyle(li).getPropertyValue('--chip-glow'));
    mini.textContent = sig.label.toLowerCase();
    miniSignalsEl.appendChild(mini);
  }
}
renderChips();

function setChip(type, { probability, rationale }) {
  const chip = signalGrid.querySelector(`[data-sig="${type}"]`);
  const mini = miniSignalsEl.querySelector(`[data-sig="${type}"]`);
  if (chip) {
    chip.dataset.active = '1';
    const probEl = chip.querySelector('.chip-prob');
    probEl.textContent = probability || '—';
    probEl.className = 'chip-prob ' + (probability || '');
    if (rationale) chip.querySelector('.chip-rationale').textContent = rationale;
  }
  if (mini) mini.dataset.active = '1';
}
function clearChip(type) {
  const chip = signalGrid.querySelector(`[data-sig="${type}"]`);
  const mini = miniSignalsEl.querySelector(`[data-sig="${type}"]`);
  if (chip) {
    chip.dataset.active = '0';
    chip.querySelector('.chip-prob').textContent = '—';
    chip.querySelector('.chip-prob').className = 'chip-prob';
  }
  if (mini) mini.dataset.active = '0';
}

// ============= Connection badge =============
function setConn(text, cls) {
  connBadge.textContent = text;
  connBadge.className = 'badge ' + cls;
}

// ============= Session timer =============
let timerHandle = null;
function startTimer() {
  state.startedAt = performance.now();
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    const sec = Math.floor((performance.now() - state.startedAt) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    sessionTimer.textContent = `${mm}:${ss}`;
  }, 500);
}
function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }
function elapsedMs() { return state.startedAt ? performance.now() - state.startedAt : 0; }

// ============= Start / Stop =============
startBtn.addEventListener('click', startSession);
stopBtn.addEventListener('click', stopSession);
reportCloseBtn.addEventListener('click', () => setPhase('idle'));
newSessionBtn.addEventListener('click', () => { setPhase('idle'); setTimeout(startSession, 200); });

// ============= Compartilhar perfilamento =============
const SHARE_URL = 'https://ego.sougni.com';
const CUBE_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24.3 34'%3E%3Cpath d='M21.8086 12.7446V16.7974C21.7566 16.739 21.6954 16.6899 21.625 16.65L17.0741 14.0126C16.7956 13.853 16.4498 13.853 16.1713 14.0126L11.6419 16.6346C11.3909 16.7789 11.2379 17.0491 11.2379 17.3377V22.5756C11.2379 22.9041 11.4123 23.2081 11.6969 23.3708L16.1315 25.9375C16.2447 26.002 16.3672 26.045 16.4957 26.0603L13.169 27.9884C12.6885 28.2648 12.0917 28.2648 11.6113 27.9884L3.69394 23.3984C3.25018 23.1436 2.97168 22.6615 2.97168 22.1457V12.7937C2.97168 12.628 3.00534 12.4683 3.06655 12.3179L10.0045 16.1864C10.0351 16.2048 10.0688 16.2109 10.0994 16.2109C10.1698 16.2109 10.2371 16.1741 10.2708 16.1096C10.3259 16.0144 10.2892 15.8916 10.1943 15.8394L3.2716 11.9801C3.36035 11.8727 3.47053 11.7806 3.59601 11.7099L11.6847 7.02474C11.902 6.89886 12.1468 6.83438 12.3917 6.83438C12.6365 6.83438 12.8813 6.89579 13.0986 7.02474L21.2302 11.7345C21.5882 11.9433 21.8117 12.3271 21.8117 12.7416L21.8086 12.7446Z' fill='%231C1B18'/%3E%3Cpath d='M23.3939 9.86779L13.1415 3.92685C12.511 3.56149 11.7367 3.56149 11.1093 3.92685L0.912007 9.83709C0.345828 10.1625 0 10.7643 0 11.4183V23.2111C0 23.9511 0.394795 24.6388 1.03442 25.0072L11.0175 30.7947C11.7031 31.1907 12.5477 31.1907 13.2333 30.7947L23.7764 24.6879C24.0702 24.516 24.2508 24.1997 24.2508 23.8589V11.3569C24.2508 10.7428 23.9233 10.1779 23.3939 9.87087V9.86779ZM22.2034 22.6615C22.2034 23.0023 22.0198 23.3186 21.729 23.4905L13.3649 28.3354C13.065 28.5073 12.7252 28.5963 12.3886 28.5963C12.052 28.5963 11.7122 28.5104 11.4123 28.3354L3.49194 23.7453C2.92577 23.4168 2.57382 22.8089 2.57382 22.1488V12.7968C2.57382 12.2073 2.88904 11.6608 3.39707 11.3691L11.4858 6.68394C12.0428 6.36156 12.7375 6.36156 13.2945 6.68394L21.426 11.3937C21.9065 11.67 22.2034 12.1858 22.2034 12.7416V22.6585V22.6615Z' fill='%231C1B18'/%3E%3C/svg%3E";

// Extrai o arquétipo (primeiro heading #) do markdown do perfilamento
function reportArchetype() {
  const md = state.lastReport?.markdown || '';
  const m = md.match(/^#\s+(.+)$/m);
  let t = m ? m[1] : '';
  t = t.replace(/[#*`_]/g, '').replace(/\s+/g, ' ').trim();
  // remove emoji de cabeçalho inicial tipo 🧠
  t = t.replace(/^[\p{Emoji}‍️\s]+/u, '').trim();
  return t || 'Meu perfilamento';
}

function buildShareText() {
  const p = state.lastReport?.payload || {};
  const arch = reportArchetype();
  const cqi = p.cqi?.quality_index;
  const eng = p.engagement_pct?.engaged;
  let t = `🧠 Meu perfilamento no ego signals: "${arch}"`;
  const bits = [];
  if (cqi != null) bits.push(`CQI ${Math.round(cqi)}/100`);
  if (eng != null) bits.push(`${eng}% engajado`);
  if (bits.length) t += `\n${bits.join(' · ')}`;
  t += `\n\nFaça o seu teste de 2 minutos 👇`;
  return t;
}

// Desenha um card de resultado (creme/clay, logo Sougni) e retorna File PNG
async function renderShareCard() {
  try {
    const W = 1080, H = 1350, P = 96;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    // fundo creme
    ctx.fillStyle = '#FAF9F6'; ctx.fillRect(0, 0, W, H);
    // glow clay no canto
    const g = ctx.createRadialGradient(W - 120, 160, 40, W - 120, 160, 520);
    g.addColorStop(0, 'rgba(194,107,67,.16)'); g.addColorStop(1, 'rgba(194,107,67,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // borda interna
    ctx.strokeStyle = '#ECE8DD'; ctx.lineWidth = 2;
    ctx.strokeRect(40, 40, W - 80, H - 80);

    try { await document.fonts.ready; } catch {}
    const ui = "'Montserrat', system-ui, sans-serif";
    const serif = "'Fraunces', Georgia, serif";

    const p = state.lastReport?.payload || {};
    const arch = reportArchetype();
    const cqi = p.cqi?.quality_index != null ? Math.round(p.cqi.quality_index) : null;
    const eng = p.engagement_pct?.engaged;
    const sig = p.raw_signal_count;
    const dur = p.duration_s != null ? `${Math.floor(p.duration_s/60)}m${p.duration_s%60}s` : null;

    // eyebrow
    ctx.fillStyle = '#A8542F';
    ctx.font = `600 26px ${ui}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('M E U   P E R F I L A M E N T O', P, 250);

    // arquétipo (serif, wrap)
    ctx.fillStyle = '#1C1B18';
    let fs = arch.length > 42 ? 64 : 80;
    ctx.font = `600 ${fs}px ${serif}`;
    const maxW = W - P * 2;
    const words = arch.split(' ');
    let line = '', y = 250 + fs + 30; const lh = fs * 1.12; let lines = 0;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, P, y); y += lh; line = w; lines++;
        if (lines >= 4) { line = line; break; }
      } else line = test;
    }
    if (line) { ctx.fillText(line, P, y); y += lh; }

    // CQI badge
    y += 28;
    if (cqi != null) {
      const bw = 300, bh = 104, bx = P, by = y;
      ctx.fillStyle = '#C26B43';
      roundRect(ctx, bx, by, bw, bh, 22); ctx.fill();
      // label "CQI" topo
      ctx.fillStyle = 'rgba(255,255,255,.82)';
      ctx.font = `700 22px ${ui}`;
      ctx.fillText('C Q I', bx + 28, by + 38);
      // número grande + /100
      const numStr = String(cqi);
      ctx.fillStyle = '#fff';
      ctx.font = `800 52px ${ui}`;
      ctx.fillText(numStr, bx + 28, by + 86);
      const numW = ctx.measureText(numStr).width;
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.font = `600 24px ${ui}`;
      ctx.fillText('/100', bx + 28 + numW + 10, by + 86);
      y += bh + 30;
    }

    // métricas
    const metr = [];
    if (eng != null) metr.push(`${eng}% engajado`);
    if (sig != null) metr.push(`${sig} sinais`);
    if (dur) metr.push(dur);
    if (metr.length) {
      ctx.fillStyle = '#4A4842';
      ctx.font = `500 30px ${ui}`;
      ctx.fillText(metr.join('   ·   '), P, y + 18);
    }

    // rodapé: logo Sougni + wordmark + CTA
    const fy = H - 150;
    ctx.strokeStyle = '#ECE8DD'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(P, fy - 40); ctx.lineTo(W - P, fy - 40); ctx.stroke();

    ctx.fillStyle = '#1C1B18';
    ctx.font = `700 40px ${ui}`;
    ctx.fillText('ego signals', P + 70, fy + 14);
    ctx.font = `500 26px ${ui}`;
    ctx.fillStyle = '#6E6B62';
    ctx.fillText('por Sougni · ego.sougni.com', P + 70, fy + 52);

    // logo cubo
    await new Promise((res) => {
      const img = new Image();
      img.onload = () => { try { ctx.drawImage(img, P, fy - 26, 48, 67); } catch {} res(); };
      img.onerror = () => res();
      img.src = CUBE_SVG;
    });

    const blob = await new Promise((res) => c.toBlob(res, 'image/png', 0.95));
    if (!blob) return null;
    return new File([blob], 'perfilamento-ego-signals.png', { type: 'image/png' });
  } catch (e) {
    console.warn('[share] card render falhou:', e.message);
    return null;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function shareReport() {
  const text = buildShareText();
  const fullText = `${text}\n${SHARE_URL}`;
  if (shareBtn) { shareBtn.classList.add('loading'); shareBtn.disabled = true; }
  try {
    // 1) Compartilhar IMAGEM (card) — mais moderno, via menu nativo
    let file = null;
    try { file = await renderShareCard(); } catch {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: fullText, title: 'Meu perfilamento — ego signals' });
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; /* fall through */ }
    }
    // 2) Compartilhar TEXTO + link (menu nativo do sistema)
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Meu perfilamento — ego signals', text, url: SHARE_URL });
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; /* fall through */ }
    }
    // 3) Fallback: planilha de redes (sem Web Share API)
    openShareSheet(text, SHARE_URL);
  } finally {
    if (shareBtn) { shareBtn.classList.remove('loading'); shareBtn.disabled = false; }
  }
}

function openShareSheet(text, url) {
  if (!shareSheet) return;
  const enc = encodeURIComponent;
  const full = `${text}\n${url}`;
  const set = (id, href) => { const el = document.getElementById(id); if (el) el.href = href; };
  set('shWhats', `https://wa.me/?text=${enc(full)}`);
  set('shTg', `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`);
  set('shX', `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}`);
  set('shMail', `mailto:?subject=${enc('Meu perfilamento — ego signals')}&body=${enc(full)}`);
  const copyBtn = document.getElementById('shCopy');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(full);
        const lbl = document.getElementById('shCopyLabel');
        if (lbl) { const prev = lbl.textContent; lbl.textContent = 'Copiado!'; setTimeout(() => lbl.textContent = prev, 1800); }
      } catch {}
    };
  }
  shareSheet.hidden = false;
}

if (shareBtn) shareBtn.addEventListener('click', shareReport);
if (shareSheet) {
  const closeBtn = document.getElementById('shareSheetClose');
  if (closeBtn) closeBtn.addEventListener('click', () => { shareSheet.hidden = true; });
  shareSheet.addEventListener('click', (e) => { if (e.target === shareSheet) shareSheet.hidden = true; });
  shareSheet.querySelectorAll('a.share-opt').forEach(a => a.addEventListener('click', () => setTimeout(() => { shareSheet.hidden = true; }, 200)));
}

// hook de teste — só em localhost (zero impacto em produção)
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.__egoShareTest = { showReport, shareReport, openShareSheet, renderShareCard, buildShareText };
}

async function startSession() {
  startBtn.disabled = true;
  setPhase('connecting');
  connectingText.textContent = 'solicitando câmera + microfone…';
  setConn('solicitando câmera…', 'badge-connecting');

  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',   // câmera frontal em mobile
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    preview.srcObject = state.mediaStream;
    pipVideo.srcObject = state.mediaStream;
    const vt = state.mediaStream.getVideoTracks()[0];
    const settings = vt.getSettings();
    videoMeta.textContent = `${settings.width}×${settings.height} @ ${Math.round(settings.frameRate || 0)}fps`;
  } catch (e) {
    setConn('falha câmera', 'badge-error');
    pushRaw('error', 'getUserMedia', { message: e.message });
    startBtn.disabled = false;
    setPhase('idle');
    return;
  }

  connectingText.textContent = 'conectando ao proxy…';
  const cfg = window.IH_CONFIG || {};
  const defaultUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let wsBase = cfg.wsUrl || defaultUrl;
  const token = cfg.token || '';
  const passcode = new URLSearchParams(location.search).get('p') || cfg.passcode || '';
  let wsUrl = wsBase;
  if (token) wsUrl = `${wsBase}?t=${encodeURIComponent(token)}`;
  else if (passcode) wsUrl = `${wsBase}?p=${encodeURIComponent(passcode)}`;
  state.ws = new WebSocket(wsUrl);
  state.ws.binaryType = 'arraybuffer';
  pushRaw('proxy', 'conectando', { wsUrl: wsBase, auth: token ? 'token' : (passcode ? 'passcode' : 'none') });

  state.ws.onopen = () => {
    connectingText.textContent = 'abrindo upstream interhuman…';
  };
  state.ws.onerror = () => {
    pushRaw('error', 'ws.onerror', { message: 'WebSocket error' });
    setConn('erro WS', 'badge-error');
    setPhase('idle');
  };
  state.ws.onclose = (e) => {
    setConn(`desconectado (${e.code})`, 'badge-idle');
    stopAllMedia();
    if (state.phase !== 'reporting' && state.phase !== 'finalizing') setPhase('idle');
  };
  state.ws.onmessage = (msg) => {
    if (typeof msg.data === 'string') handleServerMessage(msg.data);
  };

  stopBtn.disabled = false;
  startTimer();
}

function stopSession() {
  stopBtn.disabled = true;
  if (state.session.qTimer) { clearTimeout(state.session.qTimer); state.session.qTimer = null; }
  teardownAudioMonitor();
  if (state.segmentLoopAbort) state.segmentLoopAbort.abort();
  stopAllMedia();
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.close(1000, 'client_stop');
  startBtn.disabled = false;
  stopTimer();
  setConn('parado', 'badge-idle');
  recDot.hidden = true;
  if (state.phase === 'questioning') setPhase('idle');
}

function stopAllMedia() {
  try { state.mediaRecorder && state.mediaRecorder.state !== 'inactive' && state.mediaRecorder.stop(); } catch {}
  state.mediaRecorder = null;
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }
  preview.srcObject = null;
  pipVideo.srcObject = null;
}

// ============= Codec probing =============
function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'video/webm';
}

// ============= Segment loop (3.2s WebM chunks) =============
async function runSegmentLoop() {
  const ac = new AbortController();
  state.segmentLoopAbort = ac;
  const SEG_MS = 3200;
  const mimeType = pickMimeType();
  state.codec = mimeType;
  codecUsed.textContent = mimeType.replace('video/', '');

  while (!ac.signal.aborted && state.mediaStream && state.ws && state.ws.readyState === WebSocket.OPEN) {
    const stream = state.mediaStream;
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 600_000, audioBitsPerSecond: 64_000 });
    } catch (e) {
      pushRaw('error', 'MediaRecorder', { message: e.message });
      return;
    }
    state.mediaRecorder = recorder;
    const chunks = [];
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    const stopped = new Promise(res => recorder.onstop = res);
    recorder.start();
    recDot.hidden = false;
    await sleep(SEG_MS, ac.signal).catch(() => {});
    try { recorder.state !== 'inactive' && recorder.stop(); } catch {}
    await stopped;
    if (!chunks.length) continue;
    const blob = new Blob(chunks, { type: mimeType });
    const buf = await blob.arrayBuffer();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(buf);
      state.segmentsSent++;
      state.bytesSent += buf.byteLength;
      segCount.textContent = String(state.segmentsSent);
      bytesSentEl.textContent = fmtBytes(state.bytesSent);
      lastChunk.textContent = `${(buf.byteLength / 1024).toFixed(1)} KB`;
    }
  }
  recDot.hidden = true;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  });
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ============= Audio monitor (Web Audio API) =============
function setupAudioMonitor() {
  try {
    state.session.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = state.session.audioCtx.createMediaStreamSource(state.mediaStream);
    const analyser = state.session.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    state.session.analyser = analyser;
    state.session.barEls = [...micBars.querySelectorAll('i')];
    const buf = new Uint8Array(analyser.fftSize);
    state.session.audioInterval = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += (v - 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);   // 0..~128
      // record sample for current question
      if (state.session.currentIdx >= 0) {
        state.session.audioSamples.push(rms > AUDIO_RMS_THRESHOLD ? 1 : 0);
      }
      // animate bars
      const level = Math.min(1, rms / 30);
      const active = rms > AUDIO_RMS_THRESHOLD;
      const qMic = document.querySelector('.q-mic');
      if (qMic) qMic.classList.toggle('active', active);
      if (micLabel) micLabel.textContent = active ? 'ouvindo…' : 'aguardando voz…';
      state.session.barEls.forEach((bar, i) => {
        const phase = (Date.now() / 100 + i) % state.session.barEls.length;
        const h = 4 + (active ? Math.sin(phase) * 5 + 5 : 0) + level * 8;
        bar.style.height = `${Math.max(4, h)}px`;
      });
    }, AUDIO_SAMPLE_MS);
  } catch (e) {
    pushRaw('error', 'audioMonitor', { message: e.message });
  }
}

function teardownAudioMonitor() {
  if (state.session.audioInterval) clearInterval(state.session.audioInterval);
  state.session.audioInterval = null;
  if (state.session.audioCtx) {
    try { state.session.audioCtx.close(); } catch {}
    state.session.audioCtx = null;
  }
}

function flushAudioToBucket() {
  const i = state.session.currentIdx;
  if (i < 0) return;
  const samples = state.session.audioSamples;
  const ratio = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  state.session.buckets[i].audio_activity = ratio;
  state.session.audioSamples = [];
}

// ============= Question flow =============
function beginQuestions() {
  setPhase('questioning');
  setConn('streaming', 'badge-streaming');
  state.session.questions = pickQuestions(QUESTIONS_N);
  state.session.buckets = state.session.questions.map(q => ({
    id: q.id,
    text: q.text,
    signals: [],
    engagement: [],
    cqi_end: null,
    audio_activity: 0,
    started_ms: 0,
    ended_ms: 0,
  }));
  setupAudioMonitor();
  // ensure pip video has the stream
  pipVideo.srcObject = state.mediaStream;
  showQuestion(0);
}

function showQuestion(idx) {
  // close previous bucket
  if (state.session.currentIdx >= 0 && state.session.currentIdx < state.session.buckets.length) {
    state.session.buckets[state.session.currentIdx].ended_ms = elapsedMs();
    flushAudioToBucket();
  }
  state.session.currentIdx = idx;
  const q = state.session.questions[idx];
  state.session.buckets[idx].started_ms = elapsedMs();

  qNum.textContent = `pergunta ${idx + 1} / ${QUESTIONS_N}`;
  qText.textContent = q.text;
  // animate timer text
  let remaining = QUESTION_MS / 1000;
  qTime.textContent = `${remaining}s`;
  const tickHandle = setInterval(() => {
    remaining--;
    if (remaining <= 0) { clearInterval(tickHandle); return; }
    qTime.textContent = `${remaining}s`;
  }, 1000);
  // animate progress bar
  qProgressBar.style.transition = 'none';
  qProgressBar.style.width = '0%';
  void qProgressBar.offsetWidth;
  qProgressBar.style.transition = `width ${QUESTION_MS}ms linear`;
  qProgressBar.style.width = '100%';

  // schedule next
  state.session.qTimer = setTimeout(() => {
    clearInterval(tickHandle);
    if (idx + 1 < QUESTIONS_N) showQuestion(idx + 1);
    else endQuestions();
  }, QUESTION_MS);
}

function endQuestions() {
  // close last bucket
  if (state.session.currentIdx >= 0) {
    state.session.buckets[state.session.currentIdx].ended_ms = elapsedMs();
    flushAudioToBucket();
  }
  state.session.currentIdx = -1;
  setPhase('finalizing');
  setTimeout(requestReport, FINALIZE_MS);
}

// ============= Backend endpoints (v2 routes) =============
function v2Endpoint(name) {
  const cfg = window.IH_CONFIG || {};
  // Em dev (localhost) ignora wsUrl prod — usa same-origin pro backend local.
  const isDevLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const base = (cfg.wsUrl && !isDevLocal)
    ? cfg.wsUrl.replace(/^wss?:\/\//, location.protocol + '//').replace(/\/ws$/, '')
    : `${location.protocol}//${location.host}`;
  return `${base}/${name}`;
}
function reportEndpoint() { return v2Endpoint('v2/report'); }

function buildReportPayload() {
  const top = topSignals();
  const eng = engagementBreakdown();
  return {
    duration_s: Math.round(elapsedMs() / 1000),
    cqi: state.cqi.overall || null,
    cqi_timeline_points: state.cqi.timeline.length,
    engagement_pct: eng,
    top_signals: top,
    per_question: state.session.buckets.map((b, i) => ({
      idx: i + 1,
      question: b.text,
      duration_s: Math.round((b.ended_ms - b.started_ms) / 1000),
      audio_activity: Math.round(b.audio_activity * 100) / 100,
      really_answered: b.audio_activity > 0.15 || b.signals.length > 0,
      signals: aggregateSignals(b.signals),
      engagement_changes: b.engagement.map(e => e.state),
    })),
    raw_signal_count: state.history.length,
  };
}

function topSignals() {
  const counts = new Map();
  for (const h of state.history) {
    if (h.state === 'ended') continue;
    const key = h.type;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));
}

function engagementBreakdown() {
  const total = state.engagement.history.length || 1;
  const counts = { engaged: 0, neutral: 0, disengaged: 0 };
  let totalDur = 0;
  const now = elapsedMs() / 1000;
  for (let i = 0; i < state.engagement.history.length; i++) {
    const seg = state.engagement.history[i];
    const end = seg.end ?? now;
    const dur = end - seg.start;
    counts[seg.state] = (counts[seg.state] || 0) + dur;
    totalDur += dur;
  }
  if (!totalDur) return { engaged: 0, neutral: 100, disengaged: 0 };
  return {
    engaged:    Math.round((counts.engaged || 0) / totalDur * 100),
    neutral:    Math.round((counts.neutral || 0) / totalDur * 100),
    disengaged: Math.round((counts.disengaged || 0) / totalDur * 100),
  };
}

function aggregateSignals(arr) {
  const m = new Map();
  for (const s of arr) {
    if (!m.has(s.type)) m.set(s.type, { type: s.type, count: 0, probabilities: [] });
    const e = m.get(s.type);
    e.count++;
    if (s.probability) e.probabilities.push(s.probability);
  }
  return [...m.values()];
}

async function requestReport() {
  const payload = buildReportPayload();
  pushRaw('proxy', 'report.request', { questions: payload.per_question.length });
  let data;
  try {
    const r = await fetch(reportEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    pushRaw('error', 'report.fetch', { message: e.message });
    data = { markdown: fallbackReportMd(payload), source: 'fallback-frontend' };
  }
  showReport(payload, data);
  // tear down active streaming after report
  stopSession();
}

function showReport(payload, data) {
  setPhase('reporting');
  state.lastReport = { markdown: data.markdown || '', payload };
  rCqi.textContent = payload.cqi?.quality_index != null ? Math.round(payload.cqi.quality_index) : '—';
  rEng.textContent = `${payload.engagement_pct.engaged}%`;
  rSig.textContent = String(payload.raw_signal_count);
  rDur.textContent = `${Math.floor(payload.duration_s / 60)}m ${payload.duration_s % 60}s`;
  reportSubtitle.textContent = `${payload.per_question.length} perguntas confrontadas · fonte: ${data.source || 'claude'}`;
  reportMd.innerHTML = renderMarkdown(data.markdown || '');
  reportQList.innerHTML = payload.per_question.map(q => {
    const tags = [];
    if (q.really_answered) tags.push(`<span class="q-tag spoke">respondeu (${Math.round(q.audio_activity * 100)}% voz)</span>`);
    else tags.push(`<span class="q-tag silent">silenciou</span>`);
    if (q.signals.length) tags.push(`<span class="q-tag signal">${q.signals.length} sinais</span>`);
    return `<li>${escapeHtml(q.question)}<div class="q-tags">${tags.join('')}</div></li>`;
  }).join('');
}

function fallbackReportMd(p) {
  const top = (p.top_signals[0] || {}).type || 'sinal indeterminado';
  const engPct = p.engagement_pct.engaged;
  return `# Perfilamento rápido

**Score CQI ${p.cqi?.quality_index != null ? Math.round(p.cqi.quality_index) : '—'}/100** · ${engPct}% engajado · ${p.raw_signal_count} sinais ao longo de ${p.duration_s}s.

## O que vimos
O sinal mais recorrente foi **${top}** com ${p.top_signals[0]?.count || 0} ocorrência(s).

## Resposta por pergunta
${p.per_question.map(q => `- **${q.idx}.** ${q.really_answered ? '✓ respondeu' : '✗ silenciou'} · sinais: ${q.signals.map(s => s.type).join(', ') || 'nenhum'}`).join('\n')}

*(Report gerado por fallback local — sem IA conectada. Configure ANTHROPIC_API_KEY no backend pra report turbinado.)*`;
}

// ============= Minimal markdown =============
function renderMarkdown(md) {
  if (!md) return '';
  const safe = escapeHtml(md);
  return safe
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .split(/\n{2,}/)
    .map(block => {
      if (/^<h\d/.test(block)) return block;
      if (/^\s*-\s/.test(block)) {
        const items = block.split(/\n/).filter(Boolean).map(l => l.replace(/^\s*-\s+/, '<li>') + '</li>');
        return `<ul>${items.join('')}</ul>`;
      }
      return `<p>${block.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('');
}

// ============= Server messages =============
function handleServerMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { pushRaw('proxy', 'non-json', { raw: text.slice(0, 200) }); return; }
  const t = msg.type || 'unknown';

  if (t === 'proxy.auth_rejected') {
    pushRaw('error', 'auth_rejected', msg.data);
    setConn(msg.data?.reason || 'auth falhou', 'badge-error');
    // Token inválido/expirado → limpa storage e manda pra login
    if ((msg.data?.reason || '').includes('credentials')) {
      localStorage.removeItem('ego_auth');
      setTimeout(() => location.replace('login.html'), 1500);
    }
    setPhase('idle');
    return;
  }
  if (t === 'proxy.upstream_open') {
    setConn('upstream conectado', 'badge-ready');
    const cfg = { include: ['conversation_quality_overall', 'conversation_quality_timeline'] };
    state.ws.send(JSON.stringify(cfg));
    pushRaw('proxy', 'upstream_open → enviei include', cfg);
    return;
  }
  if (t === 'proxy.upstream_close') {
    setConn('upstream fechou', 'badge-error');
    pushRaw('proxy', 'upstream_close', msg.data);
    return;
  }
  if (t === 'proxy.upstream_error') {
    setConn('upstream erro', 'badge-error');
    pushRaw('error', 'upstream_error', msg.data);
    return;
  }
  if (t === 'session.ready') {
    pushRaw('session', t, msg.data);
    runSegmentLoop().catch(err => pushRaw('error', 'segmentLoop', { message: err.message }));
    // start the quiz now
    beginQuestions();
    return;
  }
  if (t === 'session.updated') { pushRaw('session', t, msg.data); return; }
  if (t === 'signal.detected') { handleSignalDetected(msg.data); pushRaw('signal', t, msg.data); return; }
  if (t === 'signal.updated')  { handleSignalUpdated(msg.data);  pushRaw('signal', t, msg.data); return; }
  if (t === 'signal.ended')    { handleSignalEnded(msg.data);    pushRaw('signal', t, msg.data); return; }
  if (t === 'engagement.updated')         { handleEngagementUpdated(msg.data);   pushRaw('engagement', t, msg.data); return; }
  if (t === 'conversation_quality.updated'){ handleQualityUpdated(msg.data);     pushRaw('quality', t, msg.data); return; }
  if (t === 'error') { pushRaw('error', t, msg.data); return; }
  pushRaw('proxy', t, msg.data || msg);
}

// ============= Signal bucketing helpers =============
function bucketSignal(data) {
  const i = state.session.currentIdx;
  if (i < 0) return;
  state.session.buckets[i].signals.push({
    type: data.signal_type,
    start: data.start,
    probability: data.probability,
    rationale: data.rationale,
  });
}
function bucketEngagement(data) {
  const i = state.session.currentIdx;
  if (i < 0) return;
  state.session.buckets[i].engagement.push({ state: data.state, start: data.start });
}

function handleSignalDetected(d) {
  const type = d.signal_type;
  state.activeSignals.set(type, { ...d, _detectedAt: Date.now() });
  setChip(type, { probability: d.probability, rationale: d.rationale });
  bucketSignal(d);
  pushHistory({ type, start: d.start, probability: d.probability, rationale: d.rationale, state: 'detected' });
}
function handleSignalUpdated(d) {
  const type = d.signal_type;
  const cur = state.activeSignals.get(type) || {};
  state.activeSignals.set(type, { ...cur, ...d });
  setChip(type, { probability: d.probability, rationale: d.rationale });
  bucketSignal(d);
  pushHistory({ type, start: d.start, probability: d.probability, rationale: d.rationale, state: 'updated' });
}
function handleSignalEnded(d) {
  state.activeSignals.delete(d.signal_type);
  clearChip(d.signal_type);
  pushHistory({ type: d.signal_type, end: d.end, state: 'ended' });
}

function pushHistory(entry) {
  state.history.unshift({ ...entry, _t: Date.now() });
  state.history = state.history.slice(0, 60);
  histCount.textContent = state.history.length;
  signalHistory.innerHTML = state.history.map(h => {
    const time = (h.start ?? h.end ?? 0).toFixed(1) + 's';
    const cls = h.state === 'ended' ? 'ended' : '';
    const prob = h.probability || '';
    const rat = h.rationale ? `<span class="t-rat">${escapeHtml(h.rationale)}</span>` : `<span class="t-rat">${h.state}</span>`;
    return `<li class="${cls}" data-prob="${prob}">
      <span class="t-name">${h.type}</span>
      ${rat}
      <span class="t-time">${time}</span>
    </li>`;
  }).join('');
}

function handleEngagementUpdated(d) {
  const stateName = d.state;
  const start = d.start ?? 0;
  const hist = state.engagement.history;
  if (hist.length) hist[hist.length - 1].end = start;
  hist.push({ state: stateName, start, end: null });
  state.engagement.current = stateName;
  engageBig.className = 'engage-big engage-' + stateName;
  engageBig.querySelector('.engage-label').textContent = stateName;
  engageBig.querySelector('.engage-since').textContent = `desde ${start.toFixed(1)}s`;
  bucketEngagement(d);
  renderEngageTimeline();
}
function renderEngageTimeline() {
  const hist = state.engagement.history;
  if (!hist.length) return;
  const now = elapsedMs() / 1000;
  const total = Math.max(now, hist[hist.length - 1].start + 1);
  engageTimeline.innerHTML = hist.map(seg => {
    const end = seg.end ?? total;
    const w = Math.max(0, ((end - seg.start) / total) * 100);
    return `<div class="engage-seg ${seg.state}" style="width:${w}%"></div>`;
  }).join('');
}
setInterval(() => { if (state.engagement.history.length) renderEngageTimeline(); }, 1000);

function handleQualityUpdated(d) {
  if (d.overall) {
    state.cqi.overall = d.overall;
    const q = d.overall.quality_index ?? null;
    if (q != null) {
      cqiScore.textContent = Math.round(q);
      const band = bandFor(q);
      cqiBand.textContent = band.label;
      cqiBand.style.color = band.color;
      const off = 540 - (q / 100) * 540;
      gaugeFg.style.strokeDashoffset = off;
    }
    for (const dim of DIMS) {
      const v = d.overall[dim];
      const el = document.querySelector(`.dim[data-dim="${dim}"]`);
      if (!el || v == null) continue;
      el.querySelector('.bar > div').style.width = `${v}%`;
      el.querySelector('span').textContent = Math.round(v);
    }
  }
  if (d.timeline && Array.isArray(d.timeline)) {
    state.cqi.timeline = d.timeline;
    drawCqiTimeline();
  }
}
function bandFor(q) {
  if (q >= 80) return { label: 'EXCELLENT', color: '#0F766E' };
  if (q >= 65) return { label: 'GOOD',      color: '#15803D' };
  if (q >= 50) return { label: 'MODERATE',  color: '#A16207' };
  if (q >= 30) return { label: 'BELOW AVG', color: '#C2410C' };
  return         { label: 'WEAK',           color: '#B91C1C' };
}
function drawCqiTimeline() {
  const c = cqiTimelineCanvas;
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth, cssH = c.clientHeight;
  if (c.width !== cssW * dpr) { c.width = cssW * dpr; c.height = cssH * dpr; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pts = state.cqi.timeline;
  if (!pts.length) return;
  const maxT = pts[pts.length - 1].end || pts[pts.length - 1].start || 1;
  ctx.strokeStyle = '#E0EBEC'; ctx.lineWidth = 1;
  for (let y of [0.25, 0.5, 0.75]) {
    ctx.beginPath(); ctx.moveTo(0, cssH * y); ctx.lineTo(cssW, cssH * y); ctx.stroke();
  }
  const dimColors = { clarity:'#A78BFA', authority:'#0EA5E9', energy:'#F59E0B', rapport:'#14B8A6', learning:'#F97316' };
  for (const dim of DIMS) {
    ctx.strokeStyle = dimColors[dim] + 'AA'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (p.end / maxT) * cssW;
      const y = cssH - ((p.values?.[dim] ?? 50) / 100) * cssH;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  ctx.strokeStyle = '#002E46'; ctx.lineWidth = 2.4;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = (p.end / maxT) * cssW;
    const y = cssH - ((p.values?.quality_index ?? 50) / 100) * cssH;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

// ============= Raw log =============
function pushRaw(kind, type, data) {
  state.logEvents++;
  logCount.textContent = `${state.logEvents} eventos`;
  const li = document.createElement('li');
  li.dataset.kind = kind;
  const now = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  li.innerHTML = `
    <span class="l-time">${time}</span>
    <span class="l-type">${escapeHtml(type)}</span>
    <span class="l-data">${escapeHtml(stringify(data))}</span>
  `;
  rawLog.prepend(li);
  while (rawLog.children.length > 300) rawLog.removeChild(rawLog.lastChild);
}
function pad(n) { return String(n).padStart(2, '0'); }
function stringify(d) { if (d == null) return ''; try { return JSON.stringify(d); } catch { return String(d); } }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ============= Logged-in user pill =============
(function setupUserPill() {
  const cfg = window.IH_CONFIG || {};
  const userPill = document.getElementById('userPill');
  const userEmail = document.getElementById('userEmail');
  const logoutBtn = document.getElementById('logoutBtn');
  if (!cfg.userEmail || !userPill) return;
  const isGuest = cfg.userRole === 'guest';
  userEmail.textContent = isGuest ? '🎭 visitante' : cfg.userEmail;
  if (isGuest) userPill.classList.add('user-pill-guest');
  userPill.hidden = false;
  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('ego_auth');
    location.replace('../login.html');
  });
})();

// ============= Log card toggle (mobile collapse) =============
(function setupLogToggle() {
  const logCard = document.querySelector('.log-card');
  if (!logCard) return;
  const header = logCard.querySelector('.card-h');
  if (!header) return;
  header.addEventListener('click', () => {
    logCard.classList.toggle('open');
  });
})();

// Initial UI hint
pushRaw('proxy', 'pronto', { hint: 'v2 · clique em "Iniciar sessão" para iniciar o perfilamento' });
