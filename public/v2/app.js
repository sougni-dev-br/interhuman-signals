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
