# Investigação e Saneamento de Webhooks Legados do Trello

> **Documento de Instrução para o Agente Claude (Cowork / Sessão de Manutenção)**  
> **Data:** 25/09/2026  
> **Repositório:** `cn2o-hub-backend` (branch `relatorios-escreventes` / `main`)

---

## 1. Contexto e Problema Identificado

No painel de administração dos Relatórios das Escreventes (Modo do Tabelião → aba **Relatórios** / rota `GET /hub/relatorios/status`), foi constatada a presença de webhooks do Trello registrados sob a chave do cartório apontando para uma URL legada:

```text
https://cn2o-hub-protocolo-production.up.railway.app/webhook/trello
```

### O que é esse serviço?
- É o **backend legado do protocolo**, anterior à consolidação do repositório `cn2o-hub-backend` e à versão v1.38.
- Ele ainda responde na Railway a `/saude`, `/webhook/trello` e `/parceiros` (as rotas do hub atual `/hub/*` dão 404 nele).
- Como foi cadastrado originalmente com o mesmo `TRELLO_TOKEN` da serventia, os webhooks dele continuam ativos na conta do Trello.

### Riscos da permanência desses webhooks:
1. **Duplicação de processamento:** A cada movimentação de cartão em qualquer um dos 7 quadros, o Trello faz requisições simultâneas para o backend novo e para o antigo.
2. **Concorrência e sobrescrita:** O serviço antigo tenta re-hidratar cartões, aplicar etiquetas e alterar campos personalizados com regras ou banco de dados defasados.
3. **Esgotamento da cota de API:** O Trello limita em ~100 requisições a cada 10 segundos por token. A concorrência consome a cota em dobro.

---

## 2. Missão do Agente

1. **Mapear e listar** todos os webhooks vinculados ao `TRELLO_TOKEN` atual.
2. **Garantir** que o backend novo (`cn2o-hub-backend`, URL em `BASE_URL`) esteja com webhooks ativos nos 7 quadros monitorados:
   - `00. Protocolo/Cadastro` (`BOARD_00` / `692e0379fa55156e778f27ef`)
   - `01. TABELIÃO` (`BOARD_01` / `692e06a94b807c2a1816d992`)
   - `02. ESCREVENTE CAMILY` (`692e084cec9c0b8b5eb304d3`)
   - `02. ESCREVENTE ROMÊNIA` (`692e095e6ca879a15d5ee852`)
   - `02. ESCREVENTE LARA` (`692e0a12a6941ed8d023177f`)
   - `02. ESCREVENTE JOSILENE` (`692e076f5485a0cbb533fe61`)
   - `02. ESCREVENTE JONAS` (`69ee446f4480af4b9688554a`)
3. **Remover cirurgicamente** apenas os webhooks do Trello cujo `callbackURL` aponte para `https://cn2o-hub-protocolo-production.up.railway.app/webhook/trello`.
4. **Verificar** no `/hub/relatorios/status` que `outras_urls` ficou vazio (`[]`) e que o rastreio segue íntegro.
5. **Avaliar** se o serviço `cn2o-hub-protocolo-production` na Railway ainda é necessário para a rota `/parceiros` antes de desativá-lo por completo.

---

## 3. Roteiro Passo a Passo de Execução

### Passo 1: Listar os webhooks atuais no Trello

Execute no terminal (com as variáveis de ambiente carregadas):

```bash
node -e "
const { t } = require('./trello');
(async () => {
  const ws = await t('GET', '/tokens/' + process.env.TRELLO_TOKEN + '/webhooks');
  console.log('Total de webhooks vinculados ao token:', ws.length);
  for (const w of ws) {
    console.log({
      id: w.id,
      idModel: w.idModel,
      active: w.active,
      callbackURL: w.callbackURL,
      desc: w.description
    });
  }
})();
"
```

Verifique:
- Quantos apontam para a `BASE_URL` atual (`https://.../webhook/trello`).
- Quantos apontam para `https://cn2o-hub-protocolo-production.up.railway.app/webhook/trello`.

---

### Passo 2: Garantir que o backend novo cobre todos os 7 quadros

Antes de remover qualquer webhook antigo, certifique-se de que os quadros estão cobertos pelo serviço atual:

```bash
node setup.js
```
*(O `setup.js` verifica os webhooks existentes e adiciona os que faltarem apontando para `process.env.BASE_URL/webhook/trello`).*

---

### Passo 3: Remover os webhooks apontando para o serviço legado

Execute o script de remoção cirúrgica abaixo (ele só remove os que possuem `cn2o-hub-protocolo-production` na URL):

```bash
node -e "
const { t } = require('./trello');
(async () => {
  const ws = await t('GET', '/tokens/' + process.env.TRELLO_TOKEN + '/webhooks');
  const legados = ws.filter(w => w.callbackURL && w.callbackURL.includes('cn2o-hub-protocolo-production'));
  console.log('Webhooks legados encontrados para remoção:', legados.length);
  for (const w of legados) {
    await t('DELETE', '/webhooks/' + w.id);
    console.log('✓ Removido webhook:', w.id, 'do quadro:', w.idModel);
  }
  console.log('Remoção concluída com sucesso.');
})();
"
```

---

### Passo 4: Validação do Status

Acesse ou consulte a rota de status com sessão de administrador:

```bash
# Ou verifique na interface: Modo do Tabelião -> aba Relatórios
GET /hub/relatorios/status
```

Resultado esperado no JSON:
```json
{
  "rastreio": {
    "webhook_assinado": true,
    "webhooks": {
      "ativos": 7,
      "quadros_sem_webhook": [],
      "outras_urls": []
    }
  }
}
```

- `outras_urls` deve ser uma lista vazia `[]`.
- `quadros_sem_webhook` deve ser uma lista vazia `[]`.
- `ativos` deve ser `7`.

---

### Passo 5: Avaliação do Serviço `cn2o-hub-protocolo-production` na Railway

1. Verifique se o serviço antigo ainda possui tráfego recente de `/parceiros` nos logs da Railway.
2. Se `/parceiros` não for mais necessária ou já tiver sido absorvida pelo hub principal:
   - Suspender ou deletar o serviço `cn2o-hub-protocolo-production` na Railway para economizar recursos e evitar instâncias zumbis.
3. Se `/parceiros` ainda for necessária:
   - Manter o serviço na Railway ativo, pois agora ele já não recebe mais webhooks do Trello e não competirá com o hub novo.

---

## 4. Regras e Cuidados Críticos

- ❌ **NÃO remova webhooks que apontem para a `BASE_URL` atual do `cn2o-hub-backend`.**
- ❌ **NÃO faça commit de arquivos `.env` ou tokens de API.**
- ✅ **Confirme a assinatura HMAC:** Verifique se `TRELLO_SECRET` está preenchido na Railway e se `webhook_assinado` está `true` no `/hub/relatorios/status`.
