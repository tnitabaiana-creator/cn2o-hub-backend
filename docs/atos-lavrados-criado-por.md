# Autoria gerencial pelo Criado Por do Extra Digital

Decisão expressa do titular em 13/10/2026: considerar autor da escritura a pessoa identificada no campo **Criado Por / U. criador** do Extra Digital. Trata-se de critério gerencial; não é prova de execução física da lavratura nem evento de registro. A data de lavratura e a contagem de atos continuam vindo da fonte oficial já importada. Nenhuma receita individual é inferida.

## Contrato de confirmação

`POST /hub/atos-lavrados/autorias` mantém sessão autenticada administrativa e JSON privado `no-store`. A operação interna equivalente é `atribuirAutoria(pool, pedido, autor, expectativaOpcional)` em `atos-lavrados-db.js`. O autor da confirmação é o administrador autenticado; não se confunde com o criador da escritura.

```json
{
  "chave": "SHA256 da chave já importada",
  "revisao_base": 1,
  "evidencia": {
    "tipo": "criado_por_extra_criterio_titular",
    "marco": "atribuicao_gerencial",
    "ato": {"documento":"Notas","minuta":"123","protocolo":"456","livro":"1","folha":"2"},
    "campo_ou_evento": "U. criador",
    "valor_original": "login.literal.da.fonte",
    "fonte": {
      "sistema": "Extra Digital",
      "lote_id": "UUID do lote já importado",
      "sha256": "SHA256 do CSV original (lote.fonte.sha256)",
      "referencia": "arquivo.csv / localizador da linha",
      "coletado_em": "2026-10-09T20:23:25.387Z"
    }
  }
}
```

Os cinco componentes da identidade devem coincidir com o registro ativo. Protocolo vazio só é aceito quando já está vazio no ato importado. O rótulo deve ser literalmente uma das chaves `U. criador`, `U.criador` ou `Criado Por` existente em `originais`; o valor original deve coincidir inclusive em caixa e espaços. Rótulos contraditórios deixam pendência. O servidor verifica o lote ativo e seu SHA do arquivo; não confundir com o hash canônico do conteúdo do lote.

O login normalizado do campo deve corresponder a exatamente uma identidade existente no cadastro. Aceita escrevente, inclusive inativo hoje, ou pessoa cadastrada como Tabelião, preservando o papel na evidência. Não cria usuários, não casa nomes aproximados, não usa U. Alterou e não atribui a conta sem papel individual conferido. Identidade insuficiente retorna `422 PENDENTE_SEM_ATRIBUICAO`, sem alterar a atribuição anterior.

A coleta registra o momento original da fonte (09/10 no lote de setembro); `confirmado_em` registra a confirmação posterior. Não se inventa nova coleta. O instante da coleta não pode ser futuro nem anteceder o dia da lavratura em America/Sao_Paulo.

## Prévia e expectativa atômica

`preverAutoriaCriadoPor(pedido, registro, cadastro, fonteImportada)` é pura, sem conexão ou inicialização. `cadastro` usa `{login,nome,cargo,escrevente}`; `fonteImportada` usa `{lote_id,fonte:{sistema,arquivo,sha256}}`. A função retorna a decisão normalizada com colaborador e `evidencia.sha256_calculado`.

Para lotes previamente revisados, a expectativa é obrigatória no aplicador:

```js
const expectativa = {
  sha256_calculado: previa.evidencia.sha256_calculado,
  colaborador_id: previa.colaborador.id,
  metodo: 'criado_por_extra'
};
await atribuirAutoria(pool, pedido, loginAdministrador, expectativa);
```

Essa expectativa é confrontada dentro da transação, após ler fonte/cadastro atuais e antes de qualquer INSERT ou resposta idempotente. Divergência retorna `409 DECISAO_DIVERGENTE_DA_PREVIA`. Não enviar colaborador, método, decisão ou hash calculado dentro do pedido: são derivados pelo servidor.

## Revisões, substituição e histórico

O critério vigente pode substituir qualquer método anterior, inclusive direto, com revisão-base exata. A fotografia original anterior ao corte do Trello é válida para essa troca expressa de convenção. Métodos antigos não podem sobrescrever Criado Por: retornam `409 CRITERIO_GERENCIAL_SUPERADO`. Revogação continua explícita, fundamentada e versionada.

O replay do mesmo hash de evidência já confirmado não cria nova revisão; pedido diferente exige revisão atual. A confirmação guarda linha atual e histórico na mesma transação. A migração cumulativa `migrations/20261013-atos-lavrados-criado-por.sql` amplia o CHECK preservando os métodos e as linhas anteriores. Reinicialização usa apenas o CHECK cumulativo mais recente. A migração não importa, atualiza nem apaga atos, receitas ou atribuições.

## Resumos e preservação financeira

`autoria.metodos.criado_por_extra` e `colaboradores[].metodos.criado_por_extra` são contagens inteiras, mantendo os outros cinco métodos. O marco é `atribuicao_gerencial`; a fonte é `Extra Digital` quando há apenas este método/direta, ou `Extra Digital + Trello` quando há método Trello. A explicação vigente fica em `autoria.criterio`; as convenções anteriores em `autoria.criterios_anteriores`. O papel da pessoa fica em `evidencia.decisao.colaborador.papel` no histórico privado.

Os campos brutos `originais`, lotes, versões, contagens oficiais, financeiro, receitas e vínculos de protocolo não são alterados por atribuirAutoria. A troca de método não autoriza rateio de receita nem equipara o usuário financeiro ao autor gerencial.

## Validação local

`node --test test/atos-lavrados*.test.js`. Os testes de PostgreSQL usam exclusivamente `ATOS_TEST_DATABASE_URL` apontado para banco de testes local e schemas efêmeros. Cobrem troca de revisão 1→2, idempotência, concorrência, prioridade vigente, mudança de cadastro após prévia, papéis, hash/lote ativo, reinicialização do CHECK e preservação byte a byte dos JSON financeiros e fontes importadas. Nenhum teste importa fontes reais.
