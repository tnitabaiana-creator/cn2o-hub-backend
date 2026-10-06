# Fonte comum do e-Protocolo — 6 de outubro de 2026

O protocolo passa a ser uma fonte autenticada para os geradores internos e externos. Sem contraposição documental, seus fatos devem ser utilizados. Documento legível e pertinente ao mesmo fato, parcela e negócio prevalece sobre lançamento contrário, preservando os dois valores e a justificativa. Dúvida sobre vínculo, legibilidade ou efetivação de pagamento permanece pendente; não autoriza preenchimento por plausibilidade.

## Contrato e autoria

`protocolo-fonte.js` implementa `cn2o.eprotocolo.v1`. O envelope tem `protocolo`, `revisao`, `dados`, `campos` e `curadoria`. `dados` preserva o payload original, exceto as chaves reservadas `numero` e `curadoria`. `campos` cobre todos os valores, inclusive campos específicos de atos novos, por JSON Pointer. O SHA-256 é calculado sobre JSON canônico de `{schema_version, protocolo:{numero,ato}, dados, curadoria}`; chaves são ordenadas recursivamente. `card_id` é excluído do hash porque nasce depois do protocolo.

Curadoria é declaração humana de conferência, não prova automática de pagamento. `autor` e `data` são carimbados no servidor; cargo vem da sessão. Pagamentos discriminados guardam centavos inteiros, forma, data, realizado/previsto, pagador, beneficiário e referência do comprovante. A triagem original continua preservada. O validador `protocolo-curadoria.js` é compartilhado com o frontend e recusa declaração de compatibilidade quando parcelas e triagem apresentam contradições determinísticas.

## Interfaces

- `GET /hub/protocolos/:numero/fonte`: sessão individual; resposta `{fonte}`; não altera o banco.
- `POST /hub/protocolos/:numero/curadoria`: sessão; corpo `{expected_sha256,curadoria,pagamentos?}`; comparação otimista com bloqueio de linha. Resposta `{fonte,sincronizacao}`. Conflito de versão: HTTP 409, sem sobrescrever a revisão concorrente.
- `POST /hub/protocolos/:numero/sincronizar-fonte`: sessão; `{expected_sha256}`; reaplica a projeção canônica ao Trello. Nenhum conteúdo arbitrário do cliente é publicado.
- `GET /integracoes/eprotocolo/:cardId`: somente leitura para o runtime externo; `Authorization: Bearer <HUB_FONTE_SERVICE_TOKEN>`. Segredo dedicado de 256 bits representado por 64 dígitos hexadecimais. Ausência/configuração inválida falha fechada. A resposta `{fonte}` exige exatamente um protocolo vinculado ao cartão. HTTP 404 com `codigo: PROTOCOLO_NAO_ENCONTRADO` distingue cartão manual sem protocolo de falha de serviço; HTTP 409 indica vínculo duplicado.

Protocolos comuns podem ser curados pelo responsável, Tabelião/Substituta, administradores configurados e cargos autenticados Escrevente/Chefe do Setor de Protocolo. Isso permite conferir o pedido aberto pelo balcão. TEST permanece restrito ao responsável e administradores, além do consumidor interno de integração autenticado. O token de serviço não autentica nenhuma rota de escrita.

## Uso nos geradores

O Hub recebe `protocolo`, `protocolo_revisao` e `ato_minuta`. Ausência precisa ser declarada por `protocolo_ausente:true`. Número inválido/não encontrado, revisão divergente e tipo de ato incompatível não viram uma falsa importação bem-sucedida. A fonte é obtida no banco; envelopes que o cliente ou a IA enviem não são usados como fonte.

`/agentes/:slug/extrair` incorpora a fonte junto dos anexos, armazena o snapshot em coluna própria e exige mapeamento dos campos importados para o JSON extraído. Redação e revisão usam esse snapshot e a matriz anterior, verificando a revisão atual antes de chamar a IA e novamente, dentro da transação, antes de salvar a resposta. Minutas antigas vinculadas apenas por número exigem nova extração; o histórico não é reescrito.

`/hub/ia/minuta` e `minuta_ue` incorporam a mesma fonte. A geração guarda snapshot, matriz, manifesto e hash do texto no servidor e devolve `fonte_geracao_id`. `/hub/minutas` vincula esse identificador ao usuário autenticado; não aceita snapshot informado pelo navegador. Edição manual do texto exige nova conferência. Leituras históricas informam `fonte_desatualizada`, preservando o snapshot original.

O extrator genérico de pessoas `/hub/ia/transpor` continua sendo uma leitura auxiliar dos documentos de qualificação. A aplicação da fonte e da hierarquia ocorre no pedido de minuta; ele não transforma essa extração auxiliar na fonte soberana.

## Conferência documental e limites

O OCR existente agora devolve páginas de texto ligadas ao arquivo real. O manifesto contém SHA-256 dos bytes recebidos. Para validar uma contraposição, o servidor exige arquivo identificado, página real, trecho literal presente no OCR, ausência de palavra incerta atingida pela citação, valor documental representado no trecho, além de vínculo ao mesmo fato e legibilidade declarados pela análise. Arquivo, hash, página ou citação falsos não autorizam sobreposição.

Preço e pagamento preenchidos não podem ser descartados como “não aplicáveis” por mero motivo textual. “Aplicado” exige trecho existente na minuta que represente o valor adotado; na extração exige destino preenchido no JSON. Campos não demonstrados ficam pendentes. Sem OCR independente disponível, a alegação documental permanece para conferência humana, sem ser promovida a sobreposição validada. A pertinência semântica continua dependente da leitura da IA e da revisão humana; estes testes não provam a correção de um caso real.

A matriz e as divergências ficam fora da escritura. O estado externo PRONTA/READY é rebaixado a PRELIMINAR se a fonte exige revisão, sem inserir comentários no corpo. O recorte de exportação do Hub continua limitado aos marcadores da minuta copiável; anotações e o rodapé institucional permanecem fora desse corpo.

## Trello, persistência e implantação

O cartão carrega um único bloco `DADOS` e um bloco pequeno `CN2O_FONTE` com metadados, sem duplicar os fatos. Marcadores em texto informado são escapados. O limite de 16.000 caracteres é verificado sem truncar o JSON. Em TEST, a projeção não inclui dados, vontade, qualificação, curadoria ou observações; a fonte completa fica na API privada. Isso protege novos cartões e cartões reprojetados; não apaga automaticamente conteúdo de cartões antigos.

Revisões usam histórico append-only, snapshots de geração e estado de sincronização. Falha do Trello depois da gravação devolve “curadoria salva / sincronização pendente”, não um pedido de protocolar novamente. A sincronização segura usa bloqueio de linha e confere a revisão para impedir que uma resposta atrasada publique uma versão superada. O runtime externo deve consultar a API privada atual; Trello não garante atualidade quando houver falha de sincronização.

`migrations/20261006-protocolo-fonte.sql` é aditiva e idempotente, executada no boot depois de `db-agentes.init`. As colunas da tabela `hub_minutas` seguem o preparo existente do Hub. A migração não altera dados reais, cartões, filas, retenções do Tabelião ou protocolos antigos. Não executar retroalimentação em massa sem revisão do caso de uso. O token deve ser configurado como segredo no backend e no runtime, sem gravá-lo no repositório ou logs.

`railway.json` substitui o antigo pré-deploy `npm run setup` por validação local do contrato. O setup antigo contém exclusão automática de opções de campos do Trello e não deve executar implicitamente em cada publicação. `setup.js` permanece inalterado e manual; a migração aditiva do banco continua no boot.

Testes locais: `node --test test/protocolo-fonte*.test.js`. Contrato compartilhado: `test/fixtures/protocolo-fonte-v1.json`. Os testes usam dados fictícios, handlers reais com dependências simuladas, e não chamam APIs reais de IA/Trello.
