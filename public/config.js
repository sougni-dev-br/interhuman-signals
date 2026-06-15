// Sobrescreva esta config no deploy de produção.
// Em dev (rodando server.js localmente), deixe wsUrl vazio: o frontend cai pra
// ws://localhost:<porta>/ws automaticamente.
window.IH_CONFIG = {
  // wsUrl: 'wss://ego-backend.onrender.com/ws',  // PROD — descomente após criar o serviço Render
  wsUrl: '',
};
