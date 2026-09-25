# Relatórios das escreventes (v1.38)

O hub acompanha os cartões no Trello e envia por e-mail os relatórios semanal e mensal das escreventes.

1. O webhook do Trello que o hub já recebe (`POST /webhook/trello`) passa a gravar cada movimento de cartão dos quadros **00. Protocolo/Cadastro**, **01. TABELIÃO** e **02. ESCREVENTE …**.
2. O hub calcula quanto tempo o cartão ficou em cada lista, em **horas úteis**.
3. Toda **segunda-feira às 8h** sai o relatório da semana anterior. No **1º dia útil do mês às 8h** sai o do mês anterior. O e-mail vai em HTML, com um CSV anexo.

Não há dependência nova: só `express` e `pg`. O agendador é interno.

## Arquivos

| Arquivo | Função |
|---|---|
| `rastreio.js` | Confere a assinatura do webhook e reconstrói cada cartão: passagens, pendências e conclusão. |
| `db-relatorios.js` | Cria as 7 tabelas e cadastra as 5 escreventes e os pesos iniciais. Roda no boot. |
| `horas-uteis.js` | Expediente, feriados e horas úteis (fuso America/Maceio). |
| `tipos-ato.js` | Tipo de ato a partir do título do cartão, quando o cartão não nasceu pelo e-Protocolo. |
| `reports.js` | Motor de cálculo: medianas, P75, custo pessoal e afinidade. |
| `relatorios.js` | Monta, envia e registra os relatórios. Rotas `/hub/relatorios/*`. |
| `relatorio-email.js` | HTML do e-mail (identidade do CN2O), CSV e envio. |
| `agendador.js` | 07:00 reconciliação; seg 08:00 semanal; 1º dia útil 08:00 mensal. |
| `carga_retroativa.js` | Busca no Trello o histórico desde 01/06/2026 (`npm run carga`). |
| `previa.js` | Gera o relatório em arquivo, sem enviar (`npm run previa`). |
| `apps-script/EnviarRelatorio.gs` | Web app que envia o e-mail pelo Gmail do cartório. |
| `test/` | Testes unitários e de integração (`npm test`). |

No `server.js` mudaram três pontos:
- **Webhook:** a rota lê o corpo bruto para conferir a assinatura. A assinatura decide **só o rastreio**. A re-hidratação dos campos continua igual, com ou sem assinatura válida, para que um segredo mal configurado não pare os quadros.
- **Rotas:** `/hub/relatorios` é montado antes de `/hub`.
- **Boot:** as tabelas dos relatórios são criadas depois das do hub. Se falharem, o hub sobe assim mesmo, só que sem rastreio nem agendador.

## Instalação (Railway)

1. **Fazer o deploy** desta versão. As tabelas são criadas na inicialização e `GET /saude` continua respondendo `{"ok":true}`.
2. **Preencher as variáveis** (veja o bloco v1.38 do `.env.example`):
   - `TRELLO_SECRET`: o **Segredo** da mesma chave `TRELLO_KEY` do hub, em trello.com/power-ups/admin → a chave. Sem ele, nada entra nos relatórios.
   - `RELATORIO_EMAIL_WEBAPP_URL` e `RELATORIO_EMAIL_SECRET`: publique antes `apps-script/EnviarRelatorio.gs` na conta Google do cartório (as instruções estão no topo do arquivo). Não há SMTP porque a Railway o bloqueia no plano Hobby.
     - Desde a v1.39.4, o script exige a propriedade **DESTINATARIOS**: os e-mails que podem receber, separados por vírgula (os de `RELATORIO_EMAIL_PARA` e o de homologação). Um endereço fora da lista faz o envio falhar com "destinatário fora da lista".
   - Opcional: `RELATORIOS_ADMINS`, com os logins que podem ver os relatórios. Sem ela, valem os `HUB_ADMINS`, cujo padrão é `cesar.bravo`.
   - Enquanto `RELATORIO_EMAIL_PARA` estiver vazia, os e-mails vão só para **sergiolagofula2@gmail.com**, com [HOMOLOGAÇÃO] no assunto.
3. **Webhooks: nada a registrar.** Os que o `setup.js` já criou nos quadros 00, 01 e das escreventes servem para o rastreio.
   - Confira em `GET /hub/relatorios/status` → `webhooks`: `quadros_sem_webhook` deve estar vazio.
   - Se `outras_urls` mostrar um endereço antigo, os webhooks apontam para lá. Nesse caso, grave `TRELLO_WEBHOOK_URL` ou registre de novo com `npm run setup`. O `setup.js` é idempotente, mas também revisa campos e etiquetas dos quadros.
4. **Fazer a carga retroativa**, uma vez: `npm run carga` no console do serviço, ou `POST /hub/relatorios/carga {"desde":"2026-06-01"}`.
   - Pode repetir quando quiser, sem duplicar nada.
   - No fim, a carga lista os títulos cujo tipo de ato não foi reconhecido.
5. **Conferir** com a sessão do Tabelião (cabeçalho `X-Auth-Token`, o mesmo login do hub):
   - `GET /hub/relatorios/status` mostra:
     - eventos recebidos e conclusões;
     - se o webhook está assinado e quantas assinaturas falharam desde o último reinício;
     - os webhooks e o e-mail.
   - `GET /hub/relatorios/previa?tipo=semanal&ref=2026-09-28` mostra o e-mail como sairia. `&formato=csv` baixa o anexo; `&formato=json` mostra os números.
   - `POST /hub/relatorios/enviar {"tipo":"semanal","ref":"2026-09-28"}` envia na hora. O envio manual não impede o automático.
   - `GET /hub/relatorios/envios` mostra o histórico de envios.
   - Prévia, envio e carga ficam na trilha de auditoria do hub (ação `admin`, ferramenta `relatorios`), sem o conteúdo do relatório.
6. **Entrar em produção:** preencha `RELATORIO_EMAIL_PARA` com os e-mails do Tabelião.

Sem o site do hub, o token sai de `POST /login {"login":"cesar.bravo","senha":"…"}`. No console da Railway, `npm run previa -- --tipo semanal --ref 2026-09-28` grava o relatório em `relatorios-saida/` sem precisar de login.

## O que cada número quer dizer

Todos os tempos são em **horas úteis**: expediente 08:00–12:00 e 13:00–17:00, de segunda a sexta, sem feriados nacionais, sem o 8/7 de Sergipe e sem os de `FERIADOS_EXTRA`.

Desde a v1.38.4 o e-mail e o CSV usam nomes do dia a dia. Entre parênteses, o nome interno (campo no código e no banco).

- **Tempo total** (`horas_mesa`, mediana): da entrada do cartão no quadro da escrevente até o Finalizado, contando as esperas. É o valor típico: metade dos atos sai mais rápido.
- **Mais demorados** (`p75_mesa`, percentil 75): 3 em cada 4 atos saem dentro desse tempo; 1 em cada 4 demora mais. Na tabela por tipo de ato, a coluna vale para o tempo de trabalho (`p75_ativa`).
- **Tempo de trabalho** (`horas_ativas`, antes "custo pessoal"): horas em Revisar Minuta e Ajuste/Retorno no quadro dela. Conferência, PENDÊNCIAS/AGUARDA e assinatura não contam, porque não dependem dela.
- **Tempo vs. equipe** (`indice_custo`): tempo de trabalho dividido pela mediana da equipe no mesmo tipo de ato, nos últimos 90 dias. 1,00 é o ritmo da equipe; 0,80 = 20% mais rápida; 1,20 = 20% mais lenta.
- **Onde rende mais e menos** (`afinidade`): quantas vezes ela é mais rápida que a equipe num tipo de ato (verde = rende mais, vinho = rende menos). Só aparece com pelo menos 3 atos dela desse tipo em 90 dias.
- **Tempo esperado** (`referencia`): o tempo de trabalho normal do tipo de ato — mediana da equipe em 90 dias ou, sem 3 atos, `pesos_ato.horas_referencia`.
- **Pontos**: soma dos pesos dos atos concluídos (tabela `pesos_ato`).
- **Voltou p/ ajuste** (`taxa_retorno`): parte dos atos concluídos que passou por Ajuste/Retorno.
- **Tipo de ato**: vem do registro do e-Protocolo (`protocolos.card_id`) quando o cartão nasceu por lá; senão, do título do cartão.
- Cartões que entraram na mesa antes do início do rastreio contam no volume, mas não nos tempos.

## Ajustes (no banco, sem novo deploy)

- **`escreventes`**: login, quadro, lista Finalizado e se está ativa.
  - Para uma escrevente nova: inclua uma linha e rode `npm run carga -- --reprocessar`.
  - O quadro dela também precisa de webhook: acrescente-o a `BOARDS_ESCREVENTES` e rode `npm run setup`.
- **`pesos_ato`**: `peso` (os pontos) e `horas_referencia` (custo pessoal esperado enquanto a equipe não tiver 3 atos daquele tipo em 90 dias).
  - Os valores iniciais são estimativas; calibre com o Tabelião.
- **`EXPEDIENTE` e `FERIADOS_EXTRA`** (variáveis): o feriado municipal de Itabaiana entra em `FERIADOS_EXTRA`.
  - Depois de mudar, rode `npm run carga -- --reprocessar` para recalcular as horas.
- **Tipo de ato não reconhecido**: acrescente a regra em `tipos-ato.js` e reprocesse.

## Testes

- `npm test` roda os testes unitários. O repositório não versiona `node_modules`: rode `npm install` antes.
- Com `TEST_DATABASE_URL=postgres://…` roda também a integração. Use um banco **descartável**, porque o teste apaga as tabelas do rastreio e a de protocolos.
- A integração sobe o `server.js` do hub apontado para um Trello simulado (`test/trello-falso.js`) e verifica:
  - webhooks assinados e não assinados;
  - a re-hidratação dos campos;
  - a carga retroativa;
  - o relatório;
  - o acesso por sessão às rotas `/hub/relatorios`.

## Atendimentos do balcão (NextQS) — v1.39, sem n8n

O servidor do Hub fala direto com a API do NextQS e substitui os workflows do n8n "CN2O · NextQS → Painel de Atendimentos" e "CN2O · NextQS → Relatório mensal (PDF)", com a mesma regra de cálculo.

| Arquivo | O que faz |
|---|---|
| `nextqs.js` | Cliente da API: `GET /v1/organization/reports`, token Bearer, 500 por página, 404 = período sem senhas. |
| `atendimentos.js` | Agrupa as senhas por dia, fila, atendente, guichê e unidade; grava em `atendimentos_dia` e a situação em `atendimentos_status`; rotas `/hub/relatorios/atendimentos/*`. |
| `atendimentos-pdf.js` | O PDF mensal de 2 folhas, com a identidade CN2O. |

- **Instalação:** grave `NEXTQS_TOKEN` na Railway (Next Manager → API; é o mesmo token da credencial "NextQS API" do n8n). As tabelas sobem sozinhas no boot.
- **Carga do histórico:** na aba Relatórios → Atendimentos → "Carga do histórico (uso do suporte)", escolha a data e rode uma vez. Ela busca em janelas de 90 dias, e repetir não duplica nada.
- **Agenda** (`agendador.js`): de segunda a sexta às 17h, coleta hoje e os 3 dias anteriores; às 7h do 1º dia útil, envia o PDF do mês anterior por e-mail aos destinatários dos relatórios (`RELATORIO_EMAIL_PARA`). A trava contra envio em dobro é `atendimentos_status` (chave `relatorio_AAAA-MM`).
- **Rotas** (só o Tabelião): `GET /hub/relatorios/atendimentos?desde=`, `POST …/atualizar {inicio, fim}` (até 92 dias), `POST …/carga {desde}`, `GET …/pdf?mes=AAAA-MM`, `POST …/enviar {mes}`.
- **Desligar o n8n:** depois de alguns dias com o Hub coletando em paralelo e os números batendo, desative no n8n os dois workflows acima. Os PDFs antigos continuam na pasta do Drive.
- **Testes:** `test/atendimentos.test.js` (cálculo, cliente da API com respostas simuladas, coleta, PDF, agenda e anexo binário do e-mail).
