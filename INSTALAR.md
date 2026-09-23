# Hub de Agentes CN2O — instalação

Este pacote **acrescenta** o módulo de redação de atos ao `cn2o-hub-backend` que já
roda no Railway. Não substitui nada: o Hub de Protocolo (numeração, Trello, recibos,
login) continua igual. São 3 arquivos novos de código, 1 pasta de dados, 1 pasta
`public/` e **4 edições cirúrgicas** no `server.js` e no `package.json`.

Tempo estimado: 20 minutos, sendo 15 de espera de deploy.

---

## 1. Arquivos a copiar para a raiz do repositório

```
cn2o-hub-backend/
├── agentes.js          ← novo   (rotas do módulo)
├── db-agentes.js       ← novo   (schema e consultas)
├── gemini.js           ← novo   (cliente da API do Gemini)
├── docx.js             ← novo   (geração do arquivo do Word)
├── seed-agentes.js     ← novo   (carga inicial dos agentes)
├── public/
│   └── index.html      ← novo   (a interface inteira, arquivo único)
└── dados/
    ├── agentes/        ← novo   (7 prompts vindos dos Gems)
    └── templates/      ← novo   (14 templates vindos do Drive)
```

Os arquivos que já existem — `server.js`, `db.js`, `auth.js`, `trello.js`,
`whats.js`, `setup.js` — só recebem as edições do item 2.

---

## 2. As quatro edições

### 2.1 `package.json` — dois scripts

Dentro de `"scripts"`, acrescente a última linha:

```json
"scripts": {
  "start": "node server.js",
  "setup": "node setup.js",
  "seed:agentes": "node seed-agentes.js"
}
```

Nenhuma dependência nova. O módulo usa `express` e `pg`, que já estão lá, mais o
`fetch` nativo do Node 18. **Não rode `npm install` de nada.**

### 2.2 `server.js` — o parser de JSON precisa deixar `/agentes` passar

Este é o único ponto delicado. Hoje existe, perto do topo:

```js
app.use(express.json({ limit: '256kb' }));
```

256 kb não cabe uma matrícula escaneada. E como esse parser roda **antes** das
rotas, ele rejeitaria o upload com 413 antes de o módulo ver a requisição.
Substitua aquela linha por estas três:

```js
// O corpo pequeno continua com o limite antigo; /agentes tem parser próprio
// (24 MB) porque recebe PDF e imagem em base64.
const jsonPequeno = express.json({ limit: '256kb' });
app.use((req, res, next) =>
  req.path.startsWith('/agentes') ? next() : jsonPequeno(req, res, next));
```

### 2.3 `server.js` — montar o módulo e servir a interface

Logo **depois** do bloco que define `exigeSessao` e **antes** das rotas de
protocolo, acrescente:

```js
// Módulo de agentes: herda sessão, banco e usuários do hub que já existe.
app.use('/agentes', exigeSessao, require('./agentes'));

// A interface (public/index.html). Fica por último entre os middlewares para
// não sombrear nenhuma rota da API.
app.use(express.static(require('path').join(__dirname, 'public')));
```

### 2.4 `server.js` — criar as tabelas no boot

No fim do arquivo está:

```js
db.init().then(() => app.listen(...)).catch(...);
```

Troque por:

```js
db.init()
  .then(() => require('./db-agentes').init())
  .then(() => app.listen(process.env.PORT || 3000, () =>
    console.log('CN2O hub no ar')))
  .catch(e => { console.error('falha no boot:', e); process.exit(1); });
```

O `db-agentes.init()` é idempotente (`CREATE TABLE IF NOT EXISTS`), igual ao
`db.init()`. Pode rodar em todo deploy sem risco.

---

## 3. Variáveis de ambiente (Railway → cn2o-hub-backend → Variables)

Só uma é obrigatória:

| Variável | Valor | Obrigatória |
|---|---|---|
| `GEMINI_API_KEY` | a chave do Google AI Studio | **sim** |
| `GEMINI_MODEL_EXTRACAO` | `gemini-3.5-flash-lite` | não (é o padrão) |
| `GEMINI_MODEL_REDACAO` | `gemini-3.8-flash` | não (é o padrão) |
| `LIMITE_UPLOAD` | `24mb` | não |
| `CAMBIO_USD_BRL` | `5.12` | não (só para a tela de consumo) |
| `AGENTES_ADMIN` | logins extras com poder de editar agentes, separados por vírgula | não |

A chave sai de **aistudio.google.com → Get API key**. Crie no mesmo projeto do
Google Cloud onde você quer a fatura, e ative o faturamento — no nível gratuito
os limites de requisição por minuto derrubam o uso de um cartório.

**Sobre os nomes dos modelos:** o Google troca a nomenclatura com frequência. Por
isso os IDs são variáveis de ambiente e não estão no código. Depois do primeiro
deploy, abra `/agentes/modelos` logado — ela lista o que a sua chave enxerga de
verdade. Se o ID configurado não estiver na lista, corrija a variável; não é
preciso mexer em código.

---

## 4. Carregar os agentes

Depois do deploy, no Railway → serviço → aba **Console**:

```
npm run seed:agentes
```

Deve imprimir 17 agentes gravados. Para recarregar só um:

```
npm run seed:agentes -- cdh
```

O seed é comando manual de propósito: ele **sobrescreve** o prompt e o template
com o conteúdo dos arquivos. Se você editar um agente pela tela e depois rodar o
seed, a edição da tela se perde (mas fica guardada em `agente_versoes`).

---

## 5. Conferir

| Endereço | Esperado |
|---|---|
| `/saude` | `{"ok":true}` — o hub antigo continua de pé |
| `/` | a tela de login do hub de agentes |
| `/agentes` (logada) | a lista dos 17 agentes |
| `/agentes/modelos` (logada) | os modelos que a chave enxerga |

Login: as mesmas contas de sempre (`cesar.bravo`, `josi.silva`, `lara.silva`,
`romenia.oliveira`, `jonas.aragao`, `camily.jesus`, `milvo.neto`). Quem ainda não
definiu senha cai no primeiro acesso.

---

## 6. Os 17 cards

**Ferramentas** (apoio, rodam antes do ato)
- Qualificação do Imóvel — o Not-Extrator 8.0
- Extração de Certidões

**Escrituras**
| Card | Prompt | Template |
|---|---|---|
| Compra e Venda | Assessor CN2O CV v12.0 | Módulo 10 |
| Cessão de Direitos Hereditários | Assessor CDH | Módulo 3 |
| Negócio Misto (Meação + Herança) | Assessor CDH | Módulo 3-B |
| Cessão de Direitos Possessórios | Assessor CDP v2.0 | Módulo 5 |
| Procuração Pública | Procurações v1.0 | — |
| Doação | prompt-base | Módulo 1 |
| Dação em Pagamento | prompt-base | Módulo 2 |
| Inventário e Partilha | prompt-base | Módulo 6 |
| Divórcio Consensual | prompt-base | parametrizado |
| União Estável | prompt-base | UE |
| Testamento Público | prompt-base | Módulo 8 |
| Ata de Posse (Usucapião) | prompt-base | Módulo 4 |
| Ata de Constatação Digital | prompt-base | Módulo 9 |
| Direito Real de Laje | prompt-base | LAJE |

**Comunicação**
- Redator Oficial do 2º Ofício

Dez desses atos não tinham Gem: rodam com um prompt-base que carrega os mesmos
princípios invioláveis dos seus Gems (proibido inventar, `[VERIFICAR]`,
transcrição literal do imóvel, o template manda, valores por extenso, divergência
vai para os alertas) aplicados ao template do módulo. **Teste um ato real de cada
antes de soltar para as meninas** — o prompt-base é um ponto de partida honesto,
não um substituto de um Gem afinado.

---

## 7. O que ficou de fora, e por quê

**Word nativo (.docx).** O download sai como `.doc` — HTML no dialeto do Word,
com Times New Roman 12, margens ABNT, parágrafo justificado com recuo. Word,
LibreOffice e Google Docs abrem preservando tudo, e "Salvar como .docx" é um
clique. Escolhi assim para não acrescentar a primeira dependência pesada do
projeto nem um ponto de falha no build do Railway, num ganho que o fluxo real da
serventia não usa. Se um dia precisar de `.docx` de verdade (macro, mala direta,
campos de mesclagem), troca-se só o `docx.js`.

**Cache de prompt.** Os prompts de sistema são grandes (o de Compra e Venda tem
69 mil caracteres) e vão inteiros a cada chamada. O cache explícito do Gemini
cortaria perto de um quarto da conta, mas cobra armazenamento por hora e só
compensa com volume constante. Deixei para depois de você ver a fatura real de um
mês. É mudança localizada no `gemini.js`.

**Anexar a minuta ao cartão do Trello.** O `trello.js` já tem tudo o que falta
(`obterCartao`, `aplicarCampos`) e o `minutas.protocolo` já liga as duas pontas.
São umas 20 linhas — não fiz porque não sei em qual campo ou anexo você quer a
minuta, e chutar isso mexeria nos seus quadros de produção.

**Aviso no WhatsApp quando a minuta fica pronta.** Mesmo motivo: o `whats.js`
está pronto, falta decidir o gatilho e o template aprovado na Meta.

---

## 8. Um defeito que encontrei no caminho

O Gem **Not-Extrator 8.0** tem `</papel>` fechando uma tag `<papel>` que não
existe: o prompt começa direto em "Voce e o Agente de Qualificacao...". O texto
também está inteiro sem acentuação, o que é estranho num prompt que exige
transcrição literal. Copiei exatamente como está — corrigir por conta própria um
prompt de produção seria pior que o defeito. Vale abrir `dados/agentes/not-extrator.md`
e arrumar antes de rodar o seed.

## v1.37.1 — instalação pelo Tabelião (sem rodar setup.js)

Rotas do Hub, só para a sessão de administrador (`X-Auth-Token` do login cesar.bravo), idempotentes:

- `POST /hub/admin/trello/campo-preco` — cria o campo personalizado **"Preço ajustado"** (texto) nos
  quadros BOARD_00, BOARD_01 e BOARDS_ESCREVENTES. O servidor o preenche em cada protocolo que traz preço.
- `POST /hub/admin/trello/etiquetas-cert` — cria as etiquetas **"Urgente"** e **"Doc. pendente"** no BOARD_04.
- `GET /hub/admin/whats/template-cert` — devolve a definição do template do recibo do CERT (texto pronto
  para o WhatsApp Manager). `POST` na mesma rota cadastra pela API da Meta quando `WHATS_WABA_ID` existe
  (o token precisa da permissão `whatsapp_business_management`). Aprovado o template, gravar
  `WHATS_TEMPLATE_CERT=<nome>`; sem a variável, o CERT usa o recibo comum.

Observação: a lista de campos/etiquetas de cada quadro fica em memória no servidor (trello.js); campo ou
etiqueta criados passam a valer a partir do reinício seguinte do serviço.
