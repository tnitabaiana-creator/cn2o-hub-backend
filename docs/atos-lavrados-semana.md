# Consulta semanal, tipos e autoria das escrituras

## Critério e período

Mantém-se a família Escritura da exportação do Extra Digital, situação 4 Registrado(a), com competência pela data de lavratura. Este módulo não expande a extração para procurações ou testamentos, não altera dados financeiros, pesos Trello, cron de e-mails ou mensagens já enviadas.

`GET /hub/atos-lavrados/semana?referencia=2026-10-09` consulta a semana civil **segunda a domingo** que contém a referência. Sem referência, usa a data atual em `America/Sao_Paulo`, inclusive na mudança de dia UTC. Uma extração sexta às 17h tem dia parcial; sua semana permanece parcial. A fotografia posterior pode incluir atos da sexta após o corte, do sábado e do domingo, sem duplicar os anteriores.

A consulta lê somente fotografias já importadas. A execução semanal precisa exportar a fonte do início de cada mês envolvido até o corte real, preparar o lote, validar e aplicar usando o fluxo operacional existente. Não importar somente a semana como se fosse fotografia mensal: isso apagaria, da visão corrente, atos das semanas anteriores. O histórico de versões permanece preservado.

Fluxo executável:

```text
Exportação privada do CTN → preparar-lote-extra-digital.cjs → prévia do lote
→ importar-atos-lavrados.js --aplicar → GET /semana → conferência do recibo
```

Os scripts não contêm credenciais e não extraem automaticamente de uma sessão CTN. A orquestração da exportação deve fornecer a fonte real e o instante de corte, sem inventar horas nem repetir uma importação de resultado incerto. O backend não agenda coleta do CTN nem modifica o agendador legado.

## Contrato de leitura

Rotas exigem sessão de administrador e retornam JSON privado `no-store`:

- `GET /hub/atos-lavrados/semana?referencia=AAAA-MM-DD` retorna `referencia`, `fuso`, `inicio` e `fim` da semana, além do resumo detalhado abaixo.
- `GET /hub/atos-lavrados/resumo?inicio=AAAA-MM-DD&fim=AAAA-MM-DD` retorna o mesmo detalhamento para um mês ou período explícito.
- `/meses` permanece uma lista leve de competências, totais e cobertura.

O resumo preserva `criterio`, `inicio`, `fim`, `total_observado`, `total_oficial`, `cobertura_completa`, `com_vinculo`, `sem_vinculo`, `com_pendencia_identificacao` e `meses`. Cada mês conserva `ate`, `corte_em` e `dia_final_completo`; uma semana entre meses pode ter dois cortes. Não resumir estes cortes a um horário único que esconda uma lacuna.

Campos adicionais:

```text
tipos: [{codigo, nome, total_observado, total_oficial}]
classificacao: {
  versao: "extra-digital-tipos-v1", campos: ["Sub-tipo", "Finalidade"],
  nao_classificados, divergentes, por_subtipo, por_finalidade
}
colaboradores: [{id, nome, fonte, marcos, total_observado, total_oficial,
  metodos: {direta, auditoria_concordante, trello_divergencia}}]
autoria: {
  status: "pendente" | "parcial" | "confirmada", criterio,
  sem_autoria_confirmada, com_autoria_confirmada, cobertura_completa,
  metodos: {direta, auditoria_concordante, trello_divergencia}
}
```

Os tipos somam `total_observado`; incluem `nao_classificado` quando necessário. Todos os `total_oficial` por tipo ficam nulos enquanto o período estiver parcial. A classificação é recalculada sob a mesma transação consistente dos totais, sem alterar os campos originais.

`Documento=Notas` e `Sub-tipo=Escritura com Valor` são genéricos. **Não significam compra e venda.** Tipos específicos vêm de `Sub-tipo` explícito ou do início explícito de `Finalidade`, inclusive códigos delimitados CV, CDP, CDH, INV, DOA e ATA. Não há busca aproximada, classificação por cliente/usuário, por peso financeiro ou por título Trello. Conflito entre tipo estruturado e finalidade reconhecida fica pendente. Retificação de compra e venda conta como retificação, não como nova compra e venda. O resumo não devolve o texto livre de Finalidade, que pode conter nomes de clientes.

## Atribuição de quem lavrou ou registrou

A regra prioritária é o **colaborador que lavrou ou registrou a escritura**, com evidência direta. `U. criador`, `U. Alterou`, `Criado Por`, última alteração e a pessoa que protocolou, isoladamente, não provam essa atuação. O titular autorizou um complemento gerencial separado, descrito abaixo: auditoria completa de alterações comparada ao responsável explícito no Trello. Sem prova suficiente por qualquer dos métodos, o ato integra o total da fonte e `sem_autoria_confirmada`; não significa produtividade individual zero.

As tabelas `atos_lavrados_autorias` e `atos_lavrados_autoria_historico` conservam confirmação atual e histórico por **Documento + Minuta**. Assim, corrigir protocolo ou substituir a fotografia mensal não apaga confirmações, e um ato não é multiplicado por quantidade de evidências. A consulta usa somente atos presentes na fotografia corrente. Remover um ato da fotografia não destrói seu histórico de atribuições.

`POST /hub/atos-lavrados/autorias`:

```json
{
  "chave": "SHA256_DA_CHAVE_DO_ATO_COM_64_CARACTERES",
  "revisao_base": 0,
  "colaborador": {"id": "identificador_confirmado_na_fonte", "nome": "Nome confirmado"},
  "evidencia": {
    "tipo": "registro_lavratura_extra",
    "marco": "registro",
    "referencia": "Cadastro da minuta / identificador do evento ou documento conferido",
    "campo_ou_evento": "Usuário responsável pelo evento de registro",
    "valor_original": "Valor literal da evidência conferida"
  }
}
```

`marco` aceita `registro` ou `lavratura`. Não inventar colaborador, identificador, campo ou evento. O endpoint é uma confirmação documental administrativa; não atesta sozinho que o dado foi obtido do CTN. Quem confirma vem da sessão autenticada, e revisões concorrentes retornam 409. Os originais da extração continuam separados, sem inserir responsável presumido no lote.

Resposta: `{chave,documento,minuta,revisao,situacao,metodo,colaborador}`. Método direto é `direta`; revogação retorna `metodo:null,colaborador:null`. Antes de corrigir ou repetir uma confirmação de resultado incerto, ler `GET /hub/atos-lavrados/autorias/:chave/historico`. O histórico também pode ser consultado por uma chave antiga, após correção do protocolo. Não reaplicar automaticamente usando uma revisão mais recente.

Revogação auditada:

```json
{"chave":"SHA256_DA_CHAVE_DO_ATO_COM_64_CARACTERES","revisao_base":1,"revogar":true,"motivo":"Motivo documental da correção"}
```

A revogação devolve o ato à pendência sem apagar a evidência anterior. Uma confirmação posterior exige nova evidência e a revisão atual.

`colaboradores.total_observado` conta atribuições confirmadas até o momento. A soma destes valores mais `sem_autoria_confirmada` é o total observado da fonte. O total individual só recebe `total_oficial` quando **o período e todas as atribuições estiverem completos**; antes disso, não apresentar o subconjunto conhecido como produtividade total do colaborador. `marcos` distingue `lavratura`, `registro` e `atribuicao_gerencial`. `metodos` soma o total atribuído de cada colaborador e, no objeto `autoria`, o total `com_autoria_confirmada`. `fonte` é `Extra Digital` quando só há atribuição direta e `Extra Digital + Trello` quando há qualquer complemento gerencial. Os campos legados de autoria também incluem o complemento; a interface deve explicar o método, sem apresentar todos como prova direta de lavratura.

## Complemento gerencial por auditoria e Trello

Na ausência de atribuição direta vigente, o servidor identifica o **último escrevente** que alterou minuta ou protocolo na auditoria integral até o corte, e compara com o responsável explícito e único no cartão. Se coincidirem, método `auditoria_concordante`; se divergirem, prevalece o responsável Trello e o método é `trello_divergencia`. Uma atualização posterior de recepção ou outro operador identificado no cadastro não muda quem foi o último escrevente. Operador desconhecido, identidade ambígua, empate entre escreventes diferentes sem ordem comprovada ou lista de responsáveis vazia/múltipla impede confirmar. Eventos simultâneos do mesmo escrevente confirmam uma única atribuição, guardando todos os IDs em `decisao.ultimos_eventos_ids`; `ultimo_evento_id` só é preenchido quando há um único evento final.

O mesmo `POST /hub/atos-lavrados/autorias` aceita este contrato. Exemplo **sintético**, sem evidências reais:

```json
{
  "chave": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "revisao_base": 0,
  "evidencia": {
    "tipo": "auditoria_trello_criterio_titular",
    "marco": "atribuicao_gerencial",
    "corte_em": "2026-10-09T17:00:00-03:00",
    "ato": {"documento":"Notas","minuta":"1","protocolo":"10","livro":"1","folha":"1"},
    "auditoria": {
      "referencia": "Captura privada da auditoria integral da minuta 1",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "coletado_em": "2026-10-09T17:05:00-03:00",
      "completa_ate_corte": true,
      "ato": {"documento":"Notas","minuta":"1","protocolo":"10","livro":"1","folha":"1"},
      "eventos": [{"id":"evento-1","em":"2026-10-09T10:00:00-03:00","acao":"alteracao_minuta",
        "usuario_original":"pessoa.ficticia","colaborador":{"id":"pessoa.ficticia","nome":"Pessoa Fictícia"}}]
    },
    "trello": {
      "referencia":"Captura privada do campo responsável no cartão",
      "sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "coletado_em":"2026-10-09T17:05:00-03:00",
      "ato":{"documento":"Notas","minuta":"1","protocolo":"10","livro":"1","folha":"1"},
      "cartao_id":"dddddddddddddddddddddddd",
      "campo_responsavel":"Escrevente responsável",
      "responsaveis":[{"valor_original":"pessoa.ficticia","colaborador":{"id":"pessoa.ficticia","nome":"Pessoa Fictícia"}}]
    }
  }
}
```

Não enviar `colaborador` no topo, método, decisão ou hash calculado: o servidor os determina. Em cada fonte, a identificação completa deve ser idêntica ao ato ativo, incluindo as cinco posições; protocolo vazio legítimo continua possível. Mesmo protocolo em dois atos não os associa. Evento aceita `alteracao_minuta` ou `alteracao_protocolo`, ID único, instante ISO com fuso e usuário literal. Todos os eventos até o corte precisam estar incluídos; a declaração de completude é de quem conferiu a fonte. Coleta anterior ao corte ou evento posterior ao corte é rejeitado. O responsável Trello precisa estar comprovado **para esse mesmo corte**; coleta posterior, por si só, não prova seu estado anterior.

O cadastro local fornece a identidade canônica por login e nome. Não há filtro `ativo`: desligamento atual não elimina atos históricos. A tabela `escreventes` comprova o papel; a identidade de `usuarios` permite reconhecer outros operadores, e o cargo exato `Escrevente` também confirma esse papel. O nome de `usuarios` do mesmo login é uma variante documental aceita além do nome em `escreventes`. A conferência usa normalização Unicode, caixa e espaços, sem aproximação de nomes. Texto original da fonte deve coincidir inequivocamente com nome/login cadastrado; associação fornecida em `colaborador` é opcional, mas, se enviada, deve concordar. Nome duplicado, apelido não cadastrado ou `(MEMO)` mantém pendência. Um papel histórico que não possa ser confirmado no cadastro exige conferência da identidade antes de alimentar o complemento; não se presume por cargo semelhante.

Novas atribuições diretas também normalizam o ID antes de persistir, sem modificar `evidencia.valor_original`. O agrupamento do resumo aplica caixa minúscula e remoção de espaços externos aos IDs legados: `PESSOA.1` e `pessoa.1` não dividem a produção do mesmo colaborador. O histórico literal anterior permanece preservado.

Falha de evidência suficiente retorna HTTP **422**:

```json
{"codigo":"PENDENTE_SEM_ATRIBUICAO","erro":"evidências insuficientes ou ambíguas; nenhuma atribuição foi alterada","pendencias":["TRELLO_RESPONSAVEL_NAO_UNICO"]}
```

Não cria versão e não apaga nem rebaixa atribuição válida existente. Identidade do ato divergente retorna 409 `IDENTIDADE_DIVERGENTE`; revisão incorreta, 409 `REVISAO_DESATUALIZADA`; tentativa de substituir direta pelo complemento, 409 `AUTORIA_DIRETA_PRIORITARIA`. Corte, coleta ou evento no futuro, ou corte anterior ao dia da lavratura em Brasília, retorna 400 `EVIDENCIA_TEMPORAL_INVALIDA`, sem mutação. Direta pode substituir complemento mediante nova revisão. Revogação permanece uma operação explícita auditada. Operador desconhecido em qualquer ponto da auditoria mantém pendência por conservadorismo: sem seu papel confirmado, não se presume que seja irrelevante.

O histórico conserva tipo, marco, fontes, hashes declarados, eventos, instante de corte, decisão e instantâneo dos colaboradores conferidos. `sha256_calculado` é calculado pelo servidor sobre a evidência canônica, antes de inserir o próprio hash. O hash declarado de uma captura é referência auditável, não autenticação de conteúdo não enviado. A API não acessa CTN/Trello, não extrai auditoria, não prova a completude de uma captura e não deve ser alimentada por CSV resumido ou `(MEMO)` como se fossem eventos. Confirmação exige sessão administrativa e preservação privada das fontes; nenhuma evidência real é semeada por esta migração.

Uma atribuição gerencial confirmada também está protegida contra retrocesso do corte: evidência anterior retorna 409 `EVIDENCIA_ANTIGA`, mesmo com revisão-base atual. Ato elaborado antes de sua lavratura pode ter eventos anteriores a ela; é o corte da prova, e não a data de cada alteração de minuta, que deve alcançar a lavratura. Correção deliberada de atribuição incorreta continua passando pelo histórico e pela revogação explícita, nunca por substituição automática com captura antiga.

## Validação e limites

Testes cobrem fuso, domingo, virada de mês/ano, sexta parcial, complemento do fim de semana, conflito de classificação, ausência de autoria, autenticação, concorrência, histórico, revogação e preservação da atribuição após correção do protocolo. As consultas de totais, tipos e autores usam uma transação `REPEATABLE READ READ ONLY` para evitar somas divergentes durante uma importação.

A classificação é deliberadamente conservadora: grafias não reconhecidas ficam pendentes para conferência. Reavaliar regras versionadas ao surgir coluna estruturada de tipo ou responsável real no CTN. O complemento exige a auditoria e o responsável Trello conferidos; nenhum campo isolado de criação ou alteração é convertido automaticamente. Os testes PostgreSQL também verificam migração do CHECK antigo, escrevente desligado, prioridade direta, decisão por método, somas, hash do histórico, concorrência, 401/403 e pendência sem mutação.
