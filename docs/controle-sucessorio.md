# Controle interno sucessório — 14/10/2026

O e-Protocolo consulta alertas de inventário simples, cumulativo, sobrepartilha e cessão de direitos hereditários pelo nome de cada autor da herança. O cumulativo exige ao menos dois autores. A consulta considera acentos, variantes cadastradas, ordem dos nomes e erros próximos de digitação. Correspondência de nome exige conferência de identidade, inclusive em possível homonímia.

O tabelião cadastra relato, origem/data, fatos constantes dos documentos, pendências, orientação operacional e, facultativamente, solução jurídica previamente definida pela serventia. O mecanismo não produz análise jurídica nem presume fraude. Os PDFs ficam no PostgreSQL autenticado, com SHA-256, sem publicação no site ou anexação automática ao Trello.

Havendo correspondência, o escrevente verifica se a documentação está completa quanto ao alerta e contempla os interessados nele mencionados. Se estiver, confirma expressamente e registra referências documentais; a conferência fica no banco e permite o protocolo. Se houver ausência, dúvida ou inconsistência, preenche o formulário, clica em Protocolizar e salva o pedido para análise do tabelião. Isso registra um pedido interno sem reservar número, criar cartão ou disparar recibo. O painel `controle-sucessorio.html` apresenta os pedidos. Somente o tabelião pode manter pendente, liberar, afastar homonímia documentalmente ou obstar o trâmite, sempre registrando fundamento. A liberação exige o checklist; afastar homonímia exige conferência de identidade.

A autorização vale para o solicitante e os dados exatos do pedido, por sete dias e para um único protocolo. Modificações do formulário ou dos alertas/anexos exigem nova análise. Após uma decisão, o escrevente retorna ao mesmo formulário e clica em Protocolizar; o servidor confere novamente. O registro e a utilização da autorização são atômicos, com bloqueio transacional. Uma falha do banco mantém o pedido retido. Sem correspondência, a conferência regular do ato permanece.

O bloqueio está em `db.registrarProtocolo`, antes da numeração. Assim, chamadas diretas a `/protocolo` também passam pelo controle. A emissão de boletos feita fora do Hub depende do procedimento operacional: o alerta instrui aguardar a liberação, mas o Hub não controla um portal externo de boletos. Nenhum endpoint de emissão de boleto foi identificado nesta base.

## Dados e permissões

Migração aditiva `20261014-alertas-sucessorios.sql`, executada no boot antes de aceitar pedidos: `sucessao_alertas`, `sucessao_documentos`, `sucessao_revisoes`, `sucessao_eventos`. Protocolos existentes são preservados. Consulta e documentação exigem sessão; cadastro, decisões e histórico completo exigem `hub.ehAdmin`. A autorização declarada no cliente é ignorada. Revisão de alerta usa `base_revisao`; decisão usa estado e instante anteriores para detectar alteração concorrente. Anexos são deduplicados por hash dentro do alerta.

A decisão de obstar relacionada ao alerta impede liberação por simples conferência do escrevente, inclusive com dados alterados. Pedidos já encaminhados aguardam o tabelião.

Rotas sob `/hub/controle-sucessorio`: `GET /status`, `POST /consultar`, `GET/POST /alertas`, `GET/POST /alertas/:id/documentos`, `GET /documentos/:id`, `POST /conferir`, `GET/POST /revisoes`, `GET /revisoes/:id`, `POST /revisoes/:id/decidir`, `GET /historico/:id`.

## Verificação e implantação

Executar `node --test test/*.test.js`. A migração e o fluxo transacional também foram testados em PostgreSQL 18.6 isolado, com dados fictícios, incluindo retenção sem consumir número, controle de acesso, alterações posteriores, liberação única, validade e anexos duplicados. A interface deve ser verificada com navegador local e dados fictícios. As provas da operação ficam no diretório de trabalho privado, fora do repositório.

Publicar backend e frontend coordenadamente; páginas antigas devem ser recarregadas, pois autores da herança passaram a ser obrigatórios. Conferir o commit efetivamente ativo na Railway e os arquivos servidos pela Netlify. Cadastrar o primeiro caso por operação privada, verificar leitura posterior e conferir o hash do PDF armazenado.

Para desfazer uma publicação problemática, reverter os commits de interface/servidor ao estado anterior conhecido. Preservar as quatro tabelas, anexos e eventos. Não apagar dados de controle como forma de rollback. Antes de reabrir protocolos sucessórios, garantir que a retenção interna permanece atendida pelo procedimento da serventia.
