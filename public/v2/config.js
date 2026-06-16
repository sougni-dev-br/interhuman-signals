// PROD config — backend Node hospedado no Render
// Passcode embutido aqui pra que ego.sougni.com funcione sem ?p= na URL.
// O backend ainda exige passcode + origin allowlist (https://ego.sougni.com),
// então qualquer fetch fora desse contexto é rejeitado.
window.IH_CONFIG = {
  wsUrl: 'wss://ego-backend-lerb.onrender.com/ws',
  passcode: 'ego-2026-K7mP9XzQ',
};
