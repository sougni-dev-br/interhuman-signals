# Interhuman Signals — Realtime Camera

Página local que abre a webcam, envia chunks de vídeo (WebM, 3s) via WebSocket pra
`wss://api.interhuman.ai/v1/stream/analyze` e mostra **todas** as inferências
em tempo real:

- **12 sinais sociais** (agreement, confidence, confusion, disagreement,
  disengagement, engagement, frustration, hesitation, interest, skepticism,
  stress, uncertainty) com probabilidade e racional.
- **Engagement state** (engaged / neutral / disengaged) com timeline.
- **Conversation Quality Index 0–100** + 5 dimensões (clarity, authority,
  energy, rapport, learning), snapshot e timeline.
- Log raw de todos os eventos `session.ready`, `session.updated`,
  `signal.detected/updated/ended`, `engagement.updated`,
  `conversation_quality.updated`, `error`.

## Segurança da chave

A chave fica em `.env` (gitignored) e é injetada no **servidor** dentro do
header `Sec-WebSocket-Protocol` ao abrir o upstream. **O browser nunca recebe
a chave** — ele só fala com `localhost`. O servidor age como proxy bidirecional
de WebSocket.

## Como rodar

```powershell
cd C:\Users\Rafael\interhuman-signals
npm install
npm start
```

Abra <http://localhost:3737> no Chrome/Edge. Clique em **Iniciar análise**,
permita a câmera + microfone, e veja os sinais entrando em tempo real.

Pra parar: botão **Parar** ou Ctrl+C no terminal.
