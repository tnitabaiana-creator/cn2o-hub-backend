# Histórico do controle de prazos

## 2026-10-14 — correção do início setorial

- Titular confirmou que o setor inicia na entrada em **Em Digitalização**.
- Corrigidos contador Trello, prazo setorial, home, agenda e texto dos alertas.
- Recuperado o horário original da movimentação, sem zerar o tempo já decorrido.
- A regra abaixo da versão .3 foi substituída; o prazo geral do ato permanece independente.

## 2026-10-14.5

- Inventário simples (uma sucessão): 4 dias úteis.
- Inventário cumulativo ou complexo: 10 dias úteis, por caixa própria no protocolo.
- Reclassificação de cartão existente por item marcado na checklist, conservando o início original.
- Quadro de Avisos: tabela de prazos e orientação de contagem para a equipe.

## 2026-10-14.4

- Compra e venda urbana/rural com etiqueta Santa Mônica ou bandeira rosa: 3 dias corridos.
- Demais construtoras e loteadoras permanecem com 5 dias úteis; sem bandeira, 10 dias úteis.
- Retificação dos relógios ativos conserva a entrada original e qualquer prazo menor já vigente.
- Início do ato considera também os eventos originais preservados no Hub após transferência de quadro.

## 2026-10-14.3

- Relógio setorial inicia exclusivamente em Cadastro Extradigital e termina em Gerar Minuta.
- Home, agenda e Trello exibem sinais e avisos de 6h, 7h e 8h úteis.
- Estatística de cumprimento por responsável, ato e período, com evidência de conclusão.
- Seções nos relatórios de produtividade e Protocolo/Cadastro, com exportação CSV.
- Métrica ausente não é representada como 100%; preserva notas e dados financeiros.

## 2026-10-14.2

- Nome aprovado: Relógio do Ato.
- Painel na home com consulta pessoal e visão da equipe para o tabelião.
- Minha Agenda com eventos automáticos em D−2 úteis, D−1 útil e D0, vinculados ao cartão original.
- Nova sessão/transferência/finalização atualiza o acompanhamento sem alterar notas pessoais.
- API autenticada e testes de isolamento de usuários, feriados e mensagens sem repetição.

## 2026-10-14.1

- Marco inicial da escritura: primeira entrada comprovada em Cadastro Extradigital.
- Estado canônico por cartão em Postgres, atravessando listas e quadros.
- Compra e venda urbana/rural sem vendedor corporativo: 10 dias úteis.
- Testamento e certidão: 5 dias úteis; etiqueta Urgente: até 2 dias úteis.
- Relógio geral com cores, vencimento visível e alertas por menção no Trello.
- Relógio setorial de 8 horas e agenda de assinatura preservados.
- Recuperação periódica, diagnóstico administrativo e deduplicação de alertas.
- Validação automatizada: testes de política, calendário, urgência, continuidade,
  assinatura, conclusão e recuperação de resposta de comentário perdida.

Regras e operação: [PRAZOS-ATOS.md](../PRAZOS-ATOS.md).
