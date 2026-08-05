"""
PyAFAR Sidecar — ponte entre o detector de Action Units (PyAFAR) e o EGO Pulse.

  vídeo/frames  ──►  PyAFAR (adult_afar/infant_afar)  ──►  frames de AU (JSON)
                                                          ──►  POST /v2/report (EGO)
                                                               → af.js agrega em sinais psicossociais

┌───────────────────────────────────────────────────────────────────────────┐
│  ⚠  LICENÇA — LEIA ANTES DE USAR EM PRODUÇÃO                                │
│  PyAFAR é liberado para USO NÃO-COMERCIAL (Copyright AffectAnalysisGroup).  │
│  O EGO Pulse é um produto COMERCIAL. Rodar o PyAFAR dentro dele exige uma   │
│  LICENÇA COMERCIAL do Prof. Jeffrey Cohn (https://www.jeffcohn.net/).       │
│  Este sidecar NÃO deve ir para produção comercial sem essa licença.         │
│  Para P&D / validação interna não-comercial, pode rodar livremente.         │
│  (O motor af.js do EGO, esse sim, é livre: usa só a ciência FACS pública.)  │
└───────────────────────────────────────────────────────────────────────────┘

Requisitos: Python 3.8–3.10, pyafar, fastapi, uvicorn, pandas, requests.
GPU só em Linux/WSL2 (ex.: a VM Hermes). Veja README.md.
"""
import os
import math
import tempfile
import requests
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI(title="PyAFAR Sidecar → EGO Pulse", version="1.0.0")

# Conjuntos de AU do PyAFAR (ver wiki 5-Output-Format)
ADULT_OCC = [1, 2, 4, 6, 7, 10, 12, 14, 15, 17, 23, 24]
ADULT_INT = [6, 10, 12, 14, 17]
INFANT_OCC = [4, 6, 12]

EGO_URL = os.environ.get("EGO_URL", "https://ego-backend-lerb.onrender.com")
KEEP_PREFIXES = ("Occ_au_", "Int_au_")
KEEP_EXACT = {"Frame", "Person_ID", "Pitch", "Yaw", "Roll",
              "Eye Aspect Ratio", "Mouth Aspect Ratio"}


def _slim(records, stride: int):
    """Descarta as 468 landmarks (x_i,y_i,z_i) — o af.js não precisa — e subamostra."""
    out = []
    for i, row in enumerate(records):
        if stride > 1 and (i % stride):
            continue
        f = {}
        for k, v in row.items():
            if k in KEEP_EXACT or str(k).startswith(KEEP_PREFIXES):
                # NaN -> None (JSON válido)
                f[k] = None if (isinstance(v, float) and math.isnan(v)) else v
        out.append(f)
    return out


def _run_pyafar(path: str, mode: str, gpu: bool, max_frames: int):
    """Chama o PyAFAR e devolve lista de dicts frame-level. Import tardio: sem licença/pacote, o resto do serviço ainda sobe."""
    import pandas as pd
    if mode == "infant":
        from pyafar import infant_afar
        result = infant_afar(filename=path, AUs=[f"au_{n}" for n in INFANT_OCC],
                             GPU=gpu, max_frames=max_frames)
    else:
        from pyafar import adult_afar
        result = adult_afar(filename=path, AUs=[f"au_{n}" for n in ADULT_OCC],
                            AU_Int=[f"au_{n}" for n in ADULT_INT],
                            GPU=gpu, max_frames=max_frames, batch_size=100, PID=False)
    df = pd.DataFrame.from_dict(result)
    return df.to_dict(orient="records")


@app.get("/health")
def health():
    ok_pkg = True
    try:
        import pyafar  # noqa
    except Exception:
        ok_pkg = False
    return {"ok": True, "pyafar_installed": ok_pkg, "ego_url": EGO_URL}


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    mode: str = Form("adult"),            # adult | infant
    gpu: bool = Form(False),
    max_frames: int = Form(2000),
    stride: int = Form(15),               # subamostra (~2 fps se vídeo 30 fps)
    forward: bool = Form(False),          # se True, POST direto no EGO /v2/report
    ego_token: str = Form(""),            # token (ex.: guest/colaborador) p/ o forward
    session_meta: str = Form("{}"),       # JSON com duration_s, cqi, etc. (opcional)
):
    """Roda o PyAFAR no vídeo e devolve `au_frames`. Se forward=True, encaminha ao EGO."""
    suffix = os.path.splitext(file.filename or "video.mp4")[1] or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name
    try:
        records = _run_pyafar(tmp_path, mode, gpu, max_frames)
    except ModuleNotFoundError as e:
        raise HTTPException(503, f"PyAFAR não instalado/licenciado: {e}")
    except Exception as e:
        raise HTTPException(500, f"Falha no PyAFAR: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    au_frames = _slim(records, stride)
    payload = {"frames_raw": len(records), "frames_sent": len(au_frames), "au_frames": au_frames}

    if forward:
        import json
        try:
            body = json.loads(session_meta or "{}")
        except json.JSONDecodeError:
            body = {}
        body["au_frames"] = au_frames
        body.setdefault("mode", "observation")
        r = requests.post(
            f"{EGO_URL}/v2/report",
            headers={"Content-Type": "application/json",
                     "Origin": "https://ego.sougni.com",
                     "Authorization": f"Bearer {ego_token}"},
            json=body, timeout=90,
        )
        payload["ego_status"] = r.status_code
        try:
            payload["ego_response"] = r.json()
        except ValueError:
            payload["ego_response"] = r.text[:500]

    return JSONResponse(payload)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8200")))
