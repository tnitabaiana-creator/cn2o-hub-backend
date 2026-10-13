# Atribuição gerencial por movimentações do arquivo — 13/10/2026

Aplica o critério aprovado pelo titular sem reimportar os atos do Extra Digital, modificar sua data/tipo ou alterar a receita. A fonte oficial continua sendo a escritura Registrada(a), na competência da lavratura. A movimentação Trello é uma **convenção de atribuição gerencial**, não prova de elaboração, lavratura física ou clique manual.

## Decisão

- Última entrada comprovada de uma lista não-arquivo para arquivo: usa a conta movimentadora identificada como escrevente. Método `movimentacao_arquivo_trello`.
- Se essa conta for genérica, não escrevente ou apresentar sinal positivo de automação: usa o último escrevente individual que realizou uma **movimentação** anterior ao marco de arquivo, mesmo em outra etapa. Método `ultimo_escrevente_antes_arquivo_trello`. Não usa comentário, campo responsável, usuário financeiro ou auditoria CTN.
- Movimentos entre arquivos não redistribuem o crédito. Uma volta ao trabalho seguida de nova entrada no arquivo permite novo marco, com histórico e revisão.
- Quando `moveCardToBoard` não informa destino, não o preenche com a lista atual. Pode usar a primeira ação posterior que comprova origem e destino em arquivo como `primeira_constatacao_arquivo`, com janela de entrada indeterminada. Exige transferência anterior real, histórico completo e nenhum movimento individual/desconhecido entre essa transferência e a constatação; guarda ambos os eventos. Sempre usa o método do escrevente anterior e nunca credita a reorganização posterior. Sem esses elementos, mantém pendência.
- Identidade desconhecida posterior ao último escrevente conhecido, empate entre atores diferentes, corte antigo ou fonte incompleta impede substituir atribuição válida. Ator não escrevente comprovado pode ser ignorado na busca do último escrevente. Um bot nunca recebe crédito individual.
- Ausência de `automacao`/`appCreator` permanece `null`, com `origem_execucao: fonte_nao_informa`. Não equivale a prova de execução manual. Sinal positivo de automação não identifica operador humano.

Configuração versionada: quadro `692e0379fa55156e778f27ef`; arquivos `69344a6fc5e00099568028f9`, `6a94ce7feba0f0d9ab600e9b`, `6a143e210fea5dbc7500a27b`. Não inclui revisar/refazer, certidões ou sem efeito. Nomes de lista são preservados para auditoria; a classificação usa IDs, não aproximações textuais.

## Entrada administrativa

`POST /hub/atos-lavrados/autorias`, sessão administrativa e `Cache-Control: private, no-store`. Exemplo **sintético**, sem clientes nem fontes reais:

```json
{
  "chave": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "revisao_base": 0,
  "evidencia": {
    "tipo": "trello_movimentacao_arquivo_criterio_titular",
    "marco": "atribuicao_gerencial",
    "corte_em": "2026-10-12T17:00:00-03:00",
    "ato": {"documento":"Notas","minuta":"1","protocolo":"10","livro":"1","folha":"1"},
    "vinculo": {
      "referencia": "Fonte privada da conferência única ato/cartão",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "coletado_em": "2026-10-12T17:05:00-03:00",
      "ato": {"documento":"Notas","minuta":"1","protocolo":"10","livro":"1","folha":"1"},
      "cartao_id": "cccccccccccccccccccccccc",
      "confirmado_unico": true
    },
    "trello": {
      "referencia": "Histórico completo privado do cartão, com todas as páginas",
      "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "coletado_em": "2026-10-12T17:05:00-03:00",
      "ato": {"documento":"Notas","minuta":"1","protocolo":"10","livro":"1","folha":"1"},
      "cartao_id": "cccccccccccccccccccccccc",
      "quadro": {"id":"692e0379fa55156e778f27ef","nome":"00. Protocolo/Cadastro"},
      "listas_arquivo": [{"id":"69344a6fc5e00099568028f9","nome":"Arquivo Geral"}],
      "historico_completo_ate_corte": true,
      "movimentacoes": [{
        "id": "eeeeeeeeeeeeeeeeeeeeeeee",
        "type": "updateCard",
        "date": "2026-09-05T10:00:00-03:00",
        "cartao_id": "cccccccccccccccccccccccc",
        "quadro_id": "692e0379fa55156e778f27ef",
        "quadro_antes": null,
        "listBefore": {"id":"ffffffffffffffffffffffff","name":"Etapa anterior"},
        "listAfter": {"id":"69344a6fc5e00099568028f9","name":"Arquivo Geral"},
        "automacao": null,
        "appCreator": null,
        "criador": {
          "id": "111111111111111111111111",
          "nome": "Nome completo sintético na fonte",
          "username": "perfil_sintetico",
          "tipo": "humano",
          "identidade_conferida": {
            "trello_id": "111111111111111111111111",
            "login_hub": "pessoa.ficticia",
            "referencia": "Perfil oficial e configuração que comprovam a identidade",
            "sha256": "2222222222222222222222222222222222222222222222222222222222222222",
            "coletado_em": "2026-10-12T17:00:00-03:00"
          }
        }
      }]
    }
  }
}
```

Enviar todos os movimentos reais até o corte, não só o candidato escolhido. Aceita `updateCard` (listas anterior/posterior obrigatórias) e `moveCardToBoard`; neste último, `quadro_id`, `quadro_antes`, `listBefore` e `listAfter` podem permanecer `null` quando ausentes na fonte. Movimento com destino desconhecido não prova entrada no arquivo. `display_key` é texto opcional preservado, sem traduzir ausência em evento inventado. Cada ação exige ID único, data com fuso, mesmo cartão e criador literal. `appCreator`, quando presente, é objeto com `id`; `automacao` é booleano ou null.

`quadro_id` também pode ser null em `updateCard` quando a fonte não o informa. Nesse caso a ação não comprova entrada no quadro de arquivo, mas continua sendo movimento real utilizável na procura do escrevente anterior. Não deduzir quadro atual como se fosse o quadro histórico do evento.

Se um movimento posterior ou empatado sair de lista não-arquivo para ID de arquivo sem quadro comprovado, a atribuição antiga fica pendente (`ENTRADA_POSTERIOR_NAO_DETERMINADA`). Transferência de quadro indeterminada empatada com o ingresso conhecido também fica pendente (`ORDEM_MOVIMENTACOES_AMBIGUA`); não se inventa ordem entre ações.

O vínculo repete as cinco posições da identidade oficial e o ID do cartão. Protocolo oficialmente vazio continua permitido; nunca preencher por inferência. O vínculo é documental e curado: não exige protocolo Hub preexistente, nem transforma igualdade de nomes/clientes em prova. Um cartão pode respaldar várias escrituras, cada uma preservando sua identidade; isso não duplica pesos Trello.

`criador.tipo`: `humano`, `bot` ou `desconhecido`. Humano descreve identidade conhecida, não execução manual. `username` pode ser null. `colaborador_hub:{id,nome}` é opcional e, quando fornecido, precisa concordar com o cadastro canônico. Sem `identidade_conferida`, somente nome/login/alias exatos e únicos resolvem o ator. Com ela, o ID Trello precisa repetir exatamente o criador e o login Hub deve existir de forma única; guarda referência, hash e coleta da prova. Permite nome completo no Trello e nome curto no Hub sem aproximação, criação de pessoa ou escolha arbitrária entre homônimos. A mesma prova identifica operadores não escreventes, que podem ser ignorados na busca do escrevente anterior. Status ativo atual não apaga papel histórico.

Não enviar `colaborador` no topo nem `metodo`, `decisao` ou `sha256_calculado`: são derivados pelo servidor. A sessão administrativa fornece quem confirmou. Hash de arquivo é referência auditável, não autenticação de conteúdo que a API não recebe; preservar as fontes privadas e conferir vínculo/identidade antes do POST.

## Prévia local e persistência

`require('./atos-lavrados-db').preverAutoriaArquivo(payload, registroCTN, cadastroHub)` é pura e não abre conexão, não inicializa esquema e não salva. `cadastroHub` usa `{login,nome,escrevente,aliases:[]}` do cadastro comprovado; `registroCTN` é o registro oficial ativo. A prévia devolve a decisão e hash calculados, mas **não deve substituir a entrada original do POST**. Prioridade/revisão vigentes são verificadas somente ao confirmar no banco.

Idempotência por evidência canônica: repetição exata da evidência vigente retorna revisão existente e `repetida:true`, sem novo histórico. Conteúdo diferente exige revisão atual. Confirmações concorrentes são serializadas. Revogação continua explícita; evidência insuficiente retorna `422 PENDENTE_SEM_ATRIBUICAO` sem apagar a anterior. Corte que retrocede retorna 409. Evidência direta permanece prioritária; novo complemento não a sobrescreve.

Uma rotina antiga de auditoria CTN/Trello não pode substituir o novo critério de arquivo já vigente, mesmo com corte posterior e revisão atual: retorna `409 CRITERIO_GERENCIAL_SUPERADO`. Eventual correção para critério anterior exige revogação explícita e nova conferência; não é executada automaticamente pela rotina semanal.

A migração cumulativa de 13/10 substitui o CHECK de 10/10, admitindo métodos anteriores e os dois novos. O init não reinstala a restrição antiga em reinicializações. Não insere autores, atos, valores ou despesas.

## Resumo e exibição

`autoria.metodos` e `colaboradores[].metodos` possuem: `direta`, `auditoria_concordante`, `trello_divergencia`, `movimentacao_arquivo_trello`, `ultimo_escrevente_antes_arquivo_trello`. As somas continuam iguais ao total confirmado, global e por pessoa. Fonte do complemento: `Extra Digital + Trello`; marco: `atribuicao_gerencial`. Sem evidência permanece pendente, não produtividade zero.

`autoria.com_cartao_trello` conta apenas atos atribuídos confirmados com cartão na evidência e equivale à soma de `colaboradores[].com_cartao_trello`. Não inclui candidatos pendentes. `com_vinculo` mantém o significado anterior de vínculo com protocolo Hub. `GET /atos` acrescenta `vinculo_trello:{cartao_id,metodo,revisao}|null`; resumos não expõem clientes, hashes de fontes ou ações privadas.

Nenhuma receita individual é inferida pelo novo crédito gerencial. Valores e autoria financeira continuam separados. Este contrato não altera totais oficiais, data, tipos, módulos financeiros ou envios de e-mail.
