# Produtividade semanal — Protocolo e Cadastro

## Critério autorizado em 13/10/2026

A entrada do cartão em **Em Digitalização**, no quadro Protocolo/Cadastro, registra a entrega da pasta ao setor. A chegada em **Gerar Minuta**, no quadro Tabelião, registra a entrega do setor. A meta é de **8 horas úteis** entre esses marcos.

O titular confirmou que a ausência da etapa Cadastro Extradigital no histórico **não exclui a entrega**: ela é contada com aviso específico. Quando Digitalização e Gerar Minuta estão documentados, a duração permanece válida. Quando o início falta, a entrega comprovada é contada, mas duração, média e situação do prazo ficam sem atribuição; nunca se fabrica duração zero.

Etapas intermediárias, como Em Conferência, e retornos não pausam o relógio nem reiniciam o prazo. O calendário é o já utilizado pelo Hub: por padrão, segunda a sexta, 08:00–12:00 e 13:00–17:00, com os feriados fixos e móveis de `horas-uteis.js` e eventuais `FERIADOS_EXTRA`. O relatório mostra o expediente configurado. Não foi presumida uma escala individual dos três colaboradores.

## Identidade das listas

| Elemento | ID confirmado |
|---|---|
| Protocolo/Cadastro | `692e0379fa55156e778f27ef` |
| Em Digitalização | `692e04c90ddc9150fc7ee25c` |
| Cadastro Extradigital | `693aafe273e4860efe413736` |
| Tabelião | `692e06a94b807c2a1816d992` |
| Gerar Minuta | `6a52b82b6cd2fc065e6762bc` |

Os nomes são apresentados ao usuário; a classificação usa os IDs. As ações `moveCardFromBoard` e `moveCardToBoard` de uma transferência são conciliadas por cartão, origem, destino e proximidade de até dez segundos, em correspondência individual. A chegada deve comprovar o quadro de origem. A carga duplicada da mesma ação não duplica o ciclo.

## API

`GET /hub/relatorios/protocolo-cadastro/semanal?semana=AAAA-MM-DD`

Qualquer data civil da semana é normalizada para segunda a domingo. Sem parâmetro, usa a semana atual. Datas impossíveis ou semanas futuras recebem HTTP 400. O corte é o menor entre o instante real da consulta e a segunda seguinte às 00h em UTC−3. A semana em andamento tem `parcial:true`.

A rota herda a sessão `X-Auth-Token` e a restrição `RELATORIOS_ADMINS`/`HUB_ADMINS` do router de relatórios. Usa `Cache-Control: private, no-store`. Não há envio de e-mail, chamada de IA, mudança em cartões, importação ou escrita no banco durante a consulta.

Campos principais:

- `periodo`: `inicio`, `fim`, `corte`, `parcial`.
- `criterio`: nomes dos marcos, IDs, meta, fuso, expediente, feriados extras e `exigir_cadastro:false`.
- `resumo.entradas`: inícios de ciclos no período; um retorno antes da entrega não cria novo ciclo.
- `resumo.protocolos_entrada_unicos`: cartões distintos entre as entradas acima.
- `resumo.retornos_digitalizacao`: reentradas anteriores à entrega final.
- `resumo.entradas_movimentos_total`: entradas mais retornos.
- `resumo.concluidos`: cartões únicos entregues na semana, pela data da chegada em Gerar Minuta.
- `resumo.ciclos_concluidos`: entregas de ciclos, incluindo retrabalho.
- `resumo.retrabalhos`: ciclos entregues depois de uma entrega anterior daquele cartão.
- `resumo.em_andamento` e `vencidos`: estoque observado no corte, incluindo ciclos iniciados antes da semana.
- `media_horas_uteis`, `mediana_horas_uteis`: apenas ciclos concluídos com início e fim conhecidos.
- `no_prazo`, `fora_prazo`, `sem_tempo`: avaliação por **ciclo concluído**; a soma é `ciclos_concluidos`, não o total de cartões únicos.
- `dias`: sete datas, com entradas, retornos, total de movimentações, cartões concluídos e ciclos concluídos. Um cartão entregue em dois dias conta uma vez em cada dia, mas apenas uma vez no total semanal.
- `ciclos`: ID do cartão, protocolo/título, link, marcos temporais, IDs das ações, duração, estado, retornos, evidência de Cadastro e motivo/ressalva.
- `cobertura`: limites observados, último recebimento, quantidade de eventos e `confirmada:false`.
- `avisos`: limites metodológicos e pendências encontradas.

## Cobertura e preservação

O banco guarda eventos recebidos por webhook ou carga. Esses dados não contêm um recibo de completude de toda a história do cartão. Portanto, a API não declara cobertura completa só por existir um evento recente, e ausência de eventos não é tratada como produtividade zero confirmada.

A consulta recupera **todo o histórico disponível dos cartões candidatos anterior ao corte**, para incluir entradas anteriores à semana e conhecer reaberturas. Um limite operacional de 150 mil eventos rejeita o relatório com HTTP 503, em vez de truncá-lo silenciosamente. A leitura ocorre em uma única instrução SQL, com fotografia consistente dessa consulta.

Os registros de autoria das escrituras, receitas, conclusões das escreventes, NextQS e pesos dos atos permanecem independentes. As regras da reconstrução legada de `rastreio.js` foram preservadas; acrescentou-se um filtro de origem para que a fotografia histórica `carga_setorial` não altere incidentalmente suas projeções.

O backfill histórico grava somente eventos novos, com `origem='carga_setorial'` e `processado_em=NULL`. Esses eventos ficam fora da fila de reprocessamento legado, da leitura de eventos para essa reconstrução e da contagem de pendências legadas. Cartões sem eventos legados não têm projeções apagadas. O relatório setorial lê todas as origens. O timestamp de processamento não é preenchido para fingir uma reconstrução.

A conciliação periódica com `origem='carga'` não promove eventos setoriais já existentes. Novas ações continuam entrando normalmente. Se o próprio webhook autenticado entregar uma ação antes conhecida apenas pela fotografia setorial, com ID, tipo, cartão, quadro e data coincidentes, ela é promovida à origem `webhook` e fica pendente para o processamento normal. Assim, a fotografia não bloqueia eventos legítimos posteriores; uma identidade divergente não sobrescreve o registro existente.

A ferramenta privada de backfill exige proteção publicada conferida por SHA-256, originais e paginação validados, backup completo de eventos baixado e verificado localmente antes da aplicação, transação idempotente, fingerprints das tabelas protegidas e leitura posterior. Fontes privadas e scripts operacionais não integram Git/assets. A rotina de webhook/reconciliação existente alimenta as novas ações; não foi criada uma nova automação.

## Verificação local

`node --test test/protocolo-cadastro.test.js test/horas-uteis.test.js test/reports.test.js test/rastreio.test.js`

Cobre ciclo normal, conferência intermediária, Cadastro ausente, início desconhecido, pares de transferência invertidos, duplicações, almoço, fim de semana, feriado, prazo de oito horas sem arredondamento prévio, retornos, retrabalho, estoque anterior, corte parcial, arquivamento, dados vazios, calendário configurado, consulta somente leitura e bloqueio de acesso.

Implementação e testes locais não equivalem à publicação. Validar endpoint autenticado, período, cobertura da carga e totais de volta do servidor após eventual implantação.
