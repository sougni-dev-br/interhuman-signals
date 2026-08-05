// ego signals — realtime client
// Browser -> ws://.../ws -> (proxy injects key) -> wss://api.interhuman.ai/v1/stream/analyze

// Camada de Action Units faciais ON-DEVICE (MediaPipe Face Landmarker -> AU FACS -> af.js no backend).
// Carregada por import() DINÂMICO (best-effort): se o módulo ou o CDN falhar, o /v2/ segue funcionando.
let faceMod = null;

const SIGNAL_TYPES = [
  { key: 'engagement', label: 'Engagement' },
  { key: 'interest', label: 'Interest' },
  { key: 'agreement', label: 'Agreement' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'confusion', label: 'Confusion' },
  { key: 'hesitation', label: 'Hesitation' },
  { key: 'uncertainty', label: 'Uncertainty' },
  { key: 'skepticism', label: 'Skepticism' },
  { key: 'disagreement', label: 'Disagreement' },
  { key: 'frustration', label: 'Frustration' },
  { key: 'stress', label: 'Stress' },
  { key: 'disengagement', label: 'Disengagement' },
];

const DIMS = ['clarity', 'authority', 'energy', 'rapport', 'learning'];

// ============= Session config =============
// Observação passiva: SÓ vídeo + áudio, sem perguntas. A pessoa fala/age
// naturalmente e a Interhuman AI infere os sinais sociais em tempo real.
const FINALIZE_MS = 5000; // janela pra sinais atrasados antes de compilar o relatório
const AUDIO_SAMPLE_MS = 100;
// 0-128 — calibrated for speech. Mobile mics tend a bit quieter / mais ruído de fundo.
const IS_MOBILE =
  matchMedia('(max-width: 720px)').matches ||
  /android|iphone|ipad|mobile/i.test(navigator.userAgent);
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

  // session (observação passiva — sem perguntas)
  session: {
    audioCtx: null,
    analyser: null,
    audioInterval: null,
    voiceSamples: [], // 0/1 por amostra ao longo de TODA a sessão (voz detectada?)
  },
};

// ============= DOM =============
const $ = (sel) => document.querySelector(sel);
const startBtn = $('#startBtn');
const stopBtn = $('#stopBtn');
const preview = $('#preview');
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
const reportMd = $('#reportMd');
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
  for (const sig of SIGNAL_TYPES) {
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
  }
}
renderChips();

function setChip(type, { probability, rationale }) {
  const chip = signalGrid.querySelector(`[data-sig="${type}"]`);
  if (chip) {
    chip.dataset.active = '1';
    const probEl = chip.querySelector('.chip-prob');
    probEl.textContent = probability || '—';
    probEl.className = 'chip-prob ' + (probability || '');
    if (rationale) chip.querySelector('.chip-rationale').textContent = rationale;
  }
}
function clearChip(type) {
  const chip = signalGrid.querySelector(`[data-sig="${type}"]`);
  if (chip) {
    chip.dataset.active = '0';
    chip.querySelector('.chip-prob').textContent = '—';
    chip.querySelector('.chip-prob').className = 'chip-prob';
  }
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
function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}
function elapsedMs() {
  return state.startedAt ? performance.now() - state.startedAt : 0;
}

// ============= Start / Stop =============
startBtn.addEventListener('click', startSession);
stopBtn.addEventListener('click', finalizeSession);
reportCloseBtn.addEventListener('click', () => setPhase('idle'));
newSessionBtn.addEventListener('click', () => {
  setPhase('idle');
  setTimeout(startSession, 200);
});

// ============= Compartilhar perfilamento =============
const SHARE_URL = 'https://ego.sougni.com';
const CUBE_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24.3 34'%3E%3Cpath d='M21.8086 12.7446V16.7974C21.7566 16.739 21.6954 16.6899 21.625 16.65L17.0741 14.0126C16.7956 13.853 16.4498 13.853 16.1713 14.0126L11.6419 16.6346C11.3909 16.7789 11.2379 17.0491 11.2379 17.3377V22.5756C11.2379 22.9041 11.4123 23.2081 11.6969 23.3708L16.1315 25.9375C16.2447 26.002 16.3672 26.045 16.4957 26.0603L13.169 27.9884C12.6885 28.2648 12.0917 28.2648 11.6113 27.9884L3.69394 23.3984C3.25018 23.1436 2.97168 22.6615 2.97168 22.1457V12.7937C2.97168 12.628 3.00534 12.4683 3.06655 12.3179L10.0045 16.1864C10.0351 16.2048 10.0688 16.2109 10.0994 16.2109C10.1698 16.2109 10.2371 16.1741 10.2708 16.1096C10.3259 16.0144 10.2892 15.8916 10.1943 15.8394L3.2716 11.9801C3.36035 11.8727 3.47053 11.7806 3.59601 11.7099L11.6847 7.02474C11.902 6.89886 12.1468 6.83438 12.3917 6.83438C12.6365 6.83438 12.8813 6.89579 13.0986 7.02474L21.2302 11.7345C21.5882 11.9433 21.8117 12.3271 21.8117 12.7416L21.8086 12.7446Z' fill='%231C1B18'/%3E%3Cpath d='M23.3939 9.86779L13.1415 3.92685C12.511 3.56149 11.7367 3.56149 11.1093 3.92685L0.912007 9.83709C0.345828 10.1625 0 10.7643 0 11.4183V23.2111C0 23.9511 0.394795 24.6388 1.03442 25.0072L11.0175 30.7947C11.7031 31.1907 12.5477 31.1907 13.2333 30.7947L23.7764 24.6879C24.0702 24.516 24.2508 24.1997 24.2508 23.8589V11.3569C24.2508 10.7428 23.9233 10.1779 23.3939 9.87087V9.86779ZM22.2034 22.6615C22.2034 23.0023 22.0198 23.3186 21.729 23.4905L13.3649 28.3354C13.065 28.5073 12.7252 28.5963 12.3886 28.5963C12.052 28.5963 11.7122 28.5104 11.4123 28.3354L3.49194 23.7453C2.92577 23.4168 2.57382 22.8089 2.57382 22.1488V12.7968C2.57382 12.2073 2.88904 11.6608 3.39707 11.3691L11.4858 6.68394C12.0428 6.36156 12.7375 6.36156 13.2945 6.68394L21.426 11.3937C21.9065 11.67 22.2034 12.1858 22.2034 12.7416V22.6585V22.6615Z' fill='%231C1B18'/%3E%3C/svg%3E";

// Extrai o arquétipo (primeiro heading #) do markdown do perfilamento
function reportArchetype() {
  const md = state.lastReport?.markdown || '';
  const m = md.match(/^#\s+(.+)$/m);
  let t = m ? m[1] : '';
  t = t
    .replace(/[#*`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

// Desenha um card de resultado (monocromático, logo Sougni) e retorna File PNG
async function renderShareCard() {
  try {
    const W = 1080,
      H = 1350,
      P = 96;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    // fundo creme
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, W, H);
    // glow clay no canto
    const g = ctx.createRadialGradient(W - 120, 160, 40, W - 120, 160, 520);
    g.addColorStop(0, 'rgba(10,10,10,.05)');
    g.addColorStop(1, 'rgba(10,10,10,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // borda interna
    ctx.strokeStyle = '#E5E5E5';
    ctx.lineWidth = 2;
    ctx.strokeRect(40, 40, W - 80, H - 80);

    try {
      await document.fonts.ready;
    } catch {}
    const ui = "'Inter', system-ui, sans-serif";
    const serif = "'Space Grotesk', Georgia, serif";

    const p = state.lastReport?.payload || {};
    const arch = reportArchetype();
    const cqi = p.cqi?.quality_index != null ? Math.round(p.cqi.quality_index) : null;
    const eng = p.engagement_pct?.engaged;
    const sig = p.raw_signal_count;
    const dur =
      p.duration_s != null ? `${Math.floor(p.duration_s / 60)}m${p.duration_s % 60}s` : null;

    // eyebrow
    ctx.fillStyle = '#737373';
    ctx.font = `600 26px ${ui}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('M E U   P E R F I L A M E N T O', P, 250);

    // arquétipo (serif, wrap)
    ctx.fillStyle = '#0A0A0A';
    let fs = arch.length > 42 ? 64 : 80;
    ctx.font = `600 ${fs}px ${serif}`;
    const maxW = W - P * 2;
    const words = arch.split(' ');
    let line = '',
      y = 250 + fs + 30;
    const lh = fs * 1.12;
    let lines = 0;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, P, y);
        y += lh;
        line = w;
        lines++;
        if (lines >= 4) {
          line = line;
          break;
        }
      } else line = test;
    }
    if (line) {
      ctx.fillText(line, P, y);
      y += lh;
    }

    // CQI badge
    y += 28;
    if (cqi != null) {
      const bw = 300,
        bh = 104,
        bx = P,
        by = y;
      ctx.fillStyle = '#171717';
      roundRect(ctx, bx, by, bw, bh, 22);
      ctx.fill();
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
      ctx.fillStyle = '#525252';
      ctx.font = `500 30px ${ui}`;
      ctx.fillText(metr.join('   ·   '), P, y + 18);
    }

    // rodapé: logo Sougni + wordmark + CTA
    const fy = H - 150;
    ctx.strokeStyle = '#E5E5E5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(P, fy - 40);
    ctx.lineTo(W - P, fy - 40);
    ctx.stroke();

    ctx.fillStyle = '#0A0A0A';
    ctx.font = `700 40px ${ui}`;
    ctx.fillText('ego signals', P + 70, fy + 14);
    ctx.font = `500 26px ${ui}`;
    ctx.fillStyle = '#737373';
    ctx.fillText('por Sougni · ego.sougni.com', P + 70, fy + 52);

    // logo cubo
    await new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        try {
          ctx.drawImage(img, P, fy - 26, 48, 67);
        } catch {}
        res();
      };
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
  if (shareBtn) {
    shareBtn.classList.add('loading');
    shareBtn.disabled = true;
  }
  try {
    // 1) Compartilhar IMAGEM (card) — mais moderno, via menu nativo
    let file = null;
    try {
      file = await renderShareCard();
    } catch {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          text: fullText,
          title: 'Meu perfilamento — ego signals',
        });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; /* fall through */
      }
    }
    // 2) Compartilhar TEXTO + link (menu nativo do sistema)
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Meu perfilamento — ego signals', text, url: SHARE_URL });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; /* fall through */
      }
    }
    // 3) Fallback: planilha de redes (sem Web Share API)
    openShareSheet(text, SHARE_URL);
  } finally {
    if (shareBtn) {
      shareBtn.classList.remove('loading');
      shareBtn.disabled = false;
    }
  }
}

function openShareSheet(text, url) {
  if (!shareSheet) return;
  const enc = encodeURIComponent;
  const full = `${text}\n${url}`;
  const set = (id, href) => {
    const el = document.getElementById(id);
    if (el) el.href = href;
  };
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
        if (lbl) {
          const prev = lbl.textContent;
          lbl.textContent = 'Copiado!';
          setTimeout(() => (lbl.textContent = prev), 1800);
        }
      } catch {}
    };
  }
  shareSheet.hidden = false;
}

if (shareBtn) shareBtn.addEventListener('click', shareReport);
if (shareSheet) {
  const closeBtn = document.getElementById('shareSheetClose');
  if (closeBtn)
    closeBtn.addEventListener('click', () => {
      shareSheet.hidden = true;
    });
  shareSheet.addEventListener('click', (e) => {
    if (e.target === shareSheet) shareSheet.hidden = true;
  });
  shareSheet.querySelectorAll('a.share-opt').forEach((a) =>
    a.addEventListener('click', () =>
      setTimeout(() => {
        shareSheet.hidden = true;
      }, 200),
    ),
  );
}

// hook de teste — só em localhost (zero impacto em produção)
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.__egoShareTest = {
    showReport,
    shareReport,
    openShareSheet,
    renderShareCard,
    buildShareText,
  };
}

async function startSession() {
  startBtn.disabled = true;
  setPhase('connecting');
  connectingText.textContent = 'solicitando câmera + microfone…';
  setConn('solicitando câmera…', 'badge-connecting');

  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user', // câmera frontal em mobile
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
    const vt = state.mediaStream.getVideoTracks()[0];
    const settings = vt.getSettings();
    videoMeta.textContent = `${settings.width}×${settings.height} @ ${Math.round(settings.frameRate || 0)}fps`;
    // Action Units faciais on-device (MediaPipe) — import() dinâmico best-effort: nunca derruba a sessão.
    import('./ego-face.js')
      .then((m) => { faceMod = m; return m.initFace(); })
      .then(() => faceMod && faceMod.startFace(preview))
      .catch((e) => pushRaw('error', 'face.init', { message: e.message }));
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
  pushRaw('proxy', 'conectando', {
    wsUrl: wsBase,
    auth: token ? 'token' : passcode ? 'passcode' : 'none',
  });

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

// Finaliza a observação: encerra a captura mas MANTÉM os dados acumulados,
// mostra o loader e dispara o relatório baseado só nos sinais observados.
function finalizeSession() {
  if (state.phase !== 'streaming') return;
  stopBtn.disabled = true;
  teardownAudioMonitor();
  if (state.segmentLoopAbort) state.segmentLoopAbort.abort();
  stopAllMedia();
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.close(1000, 'client_finalize');
  stopTimer();
  setConn('compilando…', 'badge-idle');
  recDot.hidden = true;
  setPhase('finalizing');
  setTimeout(requestReport, FINALIZE_MS);
}

// Aborta a sessão sem gerar relatório (cleanup interno / erros / desconexão).
function stopSession() {
  stopBtn.disabled = true;
  teardownAudioMonitor();
  if (state.segmentLoopAbort) state.segmentLoopAbort.abort();
  stopAllMedia();
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.close(1000, 'client_stop');
  startBtn.disabled = false;
  stopTimer();
  setConn('parado', 'badge-idle');
  recDot.hidden = true;
  if (state.phase === 'streaming' || state.phase === 'connecting') setPhase('idle');
}

function stopAllMedia() {
  try {
    state.mediaRecorder && state.mediaRecorder.state !== 'inactive' && state.mediaRecorder.stop();
  } catch {}
  state.mediaRecorder = null;
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop());
    state.mediaStream = null;
  }
  preview.srcObject = null;
  try { faceMod && faceMod.closeFace(); } catch {} // encerra o MediaPipe e libera a câmera
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

  while (
    !ac.signal.aborted &&
    state.mediaStream &&
    state.ws &&
    state.ws.readyState === WebSocket.OPEN
  ) {
    const stream = state.mediaStream;
    let recorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 600_000,
        audioBitsPerSecond: 64_000,
      });
    } catch (e) {
      pushRaw('error', 'MediaRecorder', { message: e.message });
      return;
    }
    state.mediaRecorder = recorder;
    const chunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    const stopped = new Promise((res) => (recorder.onstop = res));
    recorder.start();
    recDot.hidden = false;
    await sleep(SEG_MS, ac.signal).catch(() => {});
    try {
      recorder.state !== 'inactive' && recorder.stop();
    } catch {}
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
    if (signal)
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      });
  });
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ============= Audio monitor (Web Audio API) =============
// Mede atividade de voz ao longo de TODA a sessão (0/1 por amostra) — alimenta
// o voice_activity_pct do relatório. Não desenha nada na tela (sem overlay).
function setupAudioMonitor() {
  try {
    state.session.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = state.session.audioCtx.createMediaStreamSource(state.mediaStream);
    const analyser = state.session.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    state.session.analyser = analyser;
    const buf = new Uint8Array(analyser.fftSize);
    state.session.audioInterval = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += (v - 128) ** 2;
      const rms = Math.sqrt(sum / buf.length); // 0..~128
      state.session.voiceSamples.push(rms > AUDIO_RMS_THRESHOLD ? 1 : 0);
    }, AUDIO_SAMPLE_MS);
  } catch (e) {
    pushRaw('error', 'audioMonitor', { message: e.message });
  }
}

function teardownAudioMonitor() {
  if (state.session.audioInterval) clearInterval(state.session.audioInterval);
  state.session.audioInterval = null;
  if (state.session.audioCtx) {
    try {
      state.session.audioCtx.close();
    } catch {}
    state.session.audioCtx = null;
  }
}

// % do tempo com voz detectada ao longo de toda a sessão (0-1).
function sessionVoiceActivity() {
  const s = state.session.voiceSamples;
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
}

// ============= Observação passiva (sem perguntas) =============
// A pessoa aparece na câmera e fala/age naturalmente; os sinais sociais são
// inferidos em tempo real do vídeo+áudio. O dashboard fica visível ao vivo até
// a pessoa clicar em "Finalizar", que dispara o relatório só dos sinais.
function beginObservation() {
  setPhase('streaming');
  setConn('lendo em tempo real', 'badge-streaming');
  setupAudioMonitor();
  startBtn.disabled = true;
  stopBtn.disabled = false;
  stopBtn.textContent = 'Finalizar & gerar perfil';
}

// ============= Backend endpoints (v2 routes) =============
function v2Endpoint(name) {
  const cfg = window.IH_CONFIG || {};
  // Em dev (localhost) ignora wsUrl prod — usa same-origin pro backend local.
  const isDevLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const base =
    cfg.wsUrl && !isDevLocal
      ? cfg.wsUrl.replace(/^wss?:\/\//, location.protocol + '//').replace(/\/ws$/, '')
      : `${location.protocol}//${location.host}`;
  return `${base}/${name}`;
}
function reportEndpoint() {
  return v2Endpoint('v2/report');
}

// Token de sessão (do sessionStorage ou do config injetado pelo auth gate)
function authToken() {
  try {
    const a = JSON.parse(sessionStorage.getItem('ego_auth') || 'null');
    return a?.token || (window.IH_CONFIG || {}).token || '';
  } catch {
    return (window.IH_CONFIG || {}).token || '';
  }
}

function buildReportPayload() {
  const top = topSignals();
  const eng = engagementBreakdown();
  return {
    mode: 'observation', // leitura passiva — SEM perguntas
    duration_s: Math.round(elapsedMs() / 1000),
    cqi: state.cqi.overall || null,
    cqi_timeline_points: state.cqi.timeline.length,
    engagement_pct: eng,
    engagement_segments: state.engagement.history.length,
    top_signals: top,
    signal_summary: signalSummary(),
    voice_activity_pct: Math.round(sessionVoiceActivity() * 100),
    raw_signal_count: state.history.length,
    raw_events: buildRawEvents(), // EGO Pulse #1 — série granular p/ o servidor persistir
    au_source: 'mediapipe',
    au_frames: downsampleFrames(faceMod ? faceMod.getAuFrames() : [], 600), // Action Units faciais on-device (af.js agrega)
  };
}

// Subamostra uniforme os frames de AU (preserva início/fim), cap rígido p/ caber no payload.
function downsampleFrames(arr, max) {
  if (!arr || arr.length <= max) return arr || [];
  const step = arr.length / max, out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

// Empacota a série temporal granular da sessão (sinais + CQI + engagement),
// limitada, p/ o backend gravar em session_signal_events ("todos os dados").
function buildRawEvents() {
  const ev = [];
  try {
    for (const h of state.history.slice(-600)) ev.push({ kind: 'signal', payload: h });
    for (const c of state.cqi.timeline.slice(-200)) ev.push({ kind: 'conversation_quality', payload: c });
    for (const e of state.engagement.history.slice(-200)) ev.push({ kind: 'engagement', payload: e });
  } catch {
    /* série granular é best-effort — o agregado da sessão já vai no payload */
  }
  return ev.slice(0, 1000);
}

// Consolida o histórico inteiro de sinais da sessão por tipo (count + probabilidades).
function signalSummary() {
  const m = new Map();
  for (const h of state.history) {
    if (h.state === 'ended') continue;
    if (!m.has(h.type)) m.set(h.type, { type: h.type, count: 0, probabilities: [] });
    const e = m.get(h.type);
    e.count++;
    if (h.probability) e.probabilities.push(h.probability);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
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
    engaged: Math.round(((counts.engaged || 0) / totalDur) * 100),
    neutral: Math.round(((counts.neutral || 0) / totalDur) * 100),
    disengaged: Math.round(((counts.disengaged || 0) / totalDur) * 100),
  };
}

async function requestReport() {
  const payload = buildReportPayload();
  pushRaw('proxy', 'report.request', { signals: payload.raw_signal_count });
  let data;
  try {
    const headers = { 'Content-Type': 'application/json' };
    const tk = authToken();
    if (tk) headers['Authorization'] = `Bearer ${tk}`;
    const r = await fetch(reportEndpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (r.status === 401) {
      // sessão expirada/invalidada → limpa token e volta pro login
      pushRaw('error', 'report.unauthorized', {});
      try {
        sessionStorage.removeItem('ego_auth');
      } catch {}
      location.replace('../login.html');
      return;
    }
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
  rCqi.textContent =
    payload.cqi?.quality_index != null ? Math.round(payload.cqi.quality_index) : '—';
  rEng.textContent = `${payload.engagement_pct.engaged}%`;
  rSig.textContent = String(payload.raw_signal_count);
  rDur.textContent = `${Math.floor(payload.duration_s / 60)}m ${payload.duration_s % 60}s`;
  const voice = payload.voice_activity_pct;
  reportSubtitle.textContent = `leitura em tempo real · só câmera e microfone${voice != null ? ` · ${voice}% do tempo falando` : ''} · fonte: ${data.source || 'claude'}`;
  reportMd.innerHTML = renderMarkdown(data.markdown || '');
}

function fallbackReportMd(p) {
  const top = (p.top_signals?.[0] || {}).type || 'sinal indeterminado';
  const engPct = p.engagement_pct?.engaged ?? 0;
  const voice = p.voice_activity_pct;
  const topList = (p.signal_summary || p.top_signals || [])
    .slice(0, 5)
    .map((s) => `- **${s.type}** — ${s.count}x`)
    .join('\n');
  return `# 🧠 Leitura comportamental

**CQI ${p.cqi?.quality_index != null ? Math.round(p.cqi.quality_index) : '—'}/100** · ${engPct}% engajado · ${p.raw_signal_count} sinais${voice != null ? ` · ${voice}% do tempo falando` : ''} ao longo de ${p.duration_s}s.

## O que a câmera captou
O sinal dominante foi **${top}** (${p.top_signals?.[0]?.count || 0}x). Sinais mais frequentes:
${topList || '- (nenhum sinal detectado nesta sessão)'}

*(Report gerado por fallback local — sem IA conectada. Configure ANTHROPIC_API_KEY no backend pra perfilamento completo.)*`;
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
    .map((block) => {
      if (/^<h\d/.test(block)) return block;
      if (/^\s*-\s/.test(block)) {
        const items = block
          .split(/\n/)
          .filter(Boolean)
          .map((l) => l.replace(/^\s*-\s+/, '<li>') + '</li>');
        return `<ul>${items.join('')}</ul>`;
      }
      return `<p>${block.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('');
}

// ============= Server messages =============
function handleServerMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    pushRaw('proxy', 'non-json', { raw: text.slice(0, 200) });
    return;
  }
  const t = msg.type || 'unknown';

  if (t === 'proxy.auth_rejected') {
    pushRaw('error', 'auth_rejected', msg.data);
    setConn(msg.data?.reason || 'auth falhou', 'badge-error');
    // Token inválido/expirado → limpa storage e manda pra login
    if ((msg.data?.reason || '').includes('credentials')) {
      sessionStorage.removeItem('ego_auth');
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
    runSegmentLoop().catch((err) => pushRaw('error', 'segmentLoop', { message: err.message }));
    // começa a observação passiva ao vivo (sem perguntas)
    beginObservation();
    return;
  }
  if (t === 'session.updated') {
    pushRaw('session', t, msg.data);
    return;
  }
  if (t === 'signal.detected') {
    handleSignalDetected(msg.data);
    pushRaw('signal', t, msg.data);
    return;
  }
  if (t === 'signal.updated') {
    handleSignalUpdated(msg.data);
    pushRaw('signal', t, msg.data);
    return;
  }
  if (t === 'signal.ended') {
    handleSignalEnded(msg.data);
    pushRaw('signal', t, msg.data);
    return;
  }
  if (t === 'engagement.updated') {
    handleEngagementUpdated(msg.data);
    pushRaw('engagement', t, msg.data);
    return;
  }
  if (t === 'conversation_quality.updated') {
    handleQualityUpdated(msg.data);
    pushRaw('quality', t, msg.data);
    return;
  }
  if (t === 'error') {
    pushRaw('error', t, msg.data);
    return;
  }
  pushRaw('proxy', t, msg.data || msg);
}

// ============= Signal handlers =============
function handleSignalDetected(d) {
  const type = d.signal_type;
  state.activeSignals.set(type, { ...d, _detectedAt: Date.now() });
  setChip(type, { probability: d.probability, rationale: d.rationale });
  pushHistory({
    type,
    start: d.start,
    probability: d.probability,
    rationale: d.rationale,
    state: 'detected',
  });
}
function handleSignalUpdated(d) {
  const type = d.signal_type;
  const cur = state.activeSignals.get(type) || {};
  state.activeSignals.set(type, { ...cur, ...d });
  setChip(type, { probability: d.probability, rationale: d.rationale });
  pushHistory({
    type,
    start: d.start,
    probability: d.probability,
    rationale: d.rationale,
    state: 'updated',
  });
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
  signalHistory.innerHTML = state.history
    .map((h) => {
      const time = (h.start ?? h.end ?? 0).toFixed(1) + 's';
      const cls = h.state === 'ended' ? 'ended' : '';
      const prob = h.probability || '';
      const rat = h.rationale
        ? `<span class="t-rat">${escapeHtml(h.rationale)}</span>`
        : `<span class="t-rat">${h.state}</span>`;
      return `<li class="${cls}" data-prob="${prob}">
      <span class="t-name">${h.type}</span>
      ${rat}
      <span class="t-time">${time}</span>
    </li>`;
    })
    .join('');
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
  renderEngageTimeline();
}
function renderEngageTimeline() {
  const hist = state.engagement.history;
  if (!hist.length) return;
  const now = elapsedMs() / 1000;
  const total = Math.max(now, hist[hist.length - 1].start + 1);
  engageTimeline.innerHTML = hist
    .map((seg) => {
      const end = seg.end ?? total;
      const w = Math.max(0, ((end - seg.start) / total) * 100);
      return `<div class="engage-seg ${seg.state}" style="width:${w}%"></div>`;
    })
    .join('');
}
setInterval(() => {
  if (state.engagement.history.length) renderEngageTimeline();
}, 1000);

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
  if (q >= 65) return { label: 'GOOD', color: '#15803D' };
  if (q >= 50) return { label: 'MODERATE', color: '#A16207' };
  if (q >= 30) return { label: 'BELOW AVG', color: '#C2410C' };
  return { label: 'WEAK', color: '#B91C1C' };
}
function drawCqiTimeline() {
  const c = cqiTimelineCanvas;
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth,
    cssH = c.clientHeight;
  if (c.width !== cssW * dpr) {
    c.width = cssW * dpr;
    c.height = cssH * dpr;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pts = state.cqi.timeline;
  if (!pts.length) return;
  const maxT = pts[pts.length - 1].end || pts[pts.length - 1].start || 1;
  ctx.strokeStyle = '#E0EBEC';
  ctx.lineWidth = 1;
  for (let y of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(0, cssH * y);
    ctx.lineTo(cssW, cssH * y);
    ctx.stroke();
  }
  const dimColors = {
    clarity: '#A78BFA',
    authority: '#0EA5E9',
    energy: '#F59E0B',
    rapport: '#14B8A6',
    learning: '#F97316',
  };
  for (const dim of DIMS) {
    ctx.strokeStyle = dimColors[dim] + 'AA';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (p.end / maxT) * cssW;
      const y = cssH - ((p.values?.[dim] ?? 50) / 100) * cssH;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  ctx.strokeStyle = '#002E46';
  ctx.lineWidth = 2.4;
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
function pad(n) {
  return String(n).padStart(2, '0');
}
function stringify(d) {
  if (d == null) return '';
  try {
    return JSON.stringify(d);
  } catch {
    return String(d);
  }
}
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
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
    sessionStorage.removeItem('ego_auth');
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
pushRaw('proxy', 'pronto', {
  hint: 'v2 · clique em "Iniciar sessão" — leitura só por câmera e microfone, sem perguntas',
});

// ============= Canal de denúncia ANÔNIMO (EGO Pulse #3.2) =============
// Botão flutuante + modal. POST /pulse/denuncia SEM Authorization → 100% anônimo
// (o backend não registra identidade nem IP). Vai para os gestores de RH.
(function mountDenuncia() {
  const TYPES = [
    'Assédio moral (psicológico)',
    'Assédio sexual',
    'Assédio religioso',
    'Injúria racial',
    'Bullying',
    'Outros',
  ];
  const btn = document.createElement('button');
  btn.id = 'denunciaBtn';
  btn.type = 'button';
  btn.textContent = '🕊️ Denúncia anônima';
  btn.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:60;background:#0A0A0A;color:#fff;border:0;border-radius:999px;padding:12px 18px;font:600 13px Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.25)';
  document.body.appendChild(btn);

  const ov = document.createElement('div');
  ov.id = 'denunciaOverlay';
  ov.style.cssText =
    'position:fixed;inset:0;z-index:70;background:rgba(10,10,10,.55);display:none;align-items:center;justify-content:center;padding:16px';
  ov.innerHTML =
    '<div style="background:#fff;max-width:520px;width:100%;border-radius:16px;padding:24px;font-family:Inter,system-ui,sans-serif;max-height:90vh;overflow:auto">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">' +
    '<h2 style="margin:0;font:600 20px \'Space Grotesk\',Inter,sans-serif;color:#0A0A0A">Canal de denúncia</h2>' +
    '<button id="denClose" style="background:none;border:0;font-size:22px;cursor:pointer;color:#666;line-height:1">×</button></div>' +
    '<p style="margin:8px 0 16px;font-size:13px;color:#525252;line-height:1.5"><strong>100% anônimo.</strong> Não registramos seu nome, e-mail nem IP — nada aqui liga a denúncia a você. Vai direto para os gestores de RH.</p>' +
    '<label style="display:block;font-size:12px;font-weight:600;color:#0A0A0A;margin-bottom:4px">Tipo</label>' +
    '<select id="denTipo" style="width:100%;padding:10px;border:1px solid #E5E5E5;border-radius:8px;margin-bottom:14px;font-size:14px">' +
    TYPES.map((t) => '<option>' + t + '</option>').join('') +
    '</select>' +
    '<label style="display:block;font-size:12px;font-weight:600;color:#0A0A0A;margin-bottom:4px">O que aconteceu? <span style="color:#C0392B">*</span></label>' +
    '<textarea id="denDesc" rows="5" placeholder="Descreva o ocorrido com o máximo de detalhes possível." style="width:100%;padding:10px;border:1px solid #E5E5E5;border-radius:8px;margin-bottom:14px;font-size:14px;resize:vertical;font-family:inherit"></textarea>' +
    '<label style="display:block;font-size:12px;font-weight:600;color:#0A0A0A;margin-bottom:4px">Informações adicionais (opcional)</label>' +
    '<textarea id="denExtra" rows="3" placeholder="Datas, locais, se há testemunhas, etc." style="width:100%;padding:10px;border:1px solid #E5E5E5;border-radius:8px;margin-bottom:16px;font-size:14px;resize:vertical;font-family:inherit"></textarea>' +
    '<button id="denSend" style="width:100%;background:#0A0A0A;color:#fff;border:0;border-radius:999px;padding:13px;font:600 14px Inter;cursor:pointer">Enviar denúncia anônima</button>' +
    '<div id="denMsg" style="margin-top:12px;font-size:13px;text-align:center"></div></div>';
  document.body.appendChild(ov);

  const q = (s) => ov.querySelector(s);
  const close = () => {
    ov.style.display = 'none';
    q('#denMsg').textContent = '';
  };
  btn.onclick = () => {
    ov.style.display = 'flex';
  };
  q('#denClose').onclick = close;
  ov.onclick = (e) => {
    if (e.target === ov) close();
  };

  q('#denSend').onclick = async () => {
    const desc = q('#denDesc').value.trim();
    const msg = q('#denMsg');
    if (desc.length < 5) {
      msg.style.color = '#C0392B';
      msg.textContent = 'Descreva o ocorrido (mín. 5 caracteres).';
      return;
    }
    q('#denSend').disabled = true;
    msg.style.color = '#525252';
    msg.textContent = 'Enviando com segurança…';
    try {
      const r = await fetch(v2Endpoint('pulse/denuncia'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }, // SEM Authorization — anônimo
        body: JSON.stringify({
          type: q('#denTipo').value,
          description: desc,
          extra_info: q('#denExtra').value.trim() || undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        msg.style.color = '#1E7F4F';
        q('#denDesc').value = '';
        q('#denExtra').value = '';
        msg.innerHTML = 'Denúncia registrada anonimamente.<br>Protocolo: <strong>' + (d.protocolo || '—') + '</strong>';
      } else {
        msg.style.color = '#C0392B';
        msg.textContent = d.error || 'Não foi possível enviar. Tente novamente.';
      }
    } catch {
      msg.style.color = '#C0392B';
      msg.textContent = 'Falha de conexão. Tente novamente.';
    } finally {
      q('#denSend').disabled = false;
    }
  };
})();
