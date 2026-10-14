# Controle contínuo de prazos — versão 2026-10-14.5

O prazo geral começa na **primeira entrada comprovada em Cadastro Extradigital**
(`693aafe273e4860efe413736`, quadro 00). Protocolo/Entrada e Em Digitalização não
iniciam essa contagem. O relógio setorial de 8 horas permanece independente.

## Política consolidada

| Ato | Condição | Dias |
| --- | --- | --- |
| CV urbana e rural | Santa Mônica (etiqueta específica ou bandeira rosa) | 3 corridos |
| CV urbana e rural | demais construtoras/loteadoras / sem bandeira | 5 / 10 úteis |
| Doação e permuta | vendedor corporativo / demais | 5 / 8 úteis |
| Inventário simples | uma sucessão, sem marcação especial | 4 úteis |
| Inventário cumulativo ou complexo | caixa própria marcada no protocolo | 10 úteis |
| Cessão de direitos hereditários | advogado / demais | 4 / 7 úteis |
| Testamento | todos | 5 úteis |
| Cessão de direitos possessórios | todos | 3 corridos |
| Certidão | fluxo próprio, desde o protocolo | 5 úteis |
| Qualquer cartão com etiqueta Urgente | prevalece se encurtar | até 2 úteis |

Doação, permuta e o fallback legado de 8 dias para tipos não mapeados foram
preservados. O fallback é identificado em `regra.regra_legada`, não representa nova
definição do tabelião para esses atos.

Exclui-se o dia inicial. O vencimento ocorre às 23:59:59 de America/Maceio.
Reutiliza o calendário operacional `horas-uteis.js`, inclusive os feriados já
existentes e `FERIADOS_EXTRA`. Datas municipais adicionais precisam constar nessa
configuração; a implantação não presume ter validado o calendário municipal.

Urgência presente desde o protocolo conta da entrada no Cadastro; urgência
posterior usa o evento de inclusão da etiqueta, nunca alonga o prazo existente.
Na ausência desse evento, registra o instante de observação. Retirar a etiqueta
não estende o vencimento. A regra inicial e a versão ficam registradas no banco. A retificação Santa Mônica
é aplicada aos relógios ativos desde a entrada original em Cadastro Extradigital,
sem reinício ou extensão de prazo menor já vigente. Atos concluídos não são recalculados.
A identificação Santa Mônica é apenas uma regra de prazo.
Pendências não suspendem automaticamente o prazo.

## Arquitetura e funcionamento

1. `server.js`: cria o cartão de escritura sem vencimento geral; encaminha eventos
   Trello autenticados ao serviço. Certidão conserva o seu fluxo próprio.
2. `prazos-atos-modelo.js`: matriz, calendário, marco inicial, urgência e cores.
3. `prazos-atos.js`: estado canônico em Postgres por `card_id`, evidência do início,
   projeção no Trello e fila persistente de avisos. Usa a infraestrutura contratada.
4. Webhook agrupa eventos por 1,5 segundo; varredura a cada 5 minutos recupera
   movimentos perdidos. Reconcilia os quadros 00, 01, escreventes, 03 e 04; quadros
   adicionais podem ser informados em `BOARDS_PRAZOS`.
5. Em cada quadro, provisiona por nome os campos visíveis **Início do ato**,
   **Prazo do ato** e **Relógio do Ato**. Trocar de quadro reaplica os campos a partir
   do mesmo registro canônico; jamais usa a data do movimento como novo início.
   Capas integrais passam a tamanho normal, preservando cor/anexo e salvando o original.
6. Até a assinatura, `due` espelha o vencimento geral, com lembrete de 24 horas.
   Nas listas de assinatura, `due` fica disponível para a agenda já existente.
   **Prazo do ato** e **Relógio do Ato** continuam contando e notificando nessa fase.
7. Verde: prazo confortável. Amarelo: faltam até 2 dias; também no dia do vencimento. Vermelho: venceu.
   Texto e ícones distinguem situações sem depender só da cor.
8. Uma menção no cartão por vencimento e marco: dois dias úteis antes, no dia útil
   anterior, no dia do vencimento e quando vencido. Destinatários: usuário Trello do tabelião (`tnitabaiana`, configurável)
   e membros efetivamente atribuídos ao cartão. Cartão sem membros avisa o tabelião.
   Push no celular depende das permissões/configurações do Trello no dispositivo.
9. Finalizado/Concluído encerra avisos e mostra conclusão. Arquivamento interrompe
   projeções. Reabrir o cartão retoma o mesmo início e vencimento.

O sistema recupera cartões já em andamento com protocolo canônico e histórico
comprovado. Sem evidência da entrada, não fabrica início. Cartões concluídos ou
arquivados sem registro do relógio não recebem carga de avisos retroativos.

## Confiabilidade

Trava consultiva Postgres evita duas instâncias simultâneas; chaves únicas evitam
duplicação de estado e avisos. Histórico paginado deve estar completo e corresponder
ao cartão. Respostas incertas são reconciliadas por leitura; comentários incluem
marcador para recuperação após perda do ACK. 401/403/429 e timeout interrompem o
lote, retomado na próxima rodada. Falhas ficam no diagnóstico e não derrubam o Hub.

`GET /hub/admin/prazos/status` exige sessão de administrador e informa versão,
rodada, estados e falhas. `/saude` mostra apenas o estado técnico resumido.
Webhook inválido não aciona escritas; a varredura autenticada continua disponível.

## Implantação, validação e reversão

Publicar este commit no backend Railway. As tabelas são aditivas e criadas no boot.
O serviço é ativo por padrão; `PRAZOS_ATOS_ATIVO=false` interrompe novas escritas,
mantendo os registros. Reativar e reiniciar retoma o estado existente.

Verificar a versão em `/saude`, a rodada no diagnóstico administrativo e os campos
reais no Trello. Confirmar um cartão de teste atravessando Cadastro → Gerar Minuta →
quadro de escrevente sem mudança de início/vencimento. Não mover atos reais para testar.
Os testes automatizados cobrem política, calendário, urgência, início comprovado,
continuidade, assinatura, conclusão e recuperação de comentário sem duplicidade.

Não apagar tabelas, campos, comentários nem valores em massa para reverter.
Desativar o serviço não restaura automaticamente a política anterior de criar o
vencimento no protocolo. Reverter o código é uma ação separada.


## Integração com a home e Minha Agenda — 2026-10-14.3

O painel **Relógio do Ato** aparece no alto da página inicial. Mostra os atos da
escrevente, com atrasados e vencimentos próximos primeiro, e ações para abrir o
cartão original ou a agenda no dia do vencimento. O tabelião tem visão de equipe.

`GET /hub/prazos` exige sessão e filtra pelo responsável registrado no servidor.
O login não vem de parâmetro do navegador. Ao entrar no quadro de uma escrevente,
o responsável é resolvido pelo cadastro de quadros e usuários; ao retornar ao
quadro compartilhado, conserva a atribuição anterior. Uma nova escrevente assume
ao receber o cartão. Nomes ambíguos ficam sem atribuição e são visíveis ao tabelião.
O nome gravado no protocolo pelo atendente não é usado para presumir autoria.

A mesma data canônica gera três eventos de dia inteiro na agenda pessoal: D−2
úteis, D−1 útil e D0. Feriados e fins de semana são excluídos dos pré-avisos;
o próprio vencimento pode cair num domingo nos atos em dias corridos. Os eventos
ficam em uma camada automática de leitura; não gravam nem alteram as anotações
ou imagens de `hub_agenda`. Concluir, arquivar ou transferir o ato atualiza os eventos
na próxima consulta. Urgência recalcula as datas na mesma fonte.

O frontend consulta a cada minuto e o backend reconcilia o Trello a cada cinco.
Mensagens visuais do Hub são exibidas quando ele está aberto; avisos no Trello
continuam sendo gerados pelo backend mesmo com o Hub fechado. A sessão do
navegador impede que respostas atrasadas de outro login apareçam na tela.
Falhas mostram pendência de atualização, nunca uma falsa confirmação de ausência
de prazos. Não há criação de cartões duplicados nem integração com Google Agenda.

Frontend associado: `cn2o-hub`, arquivos `relogio-ato.js`, `relogio-ato.css` e
pontos de integração em `index.html`. Publicar backend antes do frontend.


## Estatística específica e relógio setorial — 2026-10-14.3

Ambos os relógios começam em Cadastro Extradigital. O setorial encerra na entrega
em Gerar Minuta; o geral continua até Finalizado. São mostrados separadamente
na home e agenda. No setor, o amarelo inicia em 6h úteis, com aviso adicional em
7h e limite em 8h. A agenda mostra os horários calculados no expediente.

A tabela aditiva `prazos_metricas` guarda início, vencimento, conclusão comprovada,
responsável, tipo do ato, resultado no prazo, duração e atraso em horas úteis.
A chave evita contar retentativas como novas conclusões. O ato conta a primeira
conclusão por cartão; o setor conta por ciclo. A autoria é a responsabilidade
operacional conferida, não a identidade do atendente que abriu o protocolo.

`GET /hub/relatorios/prazos?de=AAAA-MM-DD&ate=AAAA-MM-DD` herda a autenticação
administrativa dos relatórios. Retorna concluídos, no prazo, atrasados, percentual
de cumprimento e atraso médio por responsável e tipo. Sem amostra, percentual nulo.
A data de conclusão vem do evento do Trello, nunca do horário de uma varredura.

A seção adicional acompanha o mês do relatório de produtividade de escrituras e
a semana do relatório de Protocolo/Cadastro. Tem exportação CSV; o relatório
semanal/mensal histórico recebe o bloco também em HTML, texto e CSV. Não altera
os valores financeiros nem a contagem oficial de atos lavrados.

Inventário: as caixas `inventario.cumulativo` e `inventario.complexo` são booleanas no protocolo.
Para reclassificar um cartão existente, marque o item exato “Inventário complexo”
ou “Inventário cumulativo” em uma checklist do próprio cartão. A reclassificação
aplica 10 dias úteis desde a entrada original; não reinicia o relógio, não altera
atos concluídos e conserva eventual limite urgente. Desmarcar não reduz automaticamente
um prazo já reclassificado; mudança posterior exige revisão explícita.
