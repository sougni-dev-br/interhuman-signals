// af.js — Agregação de Action Units (FACS) em sinais psicossociais para o EGO Pulse.
//
// Consome a SAÍDA NATIVA do PyAFAR (frame-level): colunas `Occ_au_N` (0..1),
// `Int_au_N` (0..5, adulto: 6/10/12/14/17), `Pitch`/`Yaw`/`Roll` (graus),
// `Eye Aspect Ratio`, `Mouth Aspect Ratio`, `Frame`, `Person_ID`.
// Ref. PyAFAR: Hinduja et al., ACII 2023 (AffectAnalysisGroup/PyAFAR).
//
// IMPORTANTE — LICENÇA: PyAFAR é "free non-commercial use" (uso comercial exige
// licença do Prof. Jeffrey Cohn). ESTE módulo NÃO contém código do PyAFAR: ele só
// lê o formato de saída (não protegível) e aplica a ciência PÚBLICA do FACS/EMFACS
// (Ekman & Friesen) para mapear AUs -> afeto. Rodar o PyAFAR em produção comercial
// (o sidecar) é o que depende da licença — a agregação aqui, não.
//
// Enquadramento regulatório do EGO Pulse: isto produz SINAL, não diagnóstico.

// ---- Metadados FACS das AUs que o PyAFAR detecta (adulto) ----
export const AU_META = {
  1:  { name: 'Inner Brow Raiser',    pt: 'sobrancelha interna eleva', valence: -0.3 },
  2:  { name: 'Outer Brow Raiser',    pt: 'sobrancelha externa eleva', valence:  0.0 },
  4:  { name: 'Brow Lowerer',         pt: 'testa franzida',            valence: -0.6 },
  6:  { name: 'Cheek Raiser',         pt: 'bochecha eleva (Duchenne)', valence:  0.8, intensity: true },
  7:  { name: 'Lid Tightener',        pt: 'pálpebra tensiona',         valence: -0.4 },
  10: { name: 'Upper Lip Raiser',     pt: 'lábio superior eleva (nojo)', valence: -0.6, intensity: true },
  12: { name: 'Lip Corner Puller',    pt: 'canto da boca puxa (sorriso)', valence: 0.7, intensity: true },
  14: { name: 'Dimpler',              pt: 'covinha (desdém/ceticismo)', valence: -0.3, intensity: true },
  15: { name: 'Lip Corner Depressor', pt: 'canto da boca abaixa (tristeza)', valence: -0.6 },
  17: { name: 'Chin Raiser',          pt: 'queixo eleva (dúvida)',     valence: -0.3, intensity: true },
  23: { name: 'Lip Tightener',        pt: 'lábios apertam',            valence: -0.4 },
  24: { name: 'Lip Pressor',          pt: 'lábios pressionam',         valence: -0.4 },
};
const ADULT_OCC = [1, 2, 4, 6, 7, 10, 12, 14, 15, 17, 23, 24];
const INT_AUS = [6, 10, 12, 14, 17];

// Construtos psicossociais -> AUs contribuintes (pesos). Base: EMFACS/Ekman.
const CONSTRUCTS = {
  positive_affect:  { 6: 0.5, 12: 0.6 },            // sorriso; Duchenne (6+12) reforçado abaixo
  negative_affect:  { 1: 0.3, 4: 0.4, 10: 0.6, 14: 0.4, 15: 0.7, 17: 0.4 },
  tension_stress:   { 4: 0.5, 7: 0.6, 23: 0.7, 24: 0.7 },
  cognitive_load:   { 4: 0.6, 7: 0.5 },             // testa franzida + pálpebra tensa sustentadas
  surprise_attention:{ 1: 0.5, 2: 0.6 },
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 0) => { const m = 10 ** d; return Math.round(v * m) / m; };
const mean = (a) => { const v = a.filter((x) => Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const std = (a) => {
  const v = a.filter((x) => Number.isFinite(x)); if (v.length < 2) return 0;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
};

// Lê `Occ_au_N` (aceita também `occ_au_N`, `au_N`, `AU12`, etc.) -> prob 0..1
function occ(frame, n) {
  const keys = [`Occ_au_${n}`, `occ_au_${n}`, `Occ_AU${n}`, `au_${n}`, `AU${n}`, `AU_${n}`];
  for (const k of keys) if (frame[k] != null) return clamp(num(frame[k]) ?? 0, 0, 1);
  return null;
}
// Lê `Int_au_N` (0..5)
function inten(frame, n) {
  const keys = [`Int_au_${n}`, `int_au_${n}`, `Int_AU${n}`, `Intensity_au_${n}`];
  for (const k of keys) if (frame[k] != null) return clamp(num(frame[k]) ?? 0, 0, 5);
  return null;
}
function pose(frame, axis) {
  const keys = { pitch: ['Pitch', 'pitch'], yaw: ['Yaw', 'yaw'], roll: ['Roll', 'roll'] }[axis] || [];
  for (const k of keys) if (frame[k] != null) return num(frame[k]);
  return null;
}
function aspect(frame, which) {
  const keys = which === 'eye'
    ? ['Eye Aspect Ratio', 'eye_aspect_ratio', 'EAR', 'ear']
    : ['Mouth Aspect Ratio', 'mouth_aspect_ratio', 'MAR', 'mar'];
  for (const k of keys) if (frame[k] != null) return num(frame[k]);
  return null;
}

/**
 * Agrega frames PyAFAR -> sinais psicossociais (0..100) + flags NR-1 (SINAL, não diagnóstico).
 * @param {Array<Object>} frames  saída frame-level do PyAFAR
 * @param {Object} opts { occThreshold=0.5 }
 */
export function aggregateAU(frames, opts = {}) {
  const occThr = opts.occThreshold ?? 0.5;
  if (!Array.isArray(frames) || !frames.length) return null;

  const N = frames.length;
  // Taxa de ocorrência (prob>thr) e prob média por AU
  const occRate = {}, occProbMean = {};
  for (const n of ADULT_OCC) {
    const probs = frames.map((f) => occ(f, n)).filter((x) => x != null);
    occProbMean[n] = probs.length ? round(mean(probs), 3) : null;
    occRate[n] = probs.length ? round(probs.filter((p) => p >= occThr).length / probs.length, 3) : null;
  }
  // Intensidade média/pico por AU (0..5)
  const intMean = {}, intPeak = {};
  for (const n of INT_AUS) {
    const xs = frames.map((f) => inten(f, n)).filter((x) => x != null);
    intMean[n] = xs.length ? round(mean(xs), 2) : null;
    intPeak[n] = xs.length ? round(Math.max(...xs), 2) : null;
  }

  // Construtos 0..100 (média ponderada das taxas de ocorrência das AUs contribuintes)
  const construct = (map) => {
    let sw = 0, acc = 0;
    for (const [n, w] of Object.entries(map)) {
      const r = occRate[n]; if (r == null) continue;
      acc += w * r; sw += w;
    }
    return sw ? round(clamp((acc / sw) * 100, 0, 100), 1) : null;
  };
  const positive = construct(CONSTRUCTS.positive_affect);
  const negative = construct(CONSTRUCTS.negative_affect);
  const tension = construct(CONSTRUCTS.tension_stress);
  const cogload = construct(CONSTRUCTS.cognitive_load);
  const surprise = construct(CONSTRUCTS.surprise_attention);

  // Duchenne (sorriso genuíno) = AU6 ∧ AU12 no mesmo frame
  let duFrames = 0, smileFrames = 0;
  for (const f of frames) {
    const a6 = occ(f, 6), a12 = occ(f, 12);
    if (a12 != null && a12 >= occThr) { smileFrames++; if (a6 != null && a6 >= occThr) duFrames++; }
  }
  const duchenne_rate = round(duFrames / N, 3);
  const smile_rate = round(smileFrames / N, 3);
  const genuine_smile_ratio = smileFrames ? round(duFrames / smileFrames, 2) : null; // genuíno vs social

  // Expressividade = quão forte a face está fazendo ALGO a cada frame (PICO de AU por frame).
  // Média-de-todas-as-AUs penalizaria expressão intensa porém localizada (ex.: sorriso só AU6+AU12).
  const allRates = ADULT_OCC.map((n) => occRate[n]).filter((x) => x != null);
  const perFrameMax = frames.map((f) => {
    let m = 0; for (const n of ADULT_OCC) { const p = occ(f, n); if (p != null && p > m) m = p; } return m;
  });
  const expressivity = round(clamp(mean(perFrameMax) * 100, 0, 100), 1);
  const affect_flatness = round(100 - expressivity, 1); // embotamento = ausência de atividade facial

  // Valência líquida e labilidade emocional — média ponderada PELA ATIVAÇÃO (só AUs ativas contam)
  const valPerFrame = frames.map((f) => {
    let s = 0, w = 0;
    for (const n of ADULT_OCC) {
      const p = occ(f, n); if (p == null) continue;
      s += AU_META[n].valence * p; w += Math.abs(AU_META[n].valence) * p;
    }
    return w ? s / w : null;
  });
  const valence = round(clamp(((mean(valPerFrame) ?? 0) + 1) * 50, 0, 100), 1); // -1..1 -> 0..100
  const emotional_variability = round(clamp(std(valPerFrame) * 100, 0, 100), 1);

  // Pose da cabeça -> agitação / aversão de olhar / cabeça baixa
  const yaw = frames.map((f) => pose(f, 'yaw'));
  const pitch = frames.map((f) => pose(f, 'pitch'));
  const roll = frames.map((f) => pose(f, 'roll'));
  const head_restlessness = round(clamp((std(yaw) + std(pitch) + std(roll)) / 3, 0, 100), 1);
  const gaze_yaw_range = round((Math.max(...yaw.filter(Number.isFinite), 0) - Math.min(...yaw.filter(Number.isFinite), 0)) || 0, 1);
  const mean_pitch = mean(pitch); // >0 (p/baixo) sugere olhar baixo/retraimento (depende da convenção)

  // Fadiga (olho) — EAR baixo + piscar frequente
  const ear = frames.map((f) => aspect(f, 'eye')).filter((x) => x != null);
  const eye_openness_mean = ear.length ? round(mean(ear), 3) : null;
  let blinks = 0;
  if (ear.length > 2) {
    const thr = (mean(ear)) * 0.6;
    for (let i = 1; i < ear.length - 1; i++) if (ear[i] < thr && ear[i] <= ear[i - 1] && ear[i] < ear[i + 1]) blinks++;
  }
  const blink_proxy = ear.length ? round(blinks / (ear.length / 30), 2) : null; // ~por 30 frames

  const face_detection_rate = round(allRates.length ? 1 : 0, 2); // frames já vêm só com face detectada

  // ---- Flags NR-1 (SINAL, não diagnóstico) ----
  const flags = [];
  if (tension != null && tension >= 45) flags.push({ signal: 'tensao_facial_sustentada', intensity: round(tension / 100, 2), evidence: 'AU4/AU7/AU23/AU24 recorrentes' });
  if (negative != null && positive != null && negative - positive >= 20) flags.push({ signal: 'afeto_negativo_predominante', intensity: round((negative - positive) / 100, 2), evidence: `neg ${negative} vs pos ${positive}` });
  if (affect_flatness != null && affect_flatness >= 70) flags.push({ signal: 'embotamento_afetivo', intensity: round(affect_flatness / 100, 2), evidence: 'pouquíssima atividade facial (possível retraimento/exaustão)' });
  if (eye_openness_mean != null && blink_proxy != null && blink_proxy >= 8) flags.push({ signal: 'sinais_de_fadiga', intensity: round(clamp(blink_proxy / 20, 0, 1), 2), evidence: `piscar elevado (${blink_proxy}/30f)` });
  if (head_restlessness >= 12) flags.push({ signal: 'agitacao_motora', intensity: round(clamp(head_restlessness / 30, 0, 1), 2), evidence: 'alta variação de pose da cabeça' });

  const dominant = [
    ['afeto positivo', positive], ['afeto negativo', negative], ['tensão', tension],
    ['carga cognitiva', cogload], ['surpresa/atenção', surprise],
  ].filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0];

  return {
    schema: 'pyafar/adult',
    frames_analyzed: N,
    face_detection_rate,
    // sinais psicossociais 0..100
    positive_affect: positive,
    negative_affect: negative,
    tension_stress: tension,
    cognitive_load: cogload,
    surprise_attention: surprise,
    valence,
    emotional_variability,
    expressivity,
    affect_flatness,
    duchenne_rate,
    smile_rate,
    genuine_smile_ratio,
    // pose / olhar / fadiga
    head_restlessness,
    gaze_yaw_range,
    mean_pitch: mean_pitch != null ? round(mean_pitch, 1) : null,
    eye_openness_mean,
    blink_proxy,
    // detalhamento por AU
    au_occurrence_rate: occRate,
    au_occurrence_prob_mean: occProbMean,
    au_intensity_mean: intMean,
    au_intensity_peak: intPeak,
    // interpretação
    dominant_affect: dominant ? dominant[0] : null,
    nr1_flags: flags,
    signal_summary: auAffectSummaryText({
      positive, negative, tension, cogload, expressivity, affect_flatness,
      valence, emotional_variability, duchenne_rate, genuine_smile_ratio,
      dominant: dominant ? dominant[0] : null, flags, occRate, intMean,
    }),
  };
}

// Resumo compacto (para o prompt do Claude e para persistir em signal_summary).
export function auAffectSummaryText(a) {
  const pct = (v) => (v == null ? '—' : `${Math.round(v)}`);
  const topAUs = Object.entries(a.occRate || {})
    .filter(([, r]) => r != null).sort((x, y) => y[1] - x[1]).slice(0, 4)
    .map(([n, r]) => `AU${n} ${AU_META[n]?.pt || ''} ${Math.round(r * 100)}%`).join('; ');
  const flags = (a.flags || []).map((f) => f.signal).join(', ') || 'nenhum';
  return [
    `Afeto (FACS/PyAFAR): valência ${pct(a.valence)}/100 · positivo ${pct(a.positive)} · negativo ${pct(a.negative)} · tensão ${pct(a.tension)} · carga cognitiva ${pct(a.cogload)}.`,
    `Expressividade ${pct(a.expressivity)} (embotamento ${pct(a.affect_flatness)}), variabilidade emocional ${pct(a.emotional_variability)}.`,
    `Sorriso: ${Math.round((a.duchenne_rate || 0) * 100)}% Duchenne (genuíno vs social ${a.genuine_smile_ratio ?? '—'}).`,
    `AUs mais ativas: ${topAUs || '—'}.`,
    `Dominante: ${a.dominant || '—'}. Flags NR-1 (sinal, não diagnóstico): ${flags}.`,
  ].join(' ');
}

// Bloco de instrução para o prompt do relatório (injeta o significado das AUs).
export function auPromptBlock(agg) {
  if (!agg) return '';
  return `\n\nSINAIS FACIAIS FACS (PyAFAR) — camada de Action Units desta leitura:
${agg.signal_summary}
Use estes sinais faciais como EVIDÊNCIA OBJETIVA (musculatura facial) ao descrever afeto, tensão e engajamento. AU6+AU12 = alegria genuína (Duchenne); AU4/AU7/AU23/AU24 = tensão; AU15/AU17/AU1 = tristeza; AU10/AU14 = nojo/desdém. Embotamento afetivo alto (pouca expressão) é sinal de retraimento/exaustão — trate como SINAL, jamais diagnóstico clínico.`;
}
