# Imagens na Minha Agenda

Uma imagem por usuário, data e faixa de horário. O texto continua usando o autosave existente. Os anexos ficam no mesmo PostgreSQL, em colunas opcionais de `hub_agenda`; não há links públicos nem armazenamento de conteúdo no navegador após sair.

## Contrato

- `GET /hub/agenda?de=&ate=` retorna somente metadados do anexo (`mime`, `bytes`, `versao`).
- `POST /hub/agenda` edita o texto e preserva a imagem. Texto vazio só remove a célula quando não há imagem.
- `POST /hub/agenda/imagem` recebe `{dia, faixa, imagem: {mime, base64}}`; `imagem: null` remove apenas o anexo.
- `GET /hub/agenda/imagem?dia=&faixa=` entrega os bytes com sessão válida, apenas para o dono, sem cache.
- Uma imagem armazenada tem até 1 MiB; formatos PNG, JPEG e WebP estáticos. O servidor valida base64, estrutura e dimensões. A interface reduz os arquivos antes do envio e admite colar prints no campo de anotação.

Texto e imagem usam a mesma trava transacional por célula. Assim, o upload e o autosave podem ocorrer juntos sem sobrescrever campos diferentes. A última edição do mesmo campo prevalece.

## Publicação e recuperação

A migração é aditiva e idempotente, executada por `preparar()` do Hub. Não executar `npm run setup` para esta atualização. Publicar primeiro o backend e depois o frontend; o frontend anterior permanece compatível com o backend novo.

Se for necessário retirar os controles da interface, restaurar somente o frontend anterior (`ef8c936`). Manter o backend que preserva anexos e todas as colunas de imagem. **Não restaurar o backend antigo sobre anexos já cadastrados:** seu tratamento de texto vazio apagava a célula inteira. Uma recuperação do backend deve preservar esta lógica ou incluir uma correção equivalente.

Os backups PostgreSQL passam a incluir os bytes das imagens cadastradas após esta atualização. Backups anteriores não contêm esses anexos.

## Validação

Testes de formato/limites, atualização de esquema legado e integração HTTP com PostgreSQL isolado cobrem persistência, remoção, acesso de outro usuário e concorrência entre texto e imagem. Os testes não devem usar o banco de produção. A conferência visual usa dados fictícios locais.
