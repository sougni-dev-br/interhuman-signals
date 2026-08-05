// af-map.js — mapeamento PURO blendshape ARKit/MediaPipe -> Action Units FACS (formato af.js).
// Sem dependencia de rede/MediaPipe: importavel tanto pelo browser (ego-face.js) quanto por testes Node.
//
// Tiers de confiabilidade (FACS, verificado): AU1/2/4/12/15 confiaveis; AU6/7/10/24 usaveis com
// confusao; AU14 fraco (SNR baixo); AU17 (mouthShrug=lip-roll, nao mentalis) e AU23 (sem analogo
// ARKit) => NAO emitidos (null) para o af.js renormalizar os construtos.

export const INT_AUS = [6, 10, 12, 14]; // AU17 fora (nulo)

// Ganho logistico por-AU: blendshapes saturam BAIXO; recentra ~0.30 p/ casar com occThreshold=0.5 do af.js.
export const GAIN = { default: { c: 0.30, k: 8 }, 12: { c: 0.25, k: 8 }, 6: { c: 0.28, k: 8 }, 14: { c: 0.20, k: 10 } };
export const clamp01 = (v) => Math.max(0, Math.min(1, v));
export const gain = (au, x) => { const g = GAIN[au] || GAIN.default; return 1 / (1 + Math.exp(-g.k * (clamp01(x) - g.c))); };

/**
 * @param {Object} b  mapa {blendshapeName: score 0..1}
 * @param {Object} opts { emitAu14=true }
 * @returns {Object} { Occ_au_N, Int_au_N } (chaves ausentes = AU indisponivel)
 */
export function blendshapesToAU(b, opts = {}) {
  const emitAu14 = opts.emitAu14 !== false;
  const m2 = (a, c) => ((b[a] ?? 0) + (b[c] ?? 0)) / 2; // media L/R
  const f = {};
  const occ = (au, raw) => { f['Occ_au_' + au] = +gain(au, raw).toFixed(4); };

  occ(1,  b.browInnerUp ?? 0);
  occ(2,  m2('browOuterUpLeft', 'browOuterUpRight'));
  occ(4,  m2('browDownLeft', 'browDownRight'));
  occ(6,  0.7 * m2('cheekSquintLeft', 'cheekSquintRight') + 0.3 * m2('eyeSquintLeft', 'eyeSquintRight'));
  occ(7,  m2('eyeSquintLeft', 'eyeSquintRight') - 0.3 * m2('cheekSquintLeft', 'cheekSquintRight'));
  occ(10, m2('mouthUpperUpLeft', 'mouthUpperUpRight'));
  occ(12, m2('mouthSmileLeft', 'mouthSmileRight'));
  occ(15, m2('mouthFrownLeft', 'mouthFrownRight'));
  occ(24, m2('mouthPressLeft', 'mouthPressRight') * (1 - clamp01(b.jawOpen ?? 0)));
  if (emitAu14) occ(14, m2('mouthDimpleLeft', 'mouthDimpleRight'));
  // AU17 e AU23: NAO emitidos (null)

  for (const au of INT_AUS) if (f['Occ_au_' + au] != null) f['Int_au_' + au] = +(f['Occ_au_' + au] * 5).toFixed(3);
  return f;
}

// Pose da cabeca a partir da matriz 4x4 column-major (model->camera) do MediaPipe -> Euler graus.
export function poseFromMatrix(d, mirrored = true) {
  if (!d) return {};
  const r00 = d[0], r10 = d[1], r20 = d[2], r21 = d[6], r22 = d[10];
  const k = 180 / Math.PI, sy = Math.hypot(r00, r10);
  let pitch = Math.atan2(r21, r22) * k;
  let yaw = Math.atan2(-r20, sy) * k;
  let roll = Math.atan2(r10, r00) * k;
  if (mirrored) { yaw = -yaw; roll = -roll; }
  return { Pitch: +pitch.toFixed(2), Yaw: +yaw.toFixed(2), Roll: +roll.toFixed(2) };
}
