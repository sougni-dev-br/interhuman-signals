// ego-face.js — camada de Action Units faciais ON-DEVICE para o EGO Pulse.
//
// MediaPipe Face Landmarker (Google, Apache-2.0 no codigo E nos pesos — verificado
// nos 3 model cards: BlazeFace / FaceMesh V2 / Blendshape V2) roda 100% no NAVEGADOR
// sobre o <video> que ja existe. Deriva os 52 blendshapes ARKit -> Action Units FACS
// (mapeamento em af-map.js) no formato que o af.js (backend) consome.
//
// PRIVACIDADE/LGPD: o frame da webcam NUNCA sai do dispositivo. So o agregado numerico
// (blendshapes->AU + pose + EAR, sem imagem e sem os 478 landmarks crus) vai ao servidor.
//
// v1: MediaPipe via CDN jsdelivr (pin @1.0.1). Hardening futuro: self-host vendor/+models/.

import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';
import { blendshapesToAU, poseFromMatrix } from './af-map.js';

const WASM_DIR  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const FPS = 4, FRAME_MS = 1000 / FPS;
const MIRRORED = true; // <video> selfie costuma vir CSS-espelhado -> inverte Yaw/Roll

let lm = null, running = false, lastTs = -1, lastVideoTime = -1;
const frames = [];

export function getAuFrames() { return frames; }
export function resetAuFrames() { frames.length = 0; }
export function faceReady() { return !!lm; }

export async function initFace() {
  if (lm) return;
  const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
  const opts = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO', numFaces: 1,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
  };
  try { lm = await FaceLandmarker.createFromOptions(fileset, opts); }
  catch { opts.baseOptions.delegate = 'CPU'; lm = await FaceLandmarker.createFromOptions(fileset, opts); }
}

export function startFace(video) {
  if (!lm || running) return;
  running = true; resetAuFrames();
  const tick = () => {
    if (!running) return;
    try {
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        let ts = Math.round(performance.now()); if (ts <= lastTs) ts = lastTs + 1; lastTs = ts;
        const res = lm.detectForVideo(video, ts); // sincrono em VIDEO mode
        if (res.faceLandmarks?.length) frames.push(buildFrame(res, w, h));
      }
    } catch { /* best-effort: um frame ruim nunca derruba a sessao */ }
    if (running) setTimeout(tick, FRAME_MS);
  };
  tick();
}

export function stopFace() { running = false; }
export function closeFace() { stopFace(); try { lm?.close(); } catch {} lm = null; }

function buildFrame(res, w, h) {
  const cats = res.faceBlendshapes?.[0]?.categories ?? [];
  const b = {};
  for (const c of cats) b[c.categoryName] = c.score; // lookup por nome

  const f = blendshapesToAU(b);                                  // Occ_au_N / Int_au_N (AU17/23 nulos)
  Object.assign(f, poseFromMatrix(res.facialTransformationMatrixes?.[0]?.data, MIRRORED)); // Pitch/Yaw/Roll

  // EAR geometrico dos 478 landmarks (mais fiel que 1-eyeBlink). x~largura, y~altura (anisotropico!)
  const pts = res.faceLandmarks[0];
  const D = (a, c) => Math.hypot((pts[a].x - pts[c].x) * w, (pts[a].y - pts[c].y) * h);
  const rEye = (D(159, 145) + D(158, 153)) / (2 * D(33, 133));
  const lEye = (D(386, 374) + D(385, 380)) / (2 * D(362, 263));
  f['Eye Aspect Ratio'] = +(((rEye + lEye) / 2)).toFixed(4);

  f.t = Date.now();
  return f;
}
