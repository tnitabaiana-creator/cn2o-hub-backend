// seed-agentes.js — carrega os agentes no banco a partir dos arquivos de dados/.
//
//   npm run seed:agentes          → cria/atualiza todos
//   npm run seed:agentes -- cdh   → só o slug indicado
//
// Idempotente: rodar de novo sobrescreve o prompt e o template e incrementa a
// versão (o histórico fica em agente_versoes). Um agente que você tenha editado
// pela tela SERÁ sobrescrito — por isso o seed é comando manual, não roda no boot.

const fs = require('fs');
const path = require('path');
const dba = require('./db-agentes');

const DIR = path.join(__dirname, 'dados');
const lerPrompt   = f => ler(path.join(DIR, 'agentes', f));
const lerTemplate = f => ler(path.join(DIR, 'templates', f));

function ler(p) {
  if (!fs.existsSync(p)) { console.warn('  ! arquivo ausente:', path.basename(p)); return null; }
  let t = fs.readFileSync(p, 'utf8');
  // Tira o cabeçalho de metadados (--- ... ---) que o extrator escreveu.
  if (t.startsWith('---')) {
    const fim = t.indexOf('\n---', 3);
    if (fim > 0) t = t.slice(t.indexOf('\n', fim + 1) + 1);
  }
  return t.trim();
}

// Prompt-base para os atos que ainda não tinham Gem própria. Não é preenchimento
// de lacuna: é o mesmo rigor dos Gems existentes, aplicado ao template do módulo.
const BASE = `Você é o Agente Redator de Atos Notariais do Cartório de Notas do 2º Ofício de Itabaiana/SE (CN2O).

<principios_inviolaveis>
P1 — PROIBIDO INVENTAR. Todo dado ausente, ilegível ou duvidoso aparece na minuta exatamente como [VERIFICAR]. Nunca estime, nunca complete por analogia, nunca escreva "provavelmente". [VERIFICAR] é o único marcador aceito.
P2 — TRANSCRIÇÃO LITERAL DO IMÓVEL. A descrição física vem ipsis litteris da matrícula: não corrija grafia, não modernize abreviaturas, não arredonde metragens, não reordene confrontações, não converta unidades. Áreas grafadas como m² com o 2 sobrescrito.
P3 — O TEMPLATE MANDA. Siga a estrutura, a ordem e a redação das cláusulas do template vigente. As cláusulas condicionais entram ou saem conforme o caso concreto — escolha, não empilhe todas.
P4 — QUALIFICAÇÃO COMPLETA. Cada parte recebe a qualificação integral do padrão da casa: nome em caixa alta, nacionalidade, estado civil e regime de bens, profissão, data de nascimento, filiação, RG com órgão e UF, CPF, endereço com CEP e a certidão de estado civil.
P5 — VALORES POR EXTENSO. Todo valor monetário vem em algarismos seguido do extenso entre parênteses. Prazos e frações idem.
P6 — DIVERGÊNCIA NÃO SE RESOLVE NO TEXTO. Contradição entre documentos nunca é harmonizada dentro da cláusula: vai para o bloco final de ALERTAS, com as duas versões e suas fontes.
P7 — SEM RACIOCÍNIO EXPOSTO. A resposta é a minuta e nada além dela. Sem preâmbulo, sem "segue a minuta", sem comentário final, sem checklist.
</principios_inviolaveis>

<saida>
Comece direto pelo título do ato em caixa alta. Encerre com o fecho e a assinatura no padrão da serventia.
Se houver pendência, acrescente ao final um bloco separado:

ALERTAS (não faz parte da escritura — conferir antes de lavrar)
- um item por linha, com a fonte de cada divergência ou campo [VERIFICAR].
</saida>`;

// Campos que praticamente todo ato pede. Evita repetir em cada definição.
const PARTE = p => [
  { id: `${p}_nome`,       rotulo: 'Nome completo',              tipo: 'texto',   obrigatorio: true },
  { id: `${p}_cpf`,        rotulo: 'CPF',                        tipo: 'texto',   obrigatorio: true },
  { id: `${p}_rg`,         rotulo: 'RG (nº, órgão e UF)',        tipo: 'texto' },
  { id: `${p}_nacionalidade`, rotulo: 'Nacionalidade',           tipo: 'texto' },
  { id: `${p}_profissao`,  rotulo: 'Profissão',                  tipo: 'texto' },
  { id: `${p}_nascimento`, rotulo: 'Data de nascimento',         tipo: 'data' },
  { id: `${p}_filiacao`,   rotulo: 'Filiação (pai e mãe)',       tipo: 'texto' },
  { id: `${p}_estado_civil`, rotulo: 'Estado civil e regime de bens', tipo: 'texto', obrigatorio: true },
  { id: `${p}_conjuge`,    rotulo: 'Cônjuge/companheiro(a) (qualificação)', tipo: 'texto' },
  { id: `${p}_certidao`,   rotulo: 'Certidão de estado civil (matrícula CNJ ou livro/folha)', tipo: 'texto' },
  { id: `${p}_endereco`,   rotulo: 'Endereço completo com CEP',   tipo: 'texto' }
];

const IMOVEL = [
  { id: 'imovel_descricao',  rotulo: 'Descrição literal (ipsis litteris da matrícula)', tipo: 'longo', obrigatorio: true },
  { id: 'imovel_matricula',  rotulo: 'Matrícula nº',              tipo: 'texto', obrigatorio: true },
  { id: 'imovel_oficio',     rotulo: 'Ofício do Registro de Imóveis / comarca', tipo: 'texto' },
  { id: 'imovel_endereco',   rotulo: 'Logradouro, nº/lote/quadra, bairro, cidade/UF, CEP', tipo: 'texto' },
  { id: 'imovel_inscricao',  rotulo: 'Inscrição imobiliária municipal', tipo: 'texto' },
  { id: 'imovel_valor_fiscal', rotulo: 'Valor atribuído pelo fisco (R$)', tipo: 'texto' },
  { id: 'imovel_titulo_anterior', rotulo: 'Título aquisitivo anterior (espécie, R/AV, data)', tipo: 'texto' },
  { id: 'imovel_rural',      rotulo: 'Rural? CCIR, NIRF/ITR, CAR, SIGEF, módulos fiscais', tipo: 'texto' }
];

const PRECO = [
  { id: 'preco_valor',   rotulo: 'Preço (R$)',                              tipo: 'texto', obrigatorio: true },
  { id: 'preco_forma',   rotulo: 'Forma de pagamento (espécie / PIX-TED / parcelado)', tipo: 'texto', obrigatorio: true },
  { id: 'preco_data',    rotulo: 'Data e local do pagamento',               tipo: 'texto' },
  { id: 'preco_conta',   rotulo: 'Banco/agência/conta ou chave PIX e titularidade', tipo: 'texto' }
];

const FISCAL = [
  { id: 'guia_tipo',   rotulo: 'Tributo (ITBI / ITCMD / imunidade)', tipo: 'texto' },
  { id: 'guia_numero', rotulo: 'Guia nº (DAM/DAE)',                  tipo: 'texto' },
  { id: 'guia_valor',  rotulo: 'Valor recolhido (R$)',               tipo: 'texto' },
  { id: 'guia_base',   rotulo: 'Base de cálculo do fisco (R$)',      tipo: 'texto' },
  { id: 'guia_data',   rotulo: 'Data do recolhimento',               tipo: 'data' },
  { id: 'cnib',        rotulo: 'CNIB por transmitente (nome, data, hora, hash, resultado)', tipo: 'longo' }
];

const AGENTES = [
  // ---- os que já tinham Gem própria ----
  { slug: 'compra-venda', nome: 'Compra e Venda', codigo_ato: 'CV', ordem: 10,
    descricao: 'Escritura de compra e venda, urbana e rural. Cobre continuidade registral, partes ideais, ascendente a descendente e cessão anterior.',
    prompt: 'assessor-cv.md', template: 'modulo-10-compra-e-venda.md',
    campos: [...PARTE('vendedor'), ...PARTE('comprador'), ...IMOVEL, ...PRECO, ...FISCAL,
      { id: 'anuentes', rotulo: 'Anuentes (cônjuges, condôminos art. 504, descendentes art. 496)', tipo: 'longo' },
      { id: 'certidoes', rotulo: 'Certidões apresentadas (CND imobiliária, CNDT, forenses) — nº e data', tipo: 'longo' }] },

  { slug: 'cdh', nome: 'Cessão de Direitos Hereditários', codigo_ato: 'CDH', ordem: 20,
    descricao: 'Cessão onerosa de direitos hereditários e meação, inclusive companheira-meeira pelo Tema 809 do STF.',
    prompt: 'assessor-cdh.md', template: 'modulo-03-cdh.md',
    campos: [
      { id: 'autor_heranca', rotulo: 'Autor(a) da herança: nome, estado civil, data do óbito, certidão (matrícula e ofício)', tipo: 'longo', obrigatorio: true },
      { id: 'cedentes', rotulo: 'Cedentes/herdeiros — qualificação completa e qualidade sucessória de cada', tipo: 'longo', obrigatorio: true },
      { id: 'meeiro', rotulo: 'Meeiro(a): casamento ou união estável (livro, folha, data, serventia)', tipo: 'longo' },
      { id: 'representacao', rotulo: 'Representação art. 1.851 (pré-morto, data do óbito, descendentes)', tipo: 'longo' },
      ...PARTE('cessionario'), ...IMOVEL, ...PRECO, ...FISCAL,
      { id: 'rcto_censec', rotulo: 'Resultado RCTO/CENSEC (nº, data, código)', tipo: 'texto' },
      { id: 'inventario', rotulo: 'Inventário: juízo/vara e nº do processo, ou cartório/livro/folha', tipo: 'texto' },
      { id: 'preferencia', rotulo: 'Situação da preferência entre coerdeiros (a/b/c)', tipo: 'texto' }] },

  { slug: 'negocio-misto', nome: 'Negócio Misto (Meação + Herança)', codigo_ato: 'CDH', ordem: 25,
    descricao: 'Módulo 3-B: viúvo(a) vende a fração da meação e os herdeiros cedem a herança, no mesmo ato.',
    prompt: 'assessor-cdh.md', template: 'modulo-03b-negocio-misto.md',
    campos: [
      { id: 'vendedor_meeiro', rotulo: 'Vendedor-meeiro: qualificação completa, viúvo(a) de, regime e data do casamento', tipo: 'longo', obrigatorio: true },
      { id: 'cedentes', rotulo: 'Cedentes/herdeiros — qualificação e fração de cada (por cabeça e por estirpe)', tipo: 'longo', obrigatorio: true },
      { id: 'autor_heranca', rotulo: 'Autor(a) da herança: qualificação, data do óbito, certidão', tipo: 'longo', obrigatorio: true },
      ...PARTE('comprador_cessionario'), ...IMOVEL,
      { id: 'preco_meacao', rotulo: 'Preço da compra e venda da meação (valor, forma, data, conta)', tipo: 'longo', obrigatorio: true },
      { id: 'preco_cessao', rotulo: 'Preço da cessão da herança (valor, forma, data, contas, rateio)', tipo: 'longo', obrigatorio: true },
      { id: 'preco_global', rotulo: 'Valor global do negócio', tipo: 'texto' },
      { id: 'guias_individualizadas', rotulo: 'Guias fiscais individualizadas (órgão, nº, base, valor, data)', tipo: 'longo' },
      { id: 'cnib', rotulo: 'CNIB por pessoa', tipo: 'longo' },
      { id: 'assinatura_rogo', rotulo: 'Assinatura a rogo e testemunhas instrumentárias', tipo: 'longo' }] },

  { slug: 'cdp', nome: 'Cessão de Direitos Possessórios', codigo_ato: 'CDP', ordem: 30,
    descricao: 'Cessão onerosa de posse sobre imóvel não matriculado, com a cadeia possessória elo a elo.',
    prompt: 'assessor-cdp.md', template: 'modulo-05-cdp.md',
    campos: [...PARTE('cedente'), ...PARTE('cessionario'),
      { id: 'imovel_descricao', rotulo: 'Descrição do imóvel não matriculado (tipo, logradouro, zona, medidas, área, confrontações e confrontantes)', tipo: 'longo', obrigatorio: true },
      { id: 'cadeia_possessoria', rotulo: 'Cadeia possessória elo a elo (espécie do título, livro, folha, data, cedente, adquirente)', tipo: 'longo', obrigatorio: true },
      ...PRECO,
      { id: 'guia_itbi', rotulo: 'ITBI municipal (guia nº, valor, data) ou não incidência', tipo: 'texto' },
      { id: 'comprovante_endereco', rotulo: 'Comprovante de endereço/energia apresentado', tipo: 'texto' }] },

  { slug: 'procuracao', nome: 'Procuração Pública', codigo_ato: 'PROC', ordem: 40,
    descricao: 'Definição da seção de poderes conforme a finalidade: venda, bancário, registral, previdenciário, ad judicia.',
    prompt: 'procuracoes.md', template: null,
    campos: [...PARTE('outorgante'), ...PARTE('outorgado'),
      { id: 'finalidade', rotulo: 'Finalidade do mandato (o que o outorgado precisa fazer, em detalhe)', tipo: 'longo', obrigatorio: true },
      { id: 'bem_objeto', rotulo: 'Bem ou objeto específico do mandato', tipo: 'longo' },
      { id: 'prazo', rotulo: 'Prazo de validade', tipo: 'texto' },
      { id: 'substabelecimento', rotulo: 'Permite substabelecimento?', tipo: 'texto' },
      { id: 'clausula_em_causa_propria', rotulo: 'Em causa própria (art. 685 CC)?', tipo: 'texto' }] },

  { slug: 'redator', nome: 'Redator Oficial do 2º Ofício', codigo_ato: null, ordem: 90, categoria: 'comunicacao',
    descricao: 'E-mails a partes e advogados, ofícios a órgãos públicos, avisos de pendência documental e comunicados internos.',
    prompt: 'redator-geral.md', template: null,
    campos: [
      { id: 'tipo', rotulo: 'Tipo (e-mail, ofício, aviso de pendência, comunicado interno)', tipo: 'texto', obrigatorio: true },
      { id: 'destinatario', rotulo: 'Destinatário (nome, cargo, órgão)', tipo: 'texto', obrigatorio: true },
      { id: 'assunto', rotulo: 'Assunto', tipo: 'texto', obrigatorio: true },
      { id: 'protocolo', rotulo: 'Protocolo do ato, se houver', tipo: 'texto' },
      { id: 'conteudo', rotulo: 'O que precisa ser dito', tipo: 'longo', obrigatorio: true },
      { id: 'prazo', rotulo: 'Prazo ou providência pedida', tipo: 'texto' }] },

  { slug: 'qualificacao-imovel', nome: 'Qualificação do Imóvel', codigo_ato: null, ordem: 5, categoria: 'ferramenta',
    descricao: 'Matrícula e documentos fiscais entram; sai a qualificação em parágrafo único, a tabela do sistema e os alertas. Use antes de montar qualquer ato.',
    prompt: 'not-extrator.md', template: null,
    campos: [
      { id: 'observacoes_caso', rotulo: 'Instruções pontuais para este caso', tipo: 'longo' }] },

  { slug: 'certidoes', nome: 'Extração de Certidões', codigo_ato: null, ordem: 6, categoria: 'ferramenta',
    descricao: 'Lê as certidões apresentadas e devolve os dados prontos para colar na escritura.',
    prompt: 'copia-cola-certidoes.md', template: null, campos: [] },

  // ---- atos que tinham template no Drive mas ainda não tinham Gem ----
  { slug: 'doacao', nome: 'Doação', codigo_ato: 'DOA', ordem: 50,
    descricao: 'Doação de imóvel, com usufruto, cláusulas restritivas, colação, reversão e encargo.',
    prompt: null, template: 'modulo-01-doacao.md',
    campos: [...PARTE('doador'), ...PARTE('donatario'), ...IMOVEL,
      { id: 'usufruto', rotulo: 'Usufruto (vitalício/temporário, prazo) ou nu-propriedade', tipo: 'texto' },
      { id: 'clausulas_restritivas', rotulo: 'Inalienabilidade / impenhorabilidade / incomunicabilidade + justa causa', tipo: 'longo' },
      { id: 'colacao', rotulo: 'Colação: determinar ou dispensar', tipo: 'texto' },
      { id: 'reversao', rotulo: 'Cláusula de reversão', tipo: 'texto' },
      { id: 'encargo', rotulo: 'Encargo/modo (obrigação, prazo, consequência)', tipo: 'longo' },
      { id: 'avaliacao_sefaz', rotulo: 'Valor da avaliação SEFAZ/SE', tipo: 'texto' }, ...FISCAL] },

  { slug: 'dacao', nome: 'Dação em Pagamento', codigo_ato: 'DAC', ordem: 55,
    descricao: 'Transmissão de bem em pagamento de dívida, com quitação integral, parcial ou torna.',
    prompt: null, template: 'modulo-02-dacao-em-pagamento.md',
    campos: [...PARTE('devedor'), ...PARTE('credor'), ...IMOVEL,
      { id: 'obrigacao', rotulo: 'Obrigação preexistente (origem/título, natureza, valor atualizado, vencimento)', tipo: 'longo', obrigatorio: true },
      { id: 'valor_bem', rotulo: 'Valor atribuído ao bem dado em pagamento', tipo: 'texto', obrigatorio: true },
      { id: 'hipotese_quitacao', rotulo: 'Quitação integral / parcial com saldo / torna com diferença (forma e prazo)', tipo: 'longo', obrigatorio: true },
      ...FISCAL] },

  { slug: 'inventario', nome: 'Inventário e Partilha', codigo_ato: 'INV', ordem: 60,
    descricao: 'Inventário e partilha ou adjudicação extrajudicial, com meação, quinhões, tornas e cessão anterior.',
    prompt: null, template: 'modulo-06-inventario-partilha.md',
    campos: [
      { id: 'autor_heranca', rotulo: 'Autor(a) da herança: qualificação, regime, último domicílio, data e local do óbito, certidão', tipo: 'longo', obrigatorio: true },
      { id: 'meeiro', rotulo: 'Meeiro(a): qualificação e regime', tipo: 'longo' },
      { id: 'herdeiros', rotulo: 'Herdeiros: qualificação numerada, parentesco e vocação', tipo: 'longo', obrigatorio: true },
      { id: 'inventariante', rotulo: 'Inventariante', tipo: 'texto' },
      { id: 'advogado', rotulo: 'Advogado assistente (nome, OAB/UF)', tipo: 'texto', obrigatorio: true },
      { id: 'acervo', rotulo: 'Acervo: imóveis (matrícula, ofício, descrição, valor), veículos, contas, semoventes, outros', tipo: 'longo', obrigatorio: true },
      { id: 'passivo', rotulo: 'Passivo (credor, natureza, valor, forma)', tipo: 'longo' },
      { id: 'partilha', rotulo: 'Monte-mor, meação, monte partível e quinhão de cada herdeiro', tipo: 'longo', obrigatorio: true },
      { id: 'torna', rotulo: 'Torna/reposição (valor e tributo)', tipo: 'texto' },
      { id: 'cessao_anterior', rotulo: 'Cessão anterior (serventia, data, livro, folhas, preço) e ITBI da cessão', tipo: 'longo' },
      { id: 'rcto_censec', rotulo: 'RCTO/CENSEC (nº, data, código) e testamento', tipo: 'texto' },
      { id: 'itcmd', rotulo: 'ITCMD (guia/DAE, valor, base, alíquota, data, isenção)', tipo: 'texto' },
      { id: 'certidoes', rotulo: 'Certidões federal, estadual, municipal e CNDT (nº, data, validade)', tipo: 'longo' }] },

  { slug: 'divorcio', nome: 'Divórcio Consensual', codigo_ato: 'DIV', ordem: 65,
    descricao: 'Divórcio consensual parametrizado: partilha (sem/diferida/com), alimentos, uso do nome e formalização presencial, e-Notariado ou híbrida.',
    prompt: null, template: 'divorcio-parametrizado.md',
    campos: [...PARTE('primeiro_conjuge'), ...PARTE('segundo_conjuge'),
      { id: 'advogado', rotulo: 'Advogado(a) (nome, OAB/UF, endereço profissional, e-mail)', tipo: 'texto', obrigatorio: true },
      { id: 'casamento', rotulo: 'Casamento: data, regime, matrícula do assento, RCPN', tipo: 'longo', obrigatorio: true },
      { id: 'pacto_antenupcial', rotulo: 'Pacto antenupcial (data, livro, folhas, tabelionato, registro)', tipo: 'texto' },
      { id: 'filhos', rotulo: 'Filhos: maiores capazes (3-A) / menores com decisão judicial (3-B) / não há (3-C)', tipo: 'longo', obrigatorio: true },
      { id: 'separacao_fato', rotulo: 'Data da separação de fato', tipo: 'texto' },
      { id: 'nome', rotulo: 'Uso do nome após o divórcio (cada cônjuge)', tipo: 'texto', obrigatorio: true },
      { id: 'partilha', rotulo: 'Partilha: 8-A sem bens / 8-B diferida / 8-C com bens — descrever patrimônio, meações e atribuição', tipo: 'longo', obrigatorio: true },
      { id: 'dividas', rotulo: 'Dívidas', tipo: 'longo' },
      { id: 'alimentos', rotulo: 'Alimentos: 10-A dispensa / 10-B valor mensal / 10-C percentual — valor, dia, forma, prazo, índice', tipo: 'longo', obrigatorio: true },
      { id: 'tributos', rotulo: 'ITCMD/ITBI sobre excesso de meação (guia, valor)', tipo: 'texto' },
      { id: 'formalizacao', rotulo: '15-A presencial / 15-B e-Notariado / 15-C híbrida', tipo: 'texto' }] },

  { slug: 'uniao-estavel', nome: 'União Estável', codigo_ato: 'UE', ordem: 70,
    descricao: 'Escritura declaratória de reconhecimento de união estável, com pacto de convivência e regime de bens.',
    prompt: null, template: 'uniao-estavel.md',
    campos: [...PARTE('declarante1'), ...PARTE('declarante2'),
      { id: 'endereco_comum', rotulo: 'Endereço comum completo', tipo: 'texto', obrigatorio: true },
      { id: 'inicio_uniao', rotulo: 'Data de início da união (desta data ou pretérita, por extenso)', tipo: 'texto', obrigatorio: true },
      { id: 'regime', rotulo: 'Regime de bens escolhido', tipo: 'texto', obrigatorio: true },
      { id: 'adaptacao_estado_civil', rotulo: 'Divorciado/viúvo/separado de fato + certidões', tipo: 'longo' },
      { id: 'contrato_anterior', rotulo: 'Contrato de convivência anterior', tipo: 'texto' },
      { id: 'nome', rotulo: 'Nomes para a cláusula do nome', tipo: 'texto' }] },

  { slug: 'testamento', nome: 'Testamento Público', codigo_ato: 'TEST', ordem: 75,
    descricao: 'Testamento público com disposições, substituição, deserdação, testamenteiro e duas testemunhas.',
    prompt: null, template: 'modulo-08-testamento.md',
    campos: [...PARTE('testador'),
      { id: 'herdeiros_necessarios', rotulo: 'Herdeiros necessários (nomes)', tipo: 'longo', obrigatorio: true },
      { id: 'disposicoes', rotulo: 'Disposições testamentárias: herdeiros e legatários qualificados, bens, quotas, frações, legados, condições e encargos', tipo: 'longo', obrigatorio: true },
      { id: 'revogacao', rotulo: 'Revogação de testamentos anteriores', tipo: 'texto' },
      { id: 'substituicao', rotulo: 'Substituição vulgar ou fideicomissária (substituto)', tipo: 'longo' },
      { id: 'deserdacao', rotulo: 'Deserdação (herdeiro e causa legal)', tipo: 'longo' },
      { id: 'reconhecimento_filho', rotulo: 'Reconhecimento de filho', tipo: 'texto' },
      { id: 'testamenteiro', rotulo: 'Testamenteiro: qualificação, prêmio/vintena, poderes, prazos', tipo: 'longo' },
      { id: 'testemunhas', rotulo: '1ª e 2ª testemunhas — qualificação completa', tipo: 'longo', obrigatorio: true }] },

  { slug: 'ata-usucapiao', nome: 'Ata Notarial de Posse (Usucapião)', codigo_ato: 'ATA-U', ordem: 80,
    descricao: 'Ata notarial de posse para usucapião extrajudicial, com cadeia possessória, confrontantes e diligência in loco.',
    prompt: null, template: 'modulo-04-ata-posse-usucapiao.md',
    campos: [...PARTE('requerente'),
      { id: 'advogado', rotulo: 'Advogado(a) (nome, OAB/UF, sociedade, sede, e-mail)', tipo: 'texto', obrigatorio: true },
      { id: 'modalidade', rotulo: 'Modalidade de usucapião', tipo: 'texto', obrigatorio: true },
      { id: 'imovel', rotulo: 'Imóvel usucapiendo: natureza, endereço, áreas, confrontações e medidas por rumo, confrontantes', tipo: 'longo', obrigatorio: true },
      { id: 'matricula_mae', rotulo: 'Matrícula-mãe: nº, CNM, ofício, descrição, titular registral, cadeia dominial, ônus', tipo: 'longo' },
      { id: 'cadeia_possessoria', rotulo: 'Cadeia possessória por elo (data, transmitente, adquirente, instrumento, área, valor)', tipo: 'longo', obrigatorio: true },
      { id: 'posse', rotulo: 'Início da posse, forma de aquisição, prazo decorrido, data do implemento', tipo: 'longo', obrigatorio: true },
      { id: 'benfeitorias', rotulo: 'Benfeitorias, destinação e uso', tipo: 'longo' },
      { id: 'tributos_consumo', rotulo: 'IPTU/ITR, unidade consumidora, água, DAM/TLF e outros indícios', tipo: 'longo' },
      { id: 'responsavel_tecnico', rotulo: 'Responsável técnico (CREA/CAU/CFT) e ART/RRT nº', tipo: 'texto' },
      { id: 'confrontantes', rotulo: 'Confrontantes (nome, CPF/CNPJ, endereço, rumo) e anuências', tipo: 'longo' },
      { id: 'diligencia', rotulo: 'Diligência in loco (data, hora, descrição)', tipo: 'longo' },
      { id: 'cnib', rotulo: 'CNIB e CENSEC (resultado, protocolo, hash)', tipo: 'longo' }] },

  { slug: 'ata-digital', nome: 'Ata de Constatação Digital', codigo_ato: 'ATA-W', ordem: 85,
    descricao: 'Ata notarial de constatação em meio digital: WhatsApp, áudios, páginas e documentos eletrônicos, com hash SHA-256 e cadeia de custódia.',
    prompt: null, template: 'modulo-09-ata-constatacao-digital.md',
    campos: [...PARTE('requerente'),
      { id: 'natureza', rotulo: 'Natureza do conteúdo (WhatsApp / áudios / páginas / documentos eletrônicos)', tipo: 'texto', obrigatorio: true },
      { id: 'variante', rotulo: 'Variante da diligência (A/B/C)', tipo: 'texto' },
      { id: 'aparelho', rotulo: 'Aparelho: marca, modelo, cor, IMEI, SO, aplicativo e versão, linha +55, desbloqueio', tipo: 'longo', obrigatorio: true },
      { id: 'diligencia', rotulo: 'Local, dia, hora de início e de encerramento, presentes, meio de espelhamento', tipo: 'longo', obrigatorio: true },
      { id: 'conversas', rotulo: 'Por conversa: nome no cabeçalho, número exibido, nome do arquivo', tipo: 'longo' },
      { id: 'trechos', rotulo: 'Por trecho: data com dia da semana, horário, remetente, tipo, duração, teor literal', tipo: 'longo', obrigatorio: true },
      { id: 'hashes', rotulo: 'Hash SHA-256 por arquivo e ID de custódia', tipo: 'longo', obrigatorio: true },
      { id: 'declaracoes', rotulo: 'Declarações do requerente (título do conteúdo, contexto)', tipo: 'longo' }] },

  { slug: 'laje', nome: 'Direito Real de Laje', codigo_ato: 'LAJE', ordem: 88,
    descricao: 'Instituição de direito real de laje com extinção de condomínio e atribuição de propriedade exclusiva (art. 1.510-A CC).',
    prompt: null, template: 'laje-direito-real.md',
    campos: [...PARTE('instituidor1'), ...PARTE('instituidor2'),
      { id: 'percentuais', rotulo: 'Percentual de copropriedade de cada (% + extenso)', tipo: 'texto', obrigatorio: true },
      { id: 'imovel_base', rotulo: 'Imóvel-base: descrição, endereço, área do terreno, área construída, matrícula, cartório', tipo: 'longo', obrigatorio: true },
      { id: 'construcao_base', rotulo: 'Construção-base: descrição, inscrição, áreas, cômodos, confrontações', tipo: 'longo', obrigatorio: true },
      { id: 'unidade_laje', rotulo: 'Unidade de laje: pavimentos, endereço, inscrição, área, acesso, cômodos, servidões', tipo: 'longo', obrigatorio: true },
      { id: 'modalidade', rotulo: 'Modalidade (causa própria / favor de terceiro / posterior atribuição)', tipo: 'texto' },
      { id: 'equivalencia', rotulo: 'Equivalência de valores: % da construção-base e % da laje, com extenso e fonte', tipo: 'longo', obrigatorio: true },
      { id: 'torna', rotulo: 'Torna (valor e forma de pagamento)', tipo: 'texto' },
      { id: 'convivencia', rotulo: 'Regras de convivência (acesso, áreas comuns, servidões, manutenção e despesas)', tipo: 'longo' },
      { id: 'responsavel_tecnico', rotulo: 'Responsável técnico (CAU/CREA, RRT/ART) e alvará municipal', tipo: 'texto' },
      ...FISCAL] }
];

(async () => {
  const alvo = process.argv[2];
  await dba.init();
  let ok = 0, pulados = 0;

  for (const d of AGENTES) {
    if (alvo && d.slug !== alvo) continue;
    console.log(`\n→ ${d.slug} — ${d.nome}`);

    const proprio = d.prompt ? lerPrompt(d.prompt) : null;
    const template = d.template ? lerTemplate(d.template) : null;

    if (d.prompt && !proprio) { console.warn('  ! prompt ausente, pulando'); pulados++; continue; }
    if (d.template && !template) { console.warn('  ! template ausente, pulando'); pulados++; continue; }

    const prompt_sistema = proprio || BASE;

    await dba.salvarAgente({
      slug: d.slug, nome: d.nome, descricao: d.descricao,
      categoria: d.categoria || 'escritura', codigo_ato: d.codigo_ato,
      ordem: d.ordem, prompt_sistema, template, campos: d.campos || [], ativo: true
    }, 'seed');

    console.log(`  prompt ${prompt_sistema.length} car.${template ? ` · template ${template.length} car.` : ' · sem template'} · ${(d.campos || []).length} campos`);
    ok++;
  }

  console.log(`\n${ok} agente(s) gravado(s)${pulados ? `, ${pulados} pulado(s)` : ''}.`);
  process.exit(0);
})().catch(e => { console.error('seed falhou:', e.message); process.exit(1); });
