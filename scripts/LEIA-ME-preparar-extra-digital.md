# Preparação offline da rotina semanal do Extra Digital

`preparar-lote-extra-digital.cjs` transforma CSVs oficiais exportados do CTN em lotes do contrato de atos lavrados. Usa a função real `validarLote` do backend, sem abrir conexão com PostgreSQL, Hub, CTN ou qualquer serviço. Não faz login, exportação, publicação, importação, envio de relatórios ou alteração de arquivos originais.

Operação completa: consulte também `../SINCRONIZACAO-SEMANAL-EXTRA-DIGITAL.md`. A agenda é sexta-feira, às 17h, em `America/Sao_Paulo`. A semana civil abrange **segunda a domingo**. A extração realizada na sexta ainda é parcial; não representa o fechamento do dia ou da semana. Uma reconsulta posterior deve incluir registros tardios da sexta e atos do fim de semana.

## Cobertura mensal obrigatória

O importador do Hub substitui as fotografias dos meses declarados. **Nunca forneça somente os registros da semana:** isso retiraria da fotografia ativa atos do restante do mês.

Em cada execução:

1. Consulte e preserve um snapshot privado de `GET /hub/atos-lavrados/meses`, contendo os meses ativos e suas revisões. O helper não consulta esse endpoint.
2. Exporte da família **Escritura**, situação **4 — Registrado(a)**, acervo novo, desde o dia 1 dos meses afetados. Atualize, no mínimo, **mês corrente e mês anterior**. Cada mês deve estar inteiramente em uma única fonte CSV; os arquivos não podem repartir nem repetir o mesmo mês.
3. Para meses anteriores à data da extração, inclua todo o mês até o último dia. Para o mês corrente, inclua dia 1 até o dia da extração, informando o instante real com fuso. Não use a hora programada como se fosse o instante de exportação.
4. Mantenha os arquivos originais e seus SHA-256 em local privado. Confirme o filtro e a integridade da exportação antes de declarar `cobertura_mensal_confirmada:true`. O conteúdo do CSV não permite comprovar sozinho que o filtro da interface cobriu todos os dias.
5. Preencha cada `revisao_base` a partir do snapshot. Zero significa mês ainda ausente; não é um padrão de sobrescrita.
6. Prepare o lote; depois execute a prévia autenticada e reconfirme as revisões atuais antes de importar. A prévia local não substitui essa validação no servidor.

Um mês sem atos requer `confirmar_mes_sem_atos:true` na fonte. É uma confirmação adicional porque uma fotografia vazia poderá retirar todos os atos ativos daquele mês. Nenhuma linha é descartada silenciosamente: status inadequado, data inválida, duplicidade ou falta de campo obrigatório rejeitam a preparação.

## Registros tardios e cancelamentos

Uma exportação mensal nova pode conter registros lavrados antes da execução atual. Eles permanecem na competência da **data de lavratura**, sem serem deslocados para a semana de importação. Um ato agora cancelado deixará de aparecer na exportação filtrada por Registrado(a), e a substituição mensal poderá retirá-lo da fotografia ativa, preservando as versões anteriores no Hub.

Corrente + anterior é uma cobertura mínima, **não uma garantia** de capturar alterações em qualquer data histórica. O recibo informa os meses anteriores do snapshot que ficaram sem revisão. A política `historico_integral` exige snapshot e todos esses meses; é a opção prudente enquanto não houver um histórico confiável de alterações por data de modificação. Para cancelamento ou correção conhecida em mês antigo, reexporte esse mês inteiro imediatamente. Se a correção mudar a data de lavratura de um mês para outro, inclua os dois meses completos na mesma conciliação. O backend bloqueia identidade ativa em mês que ficou fora da atualização.

## Configuração privada de exemplo

Todos os caminhos relativos são resolvidos a partir da pasta do arquivo de configuração. Ajuste o exemplo aos horários e arquivos realmente exportados. Ele é ilustrativo e não descreve uma extração já realizada.

```json
{
  "versao": 1,
  "corte_rotina": "2026-10-16T17:00:00-03:00",
  "semana": {"inicio":"2026-10-12","fim":"2026-10-18"},
  "politica_historico": "corrente_e_anterior",
  "snapshot_meses": "snapshot-meses-antes.json",
  "fontes": [{
    "arquivo": "extra-digital-2026-09-01-a-2026-10-16.csv",
    "encoding": "auto",
    "corte_em": "2026-10-16T17:06:23-03:00",
    "familia": "Escritura",
    "situacao": 4,
    "cobertura_mensal_confirmada": true,
    "meses": [
      {"mes":"2026-09","de":"2026-09-01","ate":"2026-09-30","revisao_base":1},
      {"mes":"2026-10","de":"2026-10-01","ate":"2026-10-16","revisao_base":1}
    ]
  }]
}
```

O snapshot usa o contrato `{ "meses": [{ "mes":"2026-09", "revisao":1 }, ...] }`, aceitando os demais campos retornados pela API. Um snapshot ausente permite preparação offline com revisões explicitamente declaradas, mas gera pendência visível; não confirma atualidade das revisões. `historico_integral` exige snapshot.

`encoding` aceita `auto`, `windows-1252`/`cp1252` e `utf-8`. Em modo automático, UTF-8 válido/BOM é reconhecido, com fallback para Windows-1252; o encoding adotado fica no recibo. CSV semicolonado com aspas, ponto e vírgula e quebras de linha dentro de campos é preservado. O cabeçalho deve estar na primeira linha.

## Executar

```text
node scripts/preparar-lote-extra-digital.cjs --config CAMINHO_PRIVADO/config-semanal.json --saida DIRETORIO_PRIVADO
```

A pasta de saída precisa ficar **fora do repositório**. São criados um lote por CSV e `estado-semanal.json`, em pasta identificada pela semana e UUID da preparação. O recibo contém somente contagens, classificação por subtipo literal, cobertura, hashes, IDs, revisões e pendências; os lotes conservam todos os campos originais, inclusive dados pessoais da fonte.

O estado é sempre `PREPARADO_OFFLINE` e `importado_em_producao:false`. Não altere esse recibo para fingir confirmação. Guarde em arquivo separado o recibo autenticado retornado pela importação e reconcilie IDs, hashes, revisões e totais. A automação só pode afirmar atualização depois dessa verificação.

Reexecução com os mesmos dados, fontes, cobertura e revisões produz os mesmos UUIDs e bytes. Arquivos existentes idênticos são mantidos; conteúdo divergente não é sobrescrito. Modificar fonte, corte ou revisão produz outro lote. Uma confirmação remota incerta deve ser investigada pelo UUID original antes de criar nova operação.

## Classificação e autoria

O recibo agrega o **Sub-tipo literal** do CTN e conserva `Finalidade` somente nos originais privados. Não tenta classificar pelo nome de cliente ou por coincidências de texto. Agrupamentos adicionais de tipo são responsabilidade do serviço de relatórios, mediante regras explícitas e verificáveis.

`U. criador` e `U. Alterou` **não são convertidos em escrevente responsável**. Sem campo documental de autoria confirmado, não se inventa distribuição por colaborador. O protocolo vazio só é aceito quando vazio na fonte, com `pendencia_identificacao:["protocolo_ausente_na_fonte"]`; não recebe vínculo Trello automático.

## Testes e limites

```text
node scripts/test-preparar-extra-digital.cjs
node scripts/test-preparar-extra-digital.cjs --fontes-dir DIRETORIO_DOS_CSVS_DE_09_10_2026 --saida DIRETORIO_PRIVADO
```

A segunda forma acrescenta conferência das duas fontes históricas reais de junho–outubro de 2026, totalizando 915 atos. Verifica contagens mensais, identidade de todos os campos originais, SHA-256 preservado e reexecução. Não imprime nomes de partes. Os casos sintéticos cobrem CP1252, CSV com aspas/quebras, protocolo ausente, data impossível, cancelado, duplicidade, mês repartido, exportação semanal indevida, snapshot divergente, mês vazio e viradas de mês/ano.

Os testes não comprovam disponibilidade da Railway, deploy, autenticidade do snapshot informado, completude dos filtros da interface ou importação em produção. A semana civil segunda–domingo com corte na sexta fica parcial. A reconsulta depois do domingo deve usar o mesmo recorte semanal e exportações mensais novas, com instantes reais atualizados, incluindo atos tardios, sábado e domingo. O campo `corte_rotina` mantém a sexta programada; `fontes[].corte_em` registra o instante efetivo de cada extração posterior.
