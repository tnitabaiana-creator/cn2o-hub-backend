# Receita líquida e Livro-caixa do Tabelião

Regra gerencial solicitada pelo titular em 09/10/2026: receita líquida = bruto × 0,704306. Os 29,5694% são um desconto conjunto de FERD e repasses; não são aplicados novamente no Livro-caixa. Esta configuração não altera a tabela de emolumentos/FERD das calculadoras.

## Fonte e preservação

`produtividade_mes.dados` permanece bruto, com lançamentos da Pesquisa de Produtividade. O CSV de cadastro de escrituras do Extra Digital usado na contagem oficial não tem campos monetários. Não se deduz faturamento de quantidade, tipo de escritura ou usuário criador.

`GET /hub/relatorios/produtividade` mantém `dados` e acrescenta:

- `dados_liquidos`: mesma estrutura, valores monetários líquidos em reais, quantidades intactas; `pessoas[].total_bruto` mantém o critério original de perfil mesa/balcão. Marcadores `base_receita: "liquida_apos_repasses"` e `versao_financeira` impedem reimportar esta projeção como fonte bruta.
- `financeiro`: `bruto`, `repasses`, `receita_liquida` em reais; `centavos` com os mesmos nomes em inteiros; `percentual_repasses: 29.5694`, `criterio`, `versao`, `notas`, `arredondamento`.
- `analise_status`: `atual`, `ausente` ou `anterior_base_obsoleta`. Análises antigas continuam no banco e em `analise_historica`, mas `analise` fica nula até gerar análise com a base atual. A análise nova recebe somente indicadores líquidos e identificação de usuário financeiro, sem presumir autoria da lavratura.

O módulo `receita-liquida.js` é a regra comum. Calcula centavos inteiros com razão exata 704306/1000000, arredondamento para o centavo mais próximo e maiores restos para reconciliar grupos completos. Fonte incompleta não ganha valores inventados: o retorno informa `notas`. Séries completas por pessoa são reconciliadas com seus totais; os dias usam a soma dessas parcelas. Despesas e IR não compõem os indicadores de produtividade.

`GET` reflete sempre 29,5694%, inclusive com configuração legada de 16,67%. `POST /config` aceita só `{corte}`; preserva `ir` legado para compatibilidade e usa o percentual atual. `ferd`/`ir` enviados por clientes antigos são validados com até quatro casas, mas o percentual aplicado continua fixado pela regra atual. Não existe alteração automática do JSON bruto ou dos estados V3.

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
