# PyAFAR Sidecar → EGO Pulse

Ponte que roda o **PyAFAR** (detecção de Action Units faciais, FACS) sobre um vídeo e entrega os **frames de AU** ao EGO Pulse, onde o módulo `af.js` os agrega em sinais psicossociais (afeto, tensão, carga cognitiva, embotamento, Duchenne, agitação, fadiga) para os relatórios NR-1.

```
vídeo ─► [este sidecar: PyAFAR] ─► au_frames JSON ─► POST /v2/report ─► af.js agrega ─► perfilamento + reports.data
```

## ⚠️ LICENÇA — decisão de negócio antes de produção

- **PyAFAR** = *free non-commercial use* (Copyright AffectAnalysisGroup). Uso **comercial** exige **licença do Prof. Jeffrey Cohn** — https://www.jeffcohn.net/.
- O **EGO Pulse é comercial** → rodar o PyAFAR dentro dele em produção **precisa dessa licença**. Contate o Cohn antes.
- **P&D / validação interna não-comercial**: pode rodar à vontade agora.
- O motor **`af.js`** do EGO (a agregação AU→sinal) **NÃO** depende dessa licença: usa só a ciência FACS/EMFACS pública (Ekman & Friesen) e o *formato* de saída do PyAFAR — nenhum código do PyAFAR.

> Enquadramento EGO Pulse: **SINAL, não diagnóstico.** As flags (tensão, afeto negativo, embotamento, fadiga) são indicadores comportamentais para triagem NR-1, nunca diagnóstico clínico. Requer TCLE/consentimento do colaborador (LGPD).

## Requisitos

- Python **3.8–3.10** (o MediaPipe do PyAFAR não roda em 3.11+).
- **GPU** só em **Linux/WSL2** (ex.: a VM **Hermes** do Rafael — `C:\WSL\Hermes.cmd`). CPU funciona, mais lento.
- Instale o PyAFAR pela wiki oficial: https://github.com/AffectAnalysisGroup/PyAFAR/wiki/3.-Installation

## Rodar

```bash
cd pyafar-sidecar
python -m venv .venv && source .venv/bin/activate   # no Windows: .venv\Scripts\activate
pip install -r requirements.txt
# instale o pyafar conforme a wiki (pode ser wheel/executável específico do SO)
EGO_URL=https://ego-backend-lerb.onrender.com python app.py
# sobe em http://localhost:8200
```

## Endpoints

- `GET /health` → `{ ok, pyafar_installed, ego_url }`
- `POST /analyze` (multipart form):
  - `file` — vídeo (mp4/mov/…)
  - `mode` — `adult` (padrão) | `infant`
  - `gpu` — `true`/`false`
  - `max_frames` — teto de frames (padrão 2000)
  - `stride` — subamostragem; 15 ≈ 2 fps num vídeo 30 fps (padrão 15)
  - `forward` — `true` para já postar no EGO `/v2/report`
  - `ego_token` — token EGO (guest/colaborador) quando `forward=true`
  - `session_meta` — JSON opcional (`duration_s`, `cqi`, `engagement_pct`, …) mesclado ao payload

### Exemplo (só extrair AUs)

```bash
curl -s -X POST http://localhost:8200/analyze \
  -F file=@sessao.mp4 -F mode=adult -F gpu=true -F stride=15 | jq '.frames_sent'
```

### Exemplo (extrair e já mandar pro EGO)

```bash
curl -s -X POST http://localhost:8200/analyze \
  -F file=@sessao.mp4 -F forward=true \
  -F ego_token="<TOKEN_EGO>" \
  -F session_meta='{"duration_s":137,"mode":"observation"}'
```

O EGO responde com o **perfilamento** (markdown) já enriquecido pelos sinais faciais, e persiste o agregado em `reports.data.affect_au`.

## O que é enviado (schema `au_frames`)

Cada frame (após descartar as 468 landmarks, que o `af.js` não usa):

```json
{ "Frame": 0, "Person_ID": 0,
  "Occ_au_1": 0.12, "Occ_au_4": 0.71, "...": "Occ_au_N (0..1)",
  "Int_au_6": 2.4, "Int_au_12": 3.1, "...": "Int_au_N (0..5)",
  "Pitch": 3.2, "Yaw": -1.1, "Roll": 0.4,
  "Eye Aspect Ratio": 0.27, "Mouth Aspect Ratio": 0.31 }
```

O `af.js` (backend EGO) lê exatamente esse formato — `Occ_au_N`, `Int_au_N`, pose e aspect ratios — e devolve os construtos psicossociais + flags NR-1.
