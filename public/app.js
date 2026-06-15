// Interhuman Signals — Realtime client
// Browser -> ws://localhost:PORT/ws -> (proxy injects key) -> wss://api.interhuman.ai/v1/stream/analyze

const SIGNAL_TYPES = [
  { key: 'engagement',   label: 'Engagement',   desc: 'Sustained focus and participation' },
  { key: 'interest',     label: 'Interest',     desc: 'Curiosity toward something unexpected' },
  { key: 'agreement',    label: 'Agreement',    desc: 'Alignment with another\'s position' },
  { key: 'confidence',   label: 'Confidence',   desc: 'How firmly someone communicates' },
  { key: 'confusion',    label: 'Confusion',    desc: 'Gap in understanding' },
  { key: 'hesitation',   label: 'Hesitation',   desc: 'Uncertainty before responding' },
  { key: 'uncertainty',  label: 'Uncertainty',  desc: 'Disruption in speaking/responding' },
  { key: 'skepticism',   label: 'Skepticism',   desc: 'Doubtful stance toward a claim' },
  { key: 'disagreement', label: 'Disagreement', desc: 'Active divergence from a viewpoint' },
  { key: 'frustration',  label: 'Frustration',  desc: 'Mounting tension when blocked' },
  { key: 'stress',       label: 'Stress',       desc: 'Heightened tension or unease' },
  { key: 'disengagement',label: 'Disengagement',desc: 'Reduction in attention/involvement' },
];

const DIMS = ['clarity', 'authority', 'energy', 'rapport', 'learning'];

// ============= State =============
const state = {
  ws: null,
  mediaStream: null,
  mediaRecorder: null,
  segmentLoopAbort: null,
  startedAt: null,
  segmentsSent: 0,
  bytesSent: 0,
  codec: null,
  activeSignals: new Map(), // signal_type -> {start, probability, rationale}
  history: [],              // {type, start, end, probability, rationale}
  engagement: {
    current: null,
    history: [],            // {state, start, end}
  },
  cqi: {
    overall: null,
    timeline: [],           // {start, end, values}
  },
  logEvents: 0,
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

// ============= Chips =============
function renderChips() {
  signalGrid.innerHTML = '';
  for (const sig of SIGNAL_TYPES) {
    const li = document.createElement('div');
    li.className = 'chip';
    li.dataset.sig = sig.key;
    li.dataset.active = '0';
    li.title = sig.desc;
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
  if (!chip) return;
  chip.dataset.active = '1';
  const probEl = chip.querySelector('.chip-prob');
  probEl.textContent = probability || '—';
  probEl.className = 'chip-prob ' + (probability || '');
  if (rationale) chip.querySelector('.chip-rationale').textContent = rationale;
}
function clearChip(type) {
  const chip = signalGrid.querySelector(`[data-sig="${type}"]`);
  if (!chip) return;
  chip.dataset.active = '0';
  chip.querySelector('.chip-prob').textContent = '—';
  chip.querySelector('.chip-prob').className = 'chip-prob';
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

// ============= Start / Stop =============
startBtn.addEventListener('click', startSession);
stopBtn.addEventListener('click', stopSession);

async function startSession() {
  startBtn.disabled = true;
  setConn('solicitando câmera…', 'badge-connecting');
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
      audio: true,
    });
    preview.srcObject = state.mediaStream;
    const vt = state.mediaStream.getVideoTracks()[0];
    const settings = vt.getSettings();
    videoMeta.textContent = `${settings.width}×${settings.height} @ ${Math.round(settings.frameRate || 0)}fps · ${vt.label || 'cam'}`;
  } catch (e) {
    setConn('falha câmera', 'badge-error');
    pushRaw('error', 'getUserMedia', { message: e.message });
    startBtn.disabled = false;
    return;
  }

  // open WS to proxy (config.js can override with prod URL + bake-in passcode)
  setConn('conectando proxy…', 'badge-connecting');
  const cfg = window.IH_CONFIG || {};
  const defaultUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let wsBase = cfg.wsUrl || defaultUrl;
  const passcode = new URLSearchParams(location.search).get('p') || cfg.passcode || '';
  const wsUrl = passcode ? `${wsBase}?p=${encodeURIComponent(passcode)}` : wsBase;
  state.ws = new WebSocket(wsUrl);
  state.ws.binaryType = 'arraybuffer';
  pushRaw('proxy', 'conectando', { wsUrl: wsBase, hasPasscode: Boolean(passcode) });

  state.ws.onopen = () => {
    setConn('proxy ok, abrindo upstream…', 'badge-connecting');
  };
  state.ws.onerror = (e) => {
    pushRaw('error', 'ws.onerror', { message: 'WebSocket error' });
    setConn('erro WS', 'badge-error');
  };
  state.ws.onclose = (e) => {
    setConn(`desconectado (${e.code})`, 'badge-idle');
    stopAllMedia();
  };
  state.ws.onmessage = (msg) => {
    if (typeof msg.data === 'string') handleServerMessage(msg.data);
  };

  stopBtn.disabled = false;
  startTimer();
}

function stopSession() {
  stopBtn.disabled = true;
  if (state.segmentLoopAbort) state.segmentLoopAbort.abort();
  stopAllMedia();
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.close(1000, 'client_stop');
  startBtn.disabled = false;
  stopTimer();
  setConn('parado', 'badge-idle');
  recDot.hidden = true;
}

function stopAllMedia() {
  try { state.mediaRecorder && state.mediaRecorder.state !== 'inactive' && state.mediaRecorder.stop(); } catch {}
  state.mediaRecorder = null;
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }
  preview.srcObject = null;
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

// ============= Segment loop =============
// Each segment is a complete WebM file (≥3s). We start a recorder, wait ~3.2s,
// stop it, send its single blob as binary, then start the next one. This gives
// the Interhuman server an EBML-headed file per chunk (ffmpeg-friendly).
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
    await sleep(SEG_MS, ac.signal);
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

// ============= Server messages =============
function handleServerMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { pushRaw('proxy', 'non-json', { raw: text.slice(0, 200) }); return; }
  const t = msg.type || 'unknown';

  if (t === 'proxy.upstream_open') {
    setConn('upstream conectado', 'badge-ready');
    // send include config
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

  // Interhuman messages — share envelope {type, timestamp, correlation_id, data}
  if (t === 'session.ready') {
    setConn('streaming', 'badge-streaming');
    pushRaw('session', t, msg.data);
    runSegmentLoop().catch(err => pushRaw('error', 'segmentLoop', { message: err.message }));
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

// ============= Signals handling =============
function handleSignalDetected(d) {
  const type = d.signal_type;
  state.activeSignals.set(type, { ...d, _detectedAt: Date.now() });
  setChip(type, { probability: d.probability, rationale: d.rationale });
  pushHistory({ type, start: d.start, probability: d.probability, rationale: d.rationale, state: 'detected' });
}
function handleSignalUpdated(d) {
  const type = d.signal_type;
  const cur = state.activeSignals.get(type) || {};
  state.activeSignals.set(type, { ...cur, ...d });
  setChip(type, { probability: d.probability, rationale: d.rationale });
  pushHistory({ type, start: d.start, probability: d.probability, rationale: d.rationale, state: 'updated' });
}
function handleSignalEnded(d) {
  const type = d.signal_type;
  state.activeSignals.delete(type);
  clearChip(type);
  pushHistory({ type, end: d.end, state: 'ended' });
}

function pushHistory(entry) {
  state.history.unshift({ ...entry, _t: Date.now() });
  state.history = state.history.slice(0, 40);
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

// ============= Engagement handling =============
function handleEngagementUpdated(d) {
  const stateName = d.state;
  const start = d.start ?? 0;
  // close previous
  const hist = state.engagement.history;
  if (hist.length) hist[hist.length - 1].end = start;
  hist.push({ state: stateName, start, end: null });
  state.engagement.current = stateName;
  // update big
  engageBig.className = 'engage-big engage-' + stateName;
  engageBig.querySelector('.engage-label').textContent = stateName;
  engageBig.querySelector('.engage-since').textContent = `desde ${start.toFixed(1)}s`;
  renderEngageTimeline();
}
function renderEngageTimeline() {
  const hist = state.engagement.history;
  if (!hist.length) return;
  const now = (performance.now() - (state.startedAt || performance.now())) / 1000;
  const total = Math.max(now, hist[hist.length - 1].start + 1);
  engageTimeline.innerHTML = hist.map(seg => {
    const end = seg.end ?? total;
    const w = Math.max(0, ((end - seg.start) / total) * 100);
    return `<div class="engage-seg ${seg.state}" style="width:${w}%"></div>`;
  }).join('');
}
setInterval(() => { if (state.engagement.history.length) renderEngageTimeline(); }, 1000);

// ============= CQI handling =============
function handleQualityUpdated(d) {
  if (d.overall) {
    state.cqi.overall = d.overall;
    const q = d.overall.quality_index ?? null;
    if (q != null) {
      cqiScore.textContent = Math.round(q);
      const band = bandFor(q);
      cqiBand.textContent = band.label;
      cqiBand.style.color = band.color;
      // arc length = 2π·86 ≈ 540 (matches dasharray)
      const off = 540 - (q / 100) * 540;
      gaugeFg.style.strokeDashoffset = off;
      gaugeFg.style.stroke = band.color;
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
  if (q >= 80) return { label: 'EXCELLENT', color: '#34d399' };
  if (q >= 65) return { label: 'GOOD',      color: '#a3e635' };
  if (q >= 50) return { label: 'MODERATE',  color: '#facc15' };
  if (q >= 30) return { label: 'BELOW AVG', color: '#fb923c' };
  return         { label: 'WEAK',           color: '#f87171' };
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
  // grid
  ctx.strokeStyle = '#262648'; ctx.lineWidth = 1;
  for (let y of [0.25, 0.5, 0.75]) {
    ctx.beginPath(); ctx.moveTo(0, cssH * y); ctx.lineTo(cssW, cssH * y); ctx.stroke();
  }
  // line per dimension (light) + main
  const dimColors = { clarity:'#a78bfa', authority:'#22d3ee', energy:'#facc15', rapport:'#34d399', learning:'#fb923c' };
  for (const dim of DIMS) {
    ctx.strokeStyle = dimColors[dim] + '88'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (p.end / maxT) * cssW;
      const y = cssH - ((p.values?.[dim] ?? 50) / 100) * cssH;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  // overall (quality_index) bold
  ctx.strokeStyle = '#f3f3ff'; ctx.lineWidth = 2.2;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = (p.end / maxT) * cssW;
    const y = cssH - ((p.values?.quality_index ?? 50) / 100) * cssH;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  // legend
  ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#8484a8';
  ctx.fillText('quality_index', 8, 14);
  let lx = 100;
  for (const dim of DIMS) {
    ctx.fillStyle = dimColors[dim];
    ctx.fillRect(lx, 8, 10, 6);
    ctx.fillStyle = '#8484a8';
    ctx.fillText(dim, lx + 14, 14);
    lx += 90;
  }
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
  // cap to 300
  while (rawLog.children.length > 300) rawLog.removeChild(rawLog.lastChild);
}
function pad(n) { return String(n).padStart(2, '0'); }
function stringify(d) {
  if (d == null) return '';
  try { return JSON.stringify(d); } catch { return String(d); }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Initial UI: hint
pushRaw('proxy', 'pronto', { hint: 'clique em "Iniciar análise" pra começar' });
