// PROD config — backend Node hospedado no Render
// SEM passcode embutido: o acesso é feito via login (token HMAC em localStorage
// ego_auth, injetado pelo auth gate do index.html). O backend valida token +
// origin allowlist (https://ego.sougni.com). O passcode virou fallback
// SÓ do servidor (env PASSCODE no Render), nunca exposto no cliente.
window.IH_CONFIG = {
  wsUrl: 'wss://ego-backend-lerb.onrender.com/ws',
};
