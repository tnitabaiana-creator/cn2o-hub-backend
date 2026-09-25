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
   - `HUB_KEY`: **não é mais usada** desde a v1.39.2 (não zera senha nem libera o teste do
     WhatsApp, que passou a exigir sessão de administrador). Pode apagar da Railway.
   - `CORS_ORIGENS` (opcional): sites que podem chamar esta API pelo navegador, separados por
     vírgula. Padrão: `https://cn2o-hub.netlify.app` (antes da v1.39.2, qualquer site).
   - `HUB_CODIGO_ADMIN` (emergência, opcional): com 16+ caracteres, vale como código de
     primeiro acesso **só para os administradores** (HUB_ADMINS) e redefine a senha deles.
     Use quando o Tabelião ficar sem acesso e **apague a variável em seguida**.
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

## Acesso (v1.39.1)

- `POST /login { login, senha }` — resposta única para usuário inexistente, sem senha ou
  senha errada; 5 falhas por login (ou 20 por IP) em 15 min bloqueiam por 15 min (429).
- `POST /definir-senha { login, codigo, senha }` — primeiro acesso **só com o código de
  uso único** (48 h) que o Tabelião gera na aba Equipe do Hub (cadastro, "Gerar código" ou
  "Zerar senha"). Sem código, ninguém cria senha.
- Senhas em scrypt (N=2^14, r=8, p=5); hashes antigos migram no próximo login. No banco,
  a sessão guarda só o SHA-256 do token. Falhas e bloqueios entram na trilha (ação "acesso").
- `POST /admin/resetar-senha` (HUB_KEY) **foi removida**.
- v1.39.2: cabeçalhos de segurança e CORS só do site (protecao.js); erros genéricos;
  `/whats/status` e `/whats/testar` só com sessão de administrador (telefones mascarados).

## IA e prompt injection (v1.39.3)

- O texto colado e o texto lido dos anexos (OCR) entram no prompt entre marcadores com um
  código aleatório por chamada (`=== TÍTULO [CÓDIGO] ... === FIM TÍTULO [CÓDIGO] ===`), e a
  regra fixa de segurança vai no fim de toda instrução de sistema (ia-defesa.js).
- A resposta traz `alertas[]` quando um ônus do documento (penhora, hipoteca…) some da
  resposta ou quando o documento tem texto que parece dar ordens à IA.
- Limites por pessoa, no Hub e na Plataforma de Agentes (limite-ia.js): `HUB_IA_LIMITE`
  análises a cada 10 min (padrão 15) e teto diário `HUB_IA_TETO_DIA_USD` (padrão US$ 5,
  estimado pela tabela `consumo`, que agora inclui o OCR).
- Gerador de Minuta: só o Tabelião, até `HUB_GERADOR_LIBERADO=1`. O Google Doc não nasce
  sozinho: `POST /hub/minuta-doc` cria o documento da última minuta gerada pela pessoa.

## Dados pessoais (v1.39.4)

- Minutas guardadas: identificador aleatório, abertas só por quem guardou (ou pelo
  Tabelião) e apagadas depois de `HUB_MINUTAS_DIAS` (padrão 90).
- Logs sem telefone inteiro (só os 4 últimos dígitos), sem os dados do recibo e sem o
  começo da resposta da transposição. CPF digitado na pesquisa do acervo entra mascarado
  na trilha (`***.456.789-**`).
- `apps-script/EnviarRelatorio.gs` só envia para a propriedade `DESTINATARIOS` do script.

## Endpoints

- `POST /protocolo` (sessão, `X-Auth-Token`) — payload do formulário; responde
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
