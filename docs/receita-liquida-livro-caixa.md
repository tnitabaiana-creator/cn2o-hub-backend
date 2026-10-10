# Receita líquida e Livro-caixa do Tabelião

Regra gerencial solicitada pelo titular em 09/10/2026: receita líquida = bruto × 0,704306. Os 29,5694% são um desconto conjunto de FERD e repasses; não são aplicados novamente no Livro-caixa. Esta configuração não altera a tabela de emolumentos/FERD das calculadoras.

## Fonte e preservação

`produtividade_mes.dados` permanece bruto, com lançamentos da Pesquisa de Produtividade. O CSV de cadastro de escrituras do Extra Digital usado na contagem oficial não tem campos monetários. Não se deduz faturamento de quantidade, tipo de escritura ou usuário criador.

`GET /hub/relatorios/produtividade` mantém `dados` e acrescenta:

- `dados_liquidos`: mesma estrutura, valores monetários líquidos em reais, quantidades intactas; `pessoas[].total_bruto` mantém o critério original de perfil mesa/balcão. Marcadores `base_receita: "liquida_apos_repasses"` e `versao_financeira` impedem reimportar esta projeção como fonte bruta.
- `financeiro`: `bruto`, `repasses`, `receita_liquida` em reais; `centavos` com os mesmos nomes em inteiros; `percentual_repasses: 29.5694`, `criterio`, `versao`, `notas`, `arredondamento`.
- `financeiro.base_individual: "usuario_financeiro"` e `financeiro.receita_por_autor: {status:"pendente_vinculo_financeiro_por_ato",colaboradores:[],total_atribuido:null}` deixam explícita a lacuna: o usuário da Pesquisa de Produtividade não comprova autoria da escritura. Igualdade de nome, quantidade, perfil ou cartão não transfere receita a um autor; é preciso vínculo documental de cada lançamento ao ato e ao responsável confirmado.
- `analise_status`: `atual`, `ausente` ou `anterior_base_obsoleta`. Análises antigas continuam no banco e em `analise_historica`, mas `analise` fica nula até gerar análise com a base atual. A análise nova recebe somente indicadores líquidos e identificação de usuário financeiro, sem presumir autoria da lavratura.

O módulo `receita-liquida.js` é a regra comum. Calcula centavos inteiros com razão exata 704306/1000000, arredondamento para o centavo mais próximo e maiores restos para reconciliar grupos completos. Fonte incompleta não ganha valores inventados: o retorno informa `notas`. Séries completas por pessoa são reconciliadas com seus totais; os dias usam a soma dessas parcelas. Despesas e IR não compõem os indicadores de produtividade.

`GET` reflete sempre 29,5694%, inclusive com configuração legada de 16,67%. `POST /config` aceita só `{corte}`; preserva `ir` legado para compatibilidade e usa o percentual atual. `ferd`/`ir` enviados por clientes antigos são validados com até quatro casas, mas o percentual aplicado continua fixado pela regra atual. Não existe alteração automática do JSON bruto ou dos estados V3.

## Receita no relatório das escreventes

`relatorios.gerar()` incorpora `rel.receita_mensal` usando o total bruto mensal integral de `produtividade_mes`, sem filtro da família Escritura ou da contagem de registrados. O primeiro cartão do HTML e a abertura do texto mostram somente a receita líquida e a competência. O CSV acrescenta uma seção mensal separada, conservando as colunas de cartões. Nenhum envio ou agendamento é disparado por essa leitura; relatórios já enviados permanecem históricos.

Contrato: `{escopo:"competencias_mensais",base_individual:"usuario_financeiro",criterio,periodo_relatorio:{inicio,fim},competencias:[{mes,status,receita_liquida,receita_liquida_centavos,lancamentos,dias_uteis,media_dia_util,fonte,importado_em}],receita_por_autor:{status:"pendente_vinculo_financeiro_por_ato",colaboradores:[],total_atribuido:null}}`.

A página pode consultar diretamente `GET /hub/relatorios/receita-mensal?tipo=mensal&ref=2026-10-01`, que retorna `{receita_mensal}` e só lê a fonte financeira, sem acessar Trello ou gerar/enviar um relatório inteiro. Exige a mesma sessão de administrador dos relatórios, retorna `private, no-store`, e conserva a semântica das prévias: mensal consulta o mês anterior à referência; semanal consulta a semana civil anterior à semana da referência. Assim, `tipo=semanal&ref=2026-10-05` cobre 28/09–04/10 e traz setembro/outubro separadamente. Datas impossíveis são rejeitadas com 400.

Uma semana entre meses traz as competências separadamente, com seus valores mensais; não soma os meses como receita semanal nem rateia valores por dias/cartões. `status` distingue `disponivel`, `ausente` e `indisponivel`; falta de receita não vira zero. Média por dia útil usa o líquido mensal e os dias úteis declarados na fonte, ambos identificados como mensais. Não existem despesas, IR ou receita individual por lavratura nesse bloco.

A projeção usa integralmente o total declarado pela fonte, mas agregados históricos sem metadados de extração não comprovam por si sós que todos os atos e dias foram exportados. A rotina operacional deve conferir filtros, completude, corte e original antes de substituir uma competência. O JSON financeiro atual conserva agregados por usuário, sem a identificação monetária de cada ato: extrair somente a auditoria de lavratura não resolve essa segunda lacuna.

## Livro-caixa privado

Todas as rotas exigem sessão cujo login seja **exatamente `cesar.bravo`**. Outra conta de administrador também recebe 403. As respostas são `private, no-store`. Nenhuma rota lê o Controle de Despesas.

`GET /hub/livro-caixa`:

```json
{"criterio":"...","percentual_ir":27.5,"meses":[{"mes":"2026-10","receita":{"status":"disponivel","bruto":1000,"repasses":295.69,"receita_liquida":704.31,"centavos":{"bruto":100000,"repasses":29569,"receita_liquida":70431},"fonte":"Pesquisa fictícia","importado_em":"..."},"despesas":{"revisao":0,"total":null,"total_centavos":null,"fonte":null,"atualizado_por":null,"atualizado_em":null,"anexo":null},"projecao":{"saldo":null,"ir_projetado":null,"liquido_projetado":null,"centavos":null}}]}
```

A lista é a união de competências da receita e do Livro-caixa. Sem receita, `receita.status` é `ausente`; sem despesa confirmada, seu valor é `null`. Não se presume zero. Quando ambos existem: saldo = receita líquida − despesas; IR projetado = 27,5% × max(saldo, 0); líquido projetado = saldo − IR. A projeção gerencial não substitui apuração fiscal.

`POST /hub/livro-caixa/meses/AAAA-MM`:

```json
{"revisao_base":0,"total_despesas_centavos":10000,"fonte":"Total conferido no Livro-caixa do titular","anexo":{"nome":"livro.pdf","tipo":"application/pdf","base64":"..."}}
```

Total confirmado e fonte são obrigatórios. Zero é válido após conferência. Anexo é opcional: omitido mantém o existente; `null` retira somente o vínculo atual. O retorno é o objeto do mês com `receita`, `despesas` (revisão incrementada) e `projecao`. Revisão concorrente/desatualizada retorna 409, sem sobrescrever. A gravação inclui snapshot da receita de referência, hash, autoria, horário e histórico imutável em tabelas próprias; nunca modifica a fonte financeira.

Anexos PDF/XLS/XLSX/CSV têm até 10 MiB, validação de extensão/MIME/assinatura inicial e hash SHA-256. Os bytes ficam em PostgreSQL, sem execução, descompactação ou extração automática de valores. O limite JSON é 14 MiB para acomodar base64. XLS deve ser binário OLE; exportações HTML com extensão XLS não são aceitas.

- `GET /hub/livro-caixa/meses/AAAA-MM/historico` → `{mes, versoes:[{despesas,receita_referencia}]}`.
- `GET /hub/livro-caixa/anexos/:id` → bytes originais com `Content-Disposition: attachment`, MIME conferido, `nosniff` e CSP bloqueadora. Anexos antigos continuam acessíveis ao titular pelo histórico.

As tabelas são criadas de forma idempotente e lazy por `migrations/20261009-livro-caixa.sql`. Publicar exige backend antes do frontend e verificação autenticada; não executar `npm run setup`. Reversão de versão do aplicativo preserva as tabelas/histórico e todos os brutos.

## Verificação

`node --test test/receita-liquida.test.js test/livro-caixa.test.js test/produtividade.test.js`

Defina `GESTAO_TEST_DATABASE_URL` apenas para PostgreSQL de teste. A suíte cria e apaga seu próprio schema isolado. Cobre precisão, estornos, reconciliação de centavos, grupos incompletos, perfis, versão da IA, configuração legada, bloqueio de desconto duplo, acesso exclusivo, bytes/hash, limite de anexo, estados ausentes/zero, IR sem saldo positivo, concorrência, preservação de originais e histórico.
