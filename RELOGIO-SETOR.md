# Relógio de Protocolo e Cadastro

O Hub projeta o prazo setorial em dois campos do Trello: `Prazo do setor` (data) e `Relógio do setor` (texto). Ambos ficam visíveis na frente e no interior dos cartões. O prazo geral do ato (`due`/`dueComplete`) permanece independente.

## Regra

- Início comprovado: primeira entrada em Cadastro Extradigital, quadro 00. Digitalização não inicia este relógio.
- Término comprovado: chegada a Gerar Minuta, quadro 01. A conclusão congela a duração.
- Meta: 8 horas úteis. Reutiliza `horas-uteis.js`, `EXPEDIENTE` e `FERIADOS_EXTRA`; padrão 08–12/13–17, fuso UTC−3, finais de semana e feriados do calendário do Hub excluídos.
- Conferência e retornos internos não zeram o início. Retrabalho após entrega usa novo ciclo.
- Sem início conhecido, mostra pendência, sem fabricar duração. Entrega sem etapa Cadastro traz `s/ Cadastro`.
- Cartões arquivados, nas listas de arquivo e fora dos dois quadros não recebem novas alterações.

## Execução e visibilidade

Ativo por padrão na inicialização do servidor. `RELOGIO_SETOR_ATIVO=false` interrompe novas escritas no Trello. `relogio-setor-integracao.js` fornece a instância usada pelo servidor e pelo endpoint administrativo `GET /hub/relatorios/relogio-setor/status`.

Eventos autenticados entram em fila com breve agrupamento. A cada cinco minutos há reconciliação geral; não se trata de animação segundo a segundo. O texto ativo informa o instante da projeção em Brasília. Concluídos mostram o instante da entrega.

A API recupera movimentos perdidos: consulta os dois quadros nas últimas 24h ou desde o último checkpoint, com uma hora de sobreposição, se mais antigo; para candidatos, lê todo o histórico disponível do cartão. Paginação incompleta, IDs divergentes e conflitos operacionais interrompem antes de gravar o lote. A origem `carga_setorial` conserva o isolamento das projeções legadas; não chamar seu reprocessamento para alimentar este relógio.

O provisionamento cria somente os dois campos conhecidos, rejeitando duplicidade, tipo incompatível e limite de 50 campos. Não executa `setup.js`. Capa integral dos cartões elegíveis passa apenas ao tamanho normal, preservando cor e anexo; o original fica salvo antes da mudança.

## Estado e recuperação

As tabelas aditivas `relogio_setor` e `relogio_setor_coletas` guardam confirmações, posição/ciclo, erros, evidência e checkpoint. Trava consultiva PostgreSQL evita duas instâncias escrevendo ao mesmo tempo. Gravações incertas são verificadas com GET antes de nova tentativa. API tem timeout e erros sanitizados. 429/401/403 interrompem a rodada; 404 preserva a pendência sem insistência ilimitada.

Desativar a variável e reiniciar o serviço interrompe novas escritas; os campos existentes ficam como última fotografia. Não excluir campos/valores em massa como rollback. Se necessário restaurar uma capa, comparar posição e estado humano atuais ao `cover_original` antes de escrever. Não reverter as proteções `carga_setorial` do backend.

Sem nova assinatura de extensão ou chamadas de IA. Consome apenas API Trello e recursos do backend já contratado; não representa garantia de custo marginal zero de infraestrutura.

## Verificação

Testes cobrem calendário, retornos, conclusão sem Cadastro, início ausente, mudança concorrente, lock, POST/PUT incertos, arquivamento, 404, escopo/paginação do histórico, checkpoint e autenticação. Conferir publicação e valores devolvidos pelo Trello após ativação; commit/push sozinho não confirma a implantação.


## Atualização 2026-10-14.3

O sinal é verde antes de 6h úteis, amarelo de 6h até o limite e vermelho ao atingir
8h úteis. São gerados avisos distintos nas faixas de 2h restantes, 1h restante e
limite atingido; o calendário pula almoço, noite, fins de semana e feriados.
O painel do Hub e a agenda usam os mesmos marcos, com horários exatos.
O chefe do setor (`milvo.neto`, configurável em `PRAZOS_SETOR_LOGINS`) e o tabelião
veem o estoque setorial; a escrevente vê os cartões que lhe forem atribuídos.

A nova estatística em `prazos_metricas` guarda a conclusão comprovada de cada
ciclo a partir de Cadastro Extradigital, com atraso em horas úteis, sem sobrescrever
os eventos e relatórios históricos de volume do fluxo desde Digitalização.
A estatística canônica do novo prazo fica na seção Relógios e cumprimento de prazos.
