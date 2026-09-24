# Hub de Protocolo CN2O — Backend (Railway)

Serviço que recebe o formulário do balcão e executa o Momento 1:
número atômico → cartão no Trello (título, campos, checklist DOSSIÊ, labels, prazo)
→ recibos WhatsApp em disparo duplo. Também re-hidrata os campos personalizados
quando o cartão viaja entre quadros (webhook) e serve a lista ⚙ Parceiros.

## Deploy (≈ 20 min)

1. **Repositório**: suba esta pasta num repositório GitHub.
2. **Railway**: New Project → Deploy from GitHub → selecione o repositório.
3. **Postgres**: no projeto, Add Service → Database → PostgreSQL.
   O Railway injeta `DATABASE_URL` sozinho (conecte a variável ao serviço web).
4. **Variáveis**: copie `.env.example` para as Variables do serviço e preencha:
   - `HUB_KEY`: o código que os balcões vão digitar uma vez
   - `PROTOCOLO_INICIAL`: **último protocolo manual + 1** (só vale na 1ª execução)
   - `TRELLO_KEY` / `TRELLO_TOKEN`
   - `WHATS_URL` / `WHATS_TOKEN` da plataforma intermediária
   - `BASE_URL`: a URL pública que o Railway der ao serviço
5. **Power-Up**: ative "Campos Personalizados" nos 7 quadros
   (Menu do quadro → Power-Ups → Custom Fields). 1 clique por quadro.
6. **Setup único**: no shell do Railway (ou local com o .env):
   `npm run setup`
   → cria os 11 campos nos 7 quadros, as labels ⭐ Parceiro/Urgente,
   registra os webhooks e imprime o `LISTA_ENTRADA=` para colar nas variáveis.
7. Redeploy. `GET /saude` deve responder `{"ok":true}`.

## Endpoints

- `POST /protocolo` (header `X-Hub-Key`) — payload do formulário; responde
  `{ numero, card_url }`.
- `GET /parceiros` — parceiros preferenciais (cache 10 min) para a sugestão
  automática do formulário.
- `POST /webhook/trello` — re-hidratação de campos ao mover cartão entre quadros e,
  com `TRELLO_SECRET`, rastreio dos cartões para os relatórios das escreventes (v1.38).
- `/hub/relatorios/*` (sessão de administrador) — relatórios semanal e mensal das
  escreventes por e-mail. Instalação e significado dos números: `RELATORIOS.md`.

## Template WhatsApp

Registrar na plataforma o template `recibo_protocolo` (pt_BR), corpo:

    *CARTÓRIO DE NOTAS DO 2º OFÍCIO — ITABAIANA/SE*

    Recibo de protocolo
    Ato: {{1}}
    {{2}}: {{3}}
    Apresentante: {{4}}

    *Nº do protocolo: {{5}}*

    Guarde este número: use-o para consultar o andamento do seu ato em
    cn2oita.com.br ou informe-o à atendente do cartório.

Aguardar a aprovação da Meta ANTES do go-live.

## Corte de numeração

No dia escolhido: preencher `PROTOCOLO_INICIAL`, subir o serviço, **desligar o
Zapier da numeração** no mesmo momento. A tabela `contador` grava a semente uma
única vez; depois disso a variável é ignorada.
