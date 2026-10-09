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
colaboradores: [{id, nome, fonte: "Extra Digital", marcos, total_observado, total_oficial}]
autoria: {
  status: "pendente" | "parcial" | "confirmada", criterio,
  sem_autoria_confirmada, com_autoria_confirmada, cobertura_completa
}
```

Os tipos somam `total_observado`; incluem `nao_classificado` quando necessário. Todos os `total_oficial` por tipo ficam nulos enquanto o período estiver parcial. A classificação é recalculada sob a mesma transação consistente dos totais, sem alterar os campos originais.

`Documento=Notas` e `Sub-tipo=Escritura com Valor` são genéricos. **Não significam compra e venda.** Tipos específicos vêm de `Sub-tipo` explícito ou do início explícito de `Finalidade`, inclusive códigos delimitados CV, CDP, CDH, INV, DOA e ATA. Não há busca aproximada, classificação por cliente/usuário, por peso financeiro ou por título Trello. Conflito entre tipo estruturado e finalidade reconhecida fica pendente. Retificação de compra e venda conta como retificação, não como nova compra e venda. O resumo não devolve o texto livre de Finalidade, que pode conter nomes de clientes.

## Atribuição de quem lavrou ou registrou

A regra aprovada é o **colaborador que lavrou ou registrou a escritura**. `U. criador`, `U. Alterou`, `Criado Por`, última alteração e a pessoa que protocolou não provam essa atuação. Enquanto não houver evidência específica, o ato conta no total da fonte e em `sem_autoria_confirmada`; não é atribuído a alguém e não significa produtividade individual zero.

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

Resposta: `{chave,documento,minuta,revisao,situacao}`. Antes de corrigir ou repetir uma confirmação de resultado incerto, ler `GET /hub/atos-lavrados/autorias/:chave/historico`. O histórico também pode ser consultado por uma chave antiga, após correção do protocolo. Não reaplicar automaticamente usando uma revisão mais recente.

Revogação auditada:

```json
{"chave":"SHA256_DA_CHAVE_DO_ATO_COM_64_CARACTERES","revisao_base":1,"revogar":true,"motivo":"Motivo documental da correção"}
```

A revogação devolve o ato à pendência sem apagar a evidência anterior. Uma confirmação posterior exige nova evidência e a revisão atual.

`colaboradores.total_observado` conta atribuições confirmadas até o momento. A soma destes valores mais `sem_autoria_confirmada` é o total observado da fonte. O total individual só recebe `total_oficial` quando **o período e todas as atribuições estiverem completos**; antes disso, não apresentar o subconjunto conhecido como produtividade total do colaborador. `marcos` indica se a evidência é de lavratura, registro ou ambos nos atos daquele colaborador.

## Validação e limites

Testes cobrem fuso, domingo, virada de mês/ano, sexta parcial, complemento do fim de semana, conflito de classificação, ausência de autoria, autenticação, concorrência, histórico, revogação e preservação da atribuição após correção do protocolo. As consultas de totais, tipos e autores usam uma transação `REPEATABLE READ READ ONLY` para evitar somas divergentes durante uma importação.

A classificação é deliberadamente conservadora: grafias não reconhecidas ficam pendentes para conferência. Reavaliar regras versionadas ao surgir uma coluna estruturada de tipo ou responsável real no CTN. Não converter esses casos em atribuição automática com base em usuários de criação ou alteração.
