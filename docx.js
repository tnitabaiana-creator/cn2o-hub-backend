// docx.js — gera o arquivo do Word a partir do texto da minuta.
//
// Escolha deliberada: ZERO dependências. O arquivo sai como HTML no dialeto
// que o Word entende desde o Office 2000 (Content-Type application/msword,
// extensão .doc). Word, LibreOffice e Google Docs abrem preservando fonte,
// margens, justificação e entrelinha. No Word, "Salvar como .docx" converte
// em um clique.
//
// Por que não a biblioteca `docx` do npm: acrescentaria a primeira dependência
// pesada do projeto e um ponto de falha no build do Railway, para ganhar
// exatamente nada no fluxo real da serventia — a minuta é aberta, conferida e
// levada para o livro. Se um dia o .docx nativo virar requisito (macro,
// automação, campos de mesclagem), troque só este arquivo.

function escapar(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Linhas em CAIXA ALTA curtas viram título centralizado; o resto é parágrafo
// justificado com recuo de primeira linha, como manda a praxe notarial.
function paragrafos(texto) {
  const linhas = String(texto || '').split(/\r?\n/);
  const out = [];
  for (const bruta of linhas) {
    const l = bruta.trim();
    if (!l) { out.push('<p class=vazio>&nbsp;</p>'); continue; }
    const semAcento = l.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const ehTitulo = l.length <= 90 && semAcento === semAcento.toUpperCase() && /[A-Z]/.test(semAcento);
    out.push(ehTitulo ? `<p class=titulo>${escapar(l)}</p>` : `<p class=corpo>${escapar(l)}</p>`);
  }
  return out.join('\n');
}

function gerar({ texto, titulo, protocolo, agente, escrevente, data }) {
  const quando = data || new Date().toLocaleDateString('pt-BR');
  const cabecalho = [
    'CARTÓRIO DE NOTAS DO 2º OFÍCIO — ITABAIANA/SE',
    titulo || 'Minuta',
    [protocolo ? `Protocolo ${protocolo}` : null, agente || null, escrevente || null, quando]
      .filter(Boolean).join(' · ')
  ];

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapar(titulo || 'Minuta CN2O')}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
@page { size: 21cm 29.7cm; margin: 3cm 2cm 2cm 3cm; }
body   { font-family: "Times New Roman", serif; font-size: 12pt; line-height: 1.5; }
p.corpo  { text-align: justify; text-indent: 1.25cm; margin: 0 0 6pt 0; }
p.titulo { text-align: center; font-weight: bold; margin: 12pt 0 8pt 0; text-indent: 0; }
p.vazio  { margin: 0; font-size: 6pt; }
.cab     { text-align: center; margin-bottom: 18pt; }
.cab .a  { font-size: 11pt; font-weight: bold; letter-spacing: .04em; }
.cab .b  { font-size: 13pt; font-weight: bold; margin-top: 4pt; }
.cab .c  { font-size: 9pt; color: #444; margin-top: 4pt; }
hr       { border: 0; border-top: 1px solid #888; margin: 10pt 0 16pt 0; }
</style>
</head>
<body>
<div class=cab>
  <div class=a>${escapar(cabecalho[0])}</div>
  <div class=b>${escapar(cabecalho[1])}</div>
  <div class=c>${escapar(cabecalho[2])}</div>
</div>
<hr>
${paragrafos(texto)}
</body></html>`;
}

// Nome de arquivo seguro para o header Content-Disposition.
function nomeArquivo({ protocolo, agente, titulo }) {
  const base = [protocolo ? `Prot-${protocolo}` : null, agente || 'minuta', titulo || null]
    .filter(Boolean).join('_')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_\-]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 90);
  return `${base || 'minuta'}.doc`;
}

module.exports = { gerar, nomeArquivo };
