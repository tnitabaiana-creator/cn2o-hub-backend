# Controles de despesas CN2O e Bravo

Os mesmos fluxos documentais atendem dois acervos fisicamente separados:

| Controle | API | Tabelas |
| --- | --- | --- |
| Cartório | `/hub/despesas` | `despesas_*` |
| Bravo Patrimonial | `/hub/despesas-bravo` | `bravo_despesas_*` |

O namespace é fixado pela rota do servidor. Não há seleção de tabelas por
conteúdo de arquivos, cabeçalhos ou campos de formulários. Respostas identificam
o controle, e o cliente Bravo recusa uma resposta do cartório. Sessões e usuários
autorizados continuam os mesmos; transferências exigem César Bravo.

O banco da Bravo é inicializado de modo aditivo sob o bloqueio existente.
As tabelas CN2O não são renomeadas nem esvaziadas. Documentos, partes originais,
vínculos, deduplicação, histórico e filas Google têm namespace próprio. O teto
mensal do OCR é compartilhado para não duplicar o limite de custo autorizado.
Credenciais Google não são copiadas. Quando configurada, a conexão da Bravo usa
callback, pasta e planilha próprios. Cópias Google antigas são preservadas como
histórico; a sincronização exclui documentos transferidos da planilha de origem.

`GET /routing` confere todos os períodos e informa documentos, hashes,
lançamentos, vínculos, transferências e indícios do nome empresarial/CNPJ Bravo.
Indícios não são decisão automática: nome do titular, remetente, pagador ou
menção incidental não comprovam que a Bravo é tomadora.

`POST /routing` exige destino, tipo, ID, versão corrente e motivo. A transação
confere cada parte e SHA-256, reutiliza hash existente, preserva os originais e
registra auditoria. Documento ligado a lançamento ativo só pode ir junto com o
lançamento. Comprovante compartilhado com outro lançamento bloqueia a mudança.
O registro de origem transferido fica fora dos totais; o de destino preserva
pagamento confirmado, mas exige nova revisão documental/contábil. Repetição
confirmada é idempotente; transferência inversa restaura o registro auditado.

Validação: `node --test test/despesas-workspaces.test.js` executa schemas e
transações em PostgreSQL isolado via PGlite. Os casos cobrem acesso, isolamento,
vínculo cruzado, integridade, conflito, retomada, reversão e auditoria.

Publicação: backend antes do frontend; conferir 401 nas rotas sem sessão e
identidade `workspace=bravo` na sessão autorizada antes de mover registros reais.
Retorno de código: reverter commits sem remover tabelas ou dados. Depois de uma
transferência real, não voltar ao código antigo que desconhece a marca de
destinação: inverter as transferências pela API ou manter a filtragem de origem.
Nunca apagar originais para desfazer uma publicação.
