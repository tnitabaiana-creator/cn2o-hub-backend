# Fonte comum de atos lavrados

Critério aprovado: somente Extra Digital, status numérico **4** e rótulo **Registrado(a)**. O mês deriva da data de lavratura (`Data`/`dataMinuta`), não da assinatura, importação, distribuição ou conclusão no Trello.

## Separação das fontes

Extra Digital fornece a quantidade oficial; Trello fornece cartões e tempos do fluxo; `produtividade_mes` conserva lançamentos e valores financeiros. Um cartão pode estar ligado a vários atos. A consulta não multiplica os pesos/cartões nem atribui `U.criador` como responsável. Relatórios HTML, texto, CSV e JSON exibem o total oficial separado dos indicadores Trello. Mensagens já enviadas permanecem históricas.

Fluxo: CSV privado → importador que preserva as colunas → prévia autenticada → lote/versões mensais PostgreSQL → consulta comum mensal ou semanal. O arquivo original deve permanecer no backup privado; não integrar Git ou arquivos públicos.

## Contrato de importação

`POST /hub/atos-lavrados/lotes/validar` faz a prévia sem inserir lotes/versões/atos. `POST /hub/atos-lavrados/lotes` confirma o mesmo corpo. Ambos exigem sessão individual de administrador. Limite: 20 MiB, 50 mil registros, 60 meses por lote.

```json
{
  "operacao_id": "93f1c8af-c0ee-4de2-9e37-e0c3814138be",
  "fonte": {"sistema":"Extra Digital","arquivo":"fonte.csv","sha256":"SHA256_HEXADECIMAL_DO_ARQUIVO_COM_64_CARACTERES"},
  "meses": [{"mes":"2026-06","ate":"2026-06-30","revisao_base":0,"corte_em":"2026-07-01T09:00:00-03:00","dia_final_completo":true}],
  "registros": [{
    "minuta":"2035","protocolo":"100","livro":"795","folha":"51",
    "documento":"Escritura com Valor","data_lavratura":"2026-06-05",
    "status":4,"status_nome":"Registrado(a)",
    "originais":{"Minuta":"2035","Protocolo":"100","Data":"05/06/2026","U.criador":"campo original"}
  }]
}
```

Cada mês declara cobertura do primeiro dia até `ate`, inclusive, com `corte_em` (instante real da extração, ISO com fuso) e `dia_final_completo` (boolean obrigatório). O dia civil é interpretado em `America/Sao_Paulo`. Uma extração durante `ate` exige `false`; um dia declarado completo exige instante de corte posterior àquela data. Exemplo: `ate:"2026-10-09",corte_em:"2026-10-09T17:23:00-03:00",dia_final_completo:false`. Períodos que alcançam esse dia ficam parciais; dias encerrados anteriores podem ter contagem oficial. Não inventar hora de extração nem presumir que uma data final significa dia encerrado.

O lote substitui somente as fotografias dos meses declarados, mesmo quando seu conjunto é vazio; meses omitidos permanecem intactos. `revisao_base` deve corresponder à versão consultada (zero para mês ainda inexistente). O servidor deriva autoria da sessão, calcula hash canônico do conteúdo e conserva pedido, originais e todas as versões. O hash mensal também inclui metadados de cobertura. O hash em `fonte.sha256` é declarado pelo importador; não substitui o hash calculado pelo servidor nem prova conteúdo de arquivo não enviado ao servidor.

A chave auditável é SHA-256 do array JSON **[Minuta, Protocolo, Livro, Folha, Documento]**. A identidade estável **Documento + Minuta** deve ser única no lote e entre meses ativos, de modo que corrigir Protocolo, Livro ou Folha não crie outro ato. Não deduplicar por Protocolo ou Livro/Folha isolados. Todos são strings, preservando zeros. Duplicatas no mesmo lote são rejeitadas; uma identidade ativa em mês não coberto exige incluir o mês anterior na conciliação para evitar contagem dupla ao corrigir a data, mesmo que o protocolo também mude. Uma correção altera a chave auditável e preserva a versão anterior; eventual vínculo Hub exige nova conferência por evidência, sem transferência automática.

Exceção documental: Protocolo pode estar vazio quando `protocolo:""`, `originais.Protocolo:""` e `pendencia_identificacao:["protocolo_ausente_na_fonte"]` são explícitos. Os outros quatro campos continuam obrigatórios. Esse ato integra o total oficial e o contador de pendências de identificação; não recebe vínculo automático. Nenhum campo ausente é inventado.

Repetir `operacao_id` com mesmo conteúdo retorna a confirmação anterior, sem nova versão. Outro conteúdo com o mesmo identificador retorna 409. Alteração concorrente de qualquer mês impede todo o lote. Data impossível, status incompatível, falta de origem ou registro fora da cobertura rejeita integralmente o lote: não há descarte silencioso.

## Leitura e vínculo

- `GET /hub/atos-lavrados/meses`: `{criterio,meses:[{mes,ate,corte_em,dia_final_completo,revisao,sha256,importado_em,total_oficial,total_observado,cobertura_completa,com_vinculo,sem_vinculo,com_pendencia_identificacao}]}`. Timestamp retornado em UTC; exibir em `America/Sao_Paulo`. Recibos e versões também conservam o corte e a declaração do dia final.
- `GET /hub/atos-lavrados/resumo?inicio=2026-06-01&fim=2026-06-30`: limites civis inclusivos. Mesmo critério e contadores, agregados para qualquer período mensal/semanal; traz as coberturas dos meses envolvidos.
- `GET /hub/atos-lavrados/atos?inicio=...&fim=...&pagina=1`: até 100 atos com chave, data, registro original/normalizado, protocolo do Hub e revisão/evidência do vínculo.
- `GET /hub/atos-lavrados/meses/2026-06/versoes`: histórico das fotografias, inclusive referência ao lote.
- `GET /hub/atos-lavrados/lotes/UUID/backup`: pedido original, fonte, hash calculado e autoria/data da importação.
- `POST /hub/atos-lavrados/vinculos`: `{chave,protocolo_hub:100,revisao_base:0,evidencia:{tipo:"referencia_documental",referencia:"documento/item que demonstra a associação"}}`. Exige ato ativo e protocolo existente; mantém histórico. Nenhum vínculo por semelhança de nome, criador ou coincidência numérica é feito automaticamente.

`total_oficial` é **null** quando falta cobertura de algum dia solicitado ou o período alcança o dia final parcial, e não zero. A competência mensal só é completa se `ate` for o último dia e `dia_final_completo:true`. Versões sem metadados de corte permanecem desconhecidas. `total_observado` mostra quantos registros foram efetivamente importados naquele intervalo. Um mês parcial pode cobrir integralmente uma semana encerrada. `sem_vinculo` refere-se ao protocolo Hub, não à ausência de autoria. Sem fonte disponível, o relatório legado continua e informa explicitamente a indisponibilidade da contagem oficial.

## Recuperação e operação

Antes de importar, conservar CSV, hash e exportações dos lotes/versões anteriores em destino privado. Para desfazer uma importação, preparar **novo lote** com o conteúdo anterior, novo `operacao_id`, cobertura anterior e `revisao_base` atual. Isso conserva histórico e registra quem restaurou. Não apagar tabelas, sobrescrever lotes, alterar `produtividade_mes.dados.atos` ou reenviar e-mails automaticamente.

As seis tabelas são criadas por migração idempotente sob lock; importações e vínculos usam transações com lock, versões mensais e consultas consistentes. Todas as rotas são privadas, JSON e `no-store`; erros não imprimem conteúdo nem credenciais. A primeira inicialização pode criar o schema, inclusive antes de uma prévia; a prévia não grava dados do lote.

Reavaliar particionamento/paginação por cursor e índice materializado se o histórico superar centenas de milhares de atos. O volume atual permite snapshots mensais sem fila ou infraestrutura adicional. A simplicidade e a possibilidade de restauração foram priorizadas; não há exclusão física de versões.

## CLI operacional

Sem sessão do navegador, no ambiente autorizado com `DATABASE_URL` já configurada:

```text
node scripts/importar-atos-lavrados.js --stdin-base64 --autor cesar.bravo
node scripts/importar-atos-lavrados.js --stdin-base64 --autor cesar.bravo --aplicar
```

Enviar pelo stdin o lote JSON UTF-8 codificado em base64 canônico, sem quebra final. Alternativa local: `--arquivo CAMINHO_PRIVADO.json`. A primeira forma é **prévia por padrão**; somente `--aplicar` grava dados. A autoria da CLI é o operador declarado em `--autor`; a da API vem exclusivamente da sessão.

O recibo mostra operação, hash calculado, meses, versões e `versoes_anteriores` com hashes e IDs dos lotes originais, suficientes para obter o backup integral. Todos os snapshots anteriores permanecem no banco. O CLI não imprime atos, nomes, originais, URLs de conexão ou credenciais. Reutilizar o mesmo lote/UUID permite reconciliar uma confirmação perdida sem duplicar a importação. Acesso à CLI e ao ambiente do banco deve permanecer restrito aos operadores autorizados.
