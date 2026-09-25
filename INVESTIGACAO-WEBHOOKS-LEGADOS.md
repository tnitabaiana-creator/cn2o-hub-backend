# Instruções de Manutenção: Webhooks Legados e Barra Lateral do Hub

> **Documento de Instrução para o Agente Claude (Cowork / Sessão de Manutenção)**  
> **Data:** 25/09/2026  
> **Repositórios:**  
> - Backend: `cn2o-hub-backend` (branch `relatorios-escreventes` / `main`)  
> - Frontend: `cn2o-hub` (branch `pacote-v1.38.1` / `main`)

---

## PARTE 1 — Investigação e Saneamento de Webhooks Legados do Trello

### 1. Contexto e Problema Identificado

No painel de administração dos Relatórios das Escreventes (Modo do Tabelião → aba **Relatórios** / rota `GET /hub/relatorios/status`), foi constatada a presença de webhooks do Trello registrados sob a chave do cartório apontando para uma URL legada:

```text
https://cn2o-hub-protocolo-production.up.railway.app/webhook/trello
```

#### O que é esse serviço?
- É o **backend legado do protocolo**, anterior à consolidação do repositório `cn2o-hub-backend` e à versão v1.38.
- Ele ainda responde na Railway a `/saude`, `/webhook/trello` e `/parceiros` (as rotas do hub atual `/hub/*` dão 404 nele).
- Como foi cadastrado originalmente com o mesmo `TRELLO_TOKEN` da serventia, os webhooks dele continuam ativos na conta do Trello.

#### Riscos da permanência desses webhooks:
1. **Duplicação de processamento:** A cada movimentação de cartão em qualquer um dos 7 quadros, o Trello faz requisições simultâneas para o backend novo e para o antigo.
2. **Concorrência e sobrescrita:** O serviço antigo tenta re-hidratar cartões, aplicar etiquetas e alterar campos personalizados com regras ou banco de dados defasados.
3. **Esgotamento da cota de API:** O Trello limita em ~100 requisições a cada 10 segundos por token. A concorrência consome a cota em dobro.

---

### 2. Missão do Agente no Backend

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

### 3. Roteiro Passo a Passo (Webhooks)

#### Passo 1: Listar os webhooks atuais no Trello

Execute no terminal do backend (com as variáveis de ambiente carregadas):

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

#### Passo 2: Garantir cobertura dos 7 quadros no backend novo

Antes de remover qualquer webhook antigo, certifique-se de que os 7 quadros estão cobertos pelo serviço atual:

```bash
node setup.js
```
*(O `setup.js` verifica os webhooks existentes e adiciona os que faltarem apontando para `process.env.BASE_URL/webhook/trello`).*

#### Passo 3: Remover webhooks do serviço legado

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

#### Passo 4: Validação do Status

Consulte a rota de status com sessão de administrador:

```bash
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

#### Passo 5: Avaliação do Serviço `cn2o-hub-protocolo-production` na Railway

1. Verifique se o serviço antigo ainda possui tráfego recente de `/parceiros` nos logs da Railway.
2. Se `/parceiros` não for mais necessária ou já tiver sido absorvida pelo hub principal:
   - Suspender ou deletar o serviço `cn2o-hub-protocolo-production` na Railway para economizar recursos e evitar instâncias zumbis.
3. Se `/parceiros` ainda for necessária:
   - Manter o serviço na Railway ativo, pois agora ele já não recebe mais webhooks do Trello e não competirá com o hub novo.

---

## PARTE 2 — Implementação dos Relatórios na Barra Lateral do Hub (Exclusivo Tabelião)

### 4. Contexto e Requisito da Interface

Na versão v1.38, a funcionalidade de **Relatórios das Escreventes** foi incorporada como uma aba interna do editor do mural ("Modo do Tabelião" → botão `✎ Editar mural` → aba `Relatórios`).

**Novo Requisito do Tabelião:**  
O acesso aos relatórios deve aparecer diretamente na **barra lateral do Hub** (`<aside class="lateral"> <nav class="lat-nav">`), proporcionando acesso em 1 clique, porém **estritamente visível para o Tabelião** (administrador autenticado, `SESSAO.admin = true`). Escreventes e usuários não autenticados **jamais** devem visualizar esse botão.

---

### 5. Repositório e Regras de Desenvolvimento Front-End

- **Repositório:** `cn2o-hub`
- **Branch base:** `pacote-v1.38.1` (ou a branch de release mais recente)
- **Convenção de Empacotamento do Cartório (MANDATÓRIO):**
  1. O Hub utiliza empacotamento em `versoes/` (ex: `versoes/hub-cn2o-v1.38.1-fontes-2026-09-24.zip`).
  2. Ao alterar arquivos, mantenha a paridade entre os fontes e o `index.html` gerado.
  3. Siga o padrão de commit duplo do repositório:
     - 1º commit: `v1.38.2: atalho Relatórios na barra lateral para o Tabelião`
     - 2º commit: `versoes: pacote v1.38.2 (fontes, ...)`

---

### 6. Roteiro de Implementação no Front-End (`cn2o-hub/index.html`)

#### 6.1. Adicionar o Botão na Barra Lateral (`<nav class="lat-nav">`)

No arquivo `index.html` (por volta da linha ~2844 a 2853), localize o `<nav class="lat-nav">` e adicione o botão dos Relatórios logo após a "Agenda do Tabelião" (ou antes de "Documentos"):

```html
<!-- v1.38.2: Atalho direto para os Relatórios das Escreventes (restrito ao Tabelião) -->
<button class="nav-item" id="navRelatorios" data-nav="relatorios" type="button" hidden>
  <span class="nav-ico" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"></line>
      <line x1="12" y1="20" x2="12" y2="4"></line>
      <line x1="6" y1="20" x2="6" y2="14"></line>
    </svg>
  </span>
  Relatórios
</button>
```

> **Atenção:** O atributo `hidden` deve estar presente no HTML inicial para evitar qualquer "flash" visual de renderização para escreventes antes da validação da sessão.

---

#### 6.2. Controle de Visibilidade Exclusiva para o Tabelião (`SESSAO.admin`)

No arquivo `index.html` (por volta da linha ~5136), onde os controles administrativos são exibidos/ocultados com base em `SESSAO.admin`:

```javascript
// Exemplo existente no código:
el('btnEditarMural').hidden = !SESSAO.admin;

// Adicionar a linha abaixo:
if (el('navRelatorios')) el('navRelatorios').hidden = !SESSAO.admin;
```

Também garanta que na função de logout (`deslogar` ou `limparSessao`), o botão volte a ficar oculto:
```javascript
if (el('navRelatorios')) el('navRelatorios').hidden = true;
```

---

#### 6.3. Parametrizar `abrirEditorMural` para Aceitar Aba Inicial

No arquivo `index.html` (por volta da linha ~6854), modifique a assinatura da função `abrirEditorMural` para receber um parâmetro opcional `abaInicial`:

```javascript
// ANTES:
function abrirEditorMural() {
  if (!SESSAO.admin) return;
  const partida = MURAL || normalizarLocal({});
  ED = { copia: clone(partida), base: MURAL_META.atualizado_em || null, sujo: false, aba: 'avisos', editando: null, editor: null, confirmarSaida: false, eqEdit: null, aud: null, rel: null };
  abrirSub('editar');
}

// DEPOIS:
function abrirEditorMural(abaInicial) {
  if (!SESSAO.admin) return;
  const partida = MURAL || normalizarLocal({});
  ED = {
    copia: clone(partida),
    base: MURAL_META.atualizado_em || null,
    sujo: false,
    aba: abaInicial || 'avisos',
    editando: null,
    editor: null,
    confirmarSaida: false,
    eqEdit: null,
    aud: null,
    rel: null
  };
  abrirSub('editar');
}
```

*Como `abrirSub('editar')` invoca `ligarEditorMural()` que por sua vez executa `pintarAba()`, ao passar `'relatorios'` a aba de Relatórios é selecionada e renderizada instantaneamente.*

---

#### 6.4. Conectar o Clique do Menu Lateral

No ouvinte de eventos dos botões da barra lateral (por volta da linha ~10124):

```javascript
document.querySelectorAll('.lat-nav .nav-item').forEach(function (b) {
  b.addEventListener('click', function () {
    const n = b.dataset.nav;
    if (n === 'inicio') { irParaInicio(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (n === 'ferramentas') { irParaInicio('secFerramentas'); marcarNav('ferramentas'); }
    else if (n === 'links') { irParaInicio('linksUteis'); marcarNav('links'); }
    else if (n === 'avisos') { irParaInicio(); document.querySelector('[data-sub="avisos"]').click(); }
    else if (n === 'minha-agenda') { irParaInicio(); abrirSub('agenda'); }
    else if (n === 'calendario') { marcarNav('calendario'); abrirEmbutida('agenda', false); }
    else if (n === 'documentos') { window.open('https://drive.google.com/drive/folders/17jiEqA5ufl4L_7fKKvHzvWF23wvDnlWT', '_blank', 'noopener'); }
    else if (n === 'ajuda') { const v = el('veuAjuda'); v.hidden = false; v.classList.add('aberto'); }
    // NOVO: Abertura direta dos Relatórios das Escreventes
    else if (n === 'relatorios') {
      marcarNav('relatorios');
      abrirEditorMural('relatorios');
    }
  });
});
```

---

#### 6.5. Fechamento do Modal e Restauração de Navegação

Na função `fecharSubMural` (por volta da linha ~5745):

```javascript
function fecharSubMural(forcar) {
  // ... validações de alterações pendentes existentes ...
  el('veuMural').classList.remove('aberto');
  ED = null;
  // Se fechou a tela vindo de relatórios, retorna a marcação da barra lateral para 'inicio'
  marcarNav('inicio');
}
```

---

### 7. Critérios de Aceitação e Testes de Validação

1. **Sessão do Tabelião (`cesar.bravo` / admin):**
   - O item `Relatórios` aparece na barra lateral com ícone de gráfico/barras alinhado aos demais itens.
   - Ao clicar, abre imediatamente o painel com a aba **Relatórios** selecionada e carregando status, prévia e envios de `/hub/relatorios/*`.
   - Ao fechar no botão `✕`, o modal fecha e o item ativo da barra lateral volta para `Início`.
   - Tema escuro e tema claro: alto contraste (texto escuro sobre fundo claro na área do relatório, tamanho ≥ 14px, sem cinza-claro).
2. **Sessão de Escrevente (Camily, Romênia, Lara, Josilene, Jonas, etc.):**
   - O item `Relatórios` **não existe visualmente** na barra lateral (`hidden = true` / `display: none`).
   - Requisições manuais ou tentativas de abrir `GET /hub/relatorios/*` respondem `403 Proibido`.
3. **Usuário Deslogado:**
   - O item `Relatórios` permanece com atributo `hidden`.

---

## 8. Resumo Geral de Boas Práticas e Segurança

- ❌ **NUNCA exponha credenciais ou tokens:** Nem no Git, nem em logs do cliente ou do servidor.
- ❌ **NÃO remova webhooks ativos da `BASE_URL` atual.**
- ✅ **Acessibilidade do Tabelião:** Manter tipografia Atkinson Hyperlegible / Lato, tamanho de fonte confortável (≥ 14px) e alto contraste estrito para atender à condição de astigmatismo do Tabelião.
- ✅ **Convenção de Commits:** Commits descritivos no backend e no frontend, respeitando as branches de release do cartório.
