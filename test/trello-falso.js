'use strict';
// Carregado com `node -r ./test/trello-falso.js server.js` no teste de integração:
// desvia para o Trello simulado (TRELLO_FALSO_URL) as chamadas que o servidor faria à
// API do Trello. Não é teste (o npm test só roda test/*.test.js).
const alvo = process.env.TRELLO_FALSO_URL;
if (alvo) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, opcoes) => original(String(url).replace('https://api.trello.com', alvo), opcoes);
}
