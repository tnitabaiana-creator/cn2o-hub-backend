# Relatório semanal de prazos operacionais

`GET /hub/relatorios/prazos/semanal` e `GET /hub/relatorios/prazos/semanal.csv`
herdam a sessão `X-Auth-Token` e a autorização administrativa de `relatorios.js`.
Não enviam e-mail, acessam o Trello, alteram tabelas ou inicializam esquemas.
As duas fontes são lidas na mesma transação `REPEATABLE READ READ ONLY`, cujo
instante aparece em `corte_em`.

## Parâmetros

| Parâmetro | Contrato |
|---|---|
| `ref` | Data civil `AAAA-MM-DD` (2000–2099); padrão hoje. A semana **contém** a referência, de segunda a domingo, no fuso local UTC−3. Diferente da prévia legada, não significa a semana anterior. |
| `responsavel` | Login exato, `sem_responsavel`, ou omitido para todos. Sem aproximação ou normalização de caixa. |
| `situacao` | `todos` (padrão), `vencidos`, `a_vencer`, `concluidos`. |
| `tipo` | Código exato do ato, ou omitido para todos. |
| `pagina_fila`, `pagina_conclusoes` | Inteiro positivo, padrão 1, máximo 100000. Paginação independente e ordenação estável por instante e cartão. |
| `limite` | Itens por página, padrão 50, máximo 100. |
| `formato=json` | Somente na rota `.csv`, retorna `{csv,nome_arquivo}` para download pelo cliente autenticado. Sem essa opção, retorna `text/csv`. |

O CSV inclui **todos** os itens que satisfazem os filtros, não somente a página
exibida. Sua primeira parte informa semana, corte e critérios. Células são
escapadas e potenciais fórmulas neutralizadas.

## Fontes e significado

- A fila vem de `prazos_atos`, estados `ativo`, `assinatura` e `inacessivel`.
  O terceiro conserva o último relógio conhecido com uma pendência visível.
  `concluido` e `arquivado` não entram na fila. Nunca usar `due` da agenda como
  vencimento do ato.
- Entram todos os vencidos no instante da consulta, inclusive os acumulados de
  semanas anteriores, mais os ainda a vencer dentro da semana escolhida.
  No instante exato do vencimento o ato ainda está no prazo.
- `inicio`, `vencimento`, regra e responsável são os valores persistidos. Não
  há novo relógio, reinício de contagem ou recálculo de vencimento.
- Conclusões vêm exclusivamente de `prazos_metricas`, `tipo='ato'`, com
  encerramento na semana, não posterior ao corte, e evidência registrada.
  O responsável é o preservado no encerramento. Não somar métricas do setor nem
  transformar um estado arquivado sem métrica em conclusão comprovada.
- Conclusão operacional no Trello é diferente da lavratura registrada no Extra
  Digital. O relatório não acessa os atos do CTN nem aplica o critério Criado Por.
- Ao escolher uma semana passada, apenas as conclusões representam aquela
  semana. A fila continua atual. Não existe reconstrução retroativa da fila.
  Um cartão reaberto pode constar em ambas as partes, sem ser uma duplicata.

## Resposta

Versão `prazos-semanal-v1`, com:

- `corte_em`, `semana:{inicio,fim}`, `filtros`;
- `resumo:{vencidos,a_vencer,concluidos,sem_responsavel,concluidos_no_prazo,concluidos_atrasados}`;
- `por_responsavel:[{login,nome,...resumo}]`, `responsaveis:[{login,nome}]`, `tipos`;
- `fila` e `conclusoes`, cada qual `{itens,total,pagina,paginas,limite}`;
- `criterios:{fila,conclusoes,responsavel}` e `cobertura`.

Os resumos respeitam responsável e tipo, mas **não** o filtro de situação;
os contadores permanecem comparáveis ao alternar as tabelas. Os seletores de
responsável/tipo consideram a fonte completa observada, antes desses filtros.

Cada item identifica cartão, protocolo, tipo, responsável, início, vencimento,
link Trello seguro, situação, última confirmação e pendências. Atraso atual é
exibido em `atraso_horas_uteis` (calendário operacional existente) e
`atraso_horas_corridas`. Para conclusões, o atraso útil é o valor preservado
na métrica; o corrido usa os instantes preservados, não muda a métrica.

Erro de sincronização, ausência de confirmação, cartão inacessível,
confirmação futura e confirmação com mais de 30 minutos são sinalizados.
O total de pendências de sincronização considera a fila da consulta antes dos
filtros por pessoa/tipo. A resposta não devolve o texto privado de erros.

## Falhas e limites

Datas/filtros/páginas inválidos retornam 400. Falta de sessão retorna 401;
usuário não autorizado retorna 403. Tabela ausente ou indisponível retorna 503
(`FONTE_AUSENTE`/`FONTE_INDISPONIVEL`); dados incoerentes/duplicados retornam
`FONTE_INCONSISTENTE`. Nenhum desses casos gera uma resposta artificial de zero.

O limite defensivo é 100000 linhas por fonte na consulta. Se excedido, retorna
503 `LIMITE_DA_FONTE`, sem contadores parciais. Fonte existente sem registros
retorna `cobertura.estado='sem_registros_observados'`; ausência de amostra não
significa inexistência de trabalho nem 100% de cumprimento.

## WIP nos relatórios anteriores

`relatorios.wipAtual` mantém a contagem de cartões nas listas de trabalho, mas
consulta `prazos-wip.js` para atraso canônico. `due`/`dueComplete` não definem
prazo do ato, especialmente na fase de assinatura. Relógios ausentes,
incoerentes ou sem confirmação atual são contados como `sem_prazo_confirmado`,
preservando o total da carteira e explicitando a limitação.
