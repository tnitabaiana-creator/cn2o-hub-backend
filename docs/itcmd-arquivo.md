# Arquivo da calculadora ITCMD

O módulo guarda trabalhos no PostgreSQL do Hub, com dados editáveis e PDFs vinculados a versões imutáveis. O rascunho antigo, restrito ao navegador, não constitui esse arquivo.

## Comportamento esperado

Na calculadora, dois acessos separam **Inventários salvos** (incluindo cumulativos) e **Doações salvas**. A lista apresenta título, referência, data e modalidade; os dados de pessoas continuam no estado JSON do trabalho.

1. A escrevente identifica o trabalho pelo título e, opcionalmente, pelo protocolo.
2. Salvar mantém os dados necessários para reabrir o cálculo em outro dia ou computador.
3. A geração de orçamento ou declaração arquiva o PDF e o estado usado na geração na mesma transação.
4. Uma edição cria outra versão. O PDF anterior permanece disponível sem recalcular seu conteúdo.
5. Restaurar dados de uma versão anterior abre esses dados para edição; não apaga as versões posteriores.
6. Guias em PDF obtidas fora da ferramenta podem ser anexadas ao trabalho. Arquivar uma guia não emite, protocola ou recolhe tributo.

Os dados podem ser acessados pelo autor e pelos administradores do Hub, segundo `HUB_ADMINS`, como no arquivo de minutas. Todas as rotas exigem sessão, inclusive downloads. Não há compartilhamento público ou expiração automática dos trabalhos.

## Ajustes do orçamento

O estado também preserva a opção reversível de desconsiderar a multa e seu motivo. O ajuste manual zera apenas a multa nos inventários, inclusive nos dois cálculos cumulativos. Não altera o principal e não representa declaração de revogação da lei. O orçamento identifica essa escolha.

Honorários advocatícios deixam de integrar os novos orçamentos. Ao reabrir dados antigos, esse campo é descartado dos novos cálculos; os PDFs já arquivados permanecem exatamente como emitidos. Permanecem ITCMD, emolumentos, certidões/diligências, registro/averbação e outros custos.

## Integridade e concorrência

O cliente envia `versao_base` e `operacao_id`. A versão impede que duas abas sobrescrevam silenciosamente uma edição. Uma repetição com o mesmo identificador de operação e conteúdo recupera a gravação já confirmada. Reutilizar o identificador com conteúdo diferente deve falhar.

Estado, versão e documentos são gravados juntos: um PDF inválido não pode deixar uma versão parcial. Os PDFs são armazenados como bytes e têm SHA-256 para conferir a reimpressão. O servidor não recalcula tributos ao baixar um documento arquivado.

## Armazenamento

- Fonte de trabalho: PostgreSQL existente do Hub.
- Estado por versão: até 1 MiB de JSON.
- Documentos: até quatro PDFs por gravação, 5 MiB por arquivo e 15 MiB no conjunto.
- Backup: as tabelas integram futuros backups completos do banco. Backups anteriores à gravação não contêm os trabalhos novos.
- Drive: não é necessário para esta implementação. Nenhuma credencial do módulo de despesas ou do acervo é reutilizada automaticamente e nenhum documento é enviado ao Drive por esta mudança.

## Publicação e recuperação

Publicar o backend antes da interface. O esquema é aditivo e idempotente. Não executar `npm run setup` para esta alteração e não remover as tabelas ao reverter código.

Base anterior: backend `9990bc4`; frontend `d58ed5e` (inclui a atualização do botão Protocolizar). Em caso de falha, pode-se retirar temporariamente a interface de arquivo preservando o banco e os documentos. A versão anterior da calculadora não reconhece o arquivo, mas não deve apagá-lo.

## Verificação

Validar contratos HTTP com PostgreSQL local, dados fictícios, sessões de dois usuários e administrador. Cobrir reabertura, histórico, SHA-256 dos PDFs, operações repetidas, conflitos simultâneos e falhas que exigem rollback. Conferir PDFs visualmente e manter testes da fórmula de meação sem alteração.

Backend validado: 171 testes gerais aprovados e uma integração legada ignorada por exigir configuração própria. O arquivo ITCMD passou separadamente em 23 testes HTTP/PostgreSQL reais, incluindo limites de tamanho, privacidade, concorrência e rollback após falha no segundo PDF.
