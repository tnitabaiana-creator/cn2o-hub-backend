// EnviarRelatorio.gs — web app que envia os relatórios das escreventes pelo Gmail da
// serventia. O hub (relatorio-email.js) faz um POST com o segredo no corpo.
//
// Instalação (uma vez, logado na conta Google do cartório):
//   1. script.google.com → Novo projeto → colar este arquivo.
//   2. Configurações do projeto → Propriedades do script:
//        SEGREDO       = <um texto longo e aleatório>
//        DESTINATARIOS = e-mails que podem receber, separados por vírgula (v1.39.4) — os
//                        mesmos de RELATORIO_EMAIL_PARA e o de homologação. Sem ela, nada sai.
//   3. Implantar → Nova implantação → Tipo "App da Web":
//        Executar como: Eu  ·  Quem pode acessar: Qualquer pessoa
//      Autorizar o envio de e-mail quando o Google pedir.
//   4. Na Railway: RELATORIO_EMAIL_WEBAPP_URL = a URL que termina em /exec
//                  RELATORIO_EMAIL_SECRET     = o mesmo SEGREDO do passo 2
// Cota do Gmail comum: 100 destinatários por dia — sobra para 1 relatório por semana.
//
// Contrato (versao 1): { segredo, versao, para[], assunto, html, texto, remetente,
//                        anexos: [{ nome, tipo, base64 }] } → { ok, cota? } | { ok:false, erro }

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    var segredo = PropertiesService.getScriptProperties().getProperty('SEGREDO');
    if (!segredo || d.segredo !== segredo) return responder({ ok: false, erro: 'não autorizado' });
    if (d.versao !== 1) return responder({ ok: false, erro: 'versão de contrato desconhecida' });
    if (!d.para || !d.para.length || !d.assunto || !d.html) return responder({ ok: false, erro: 'pedido incompleto' });
    // v1.39.4 (segurança): mesmo com o segredo, o script só manda para a lista da casa —
    // um segredo vazado não transforma o Gmail do cartório em disparador para qualquer um
    var permitidos = String(PropertiesService.getScriptProperties().getProperty('DESTINATARIOS') || '')
      .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(String);
    if (!permitidos.length) return responder({ ok: false, erro: 'falta a propriedade DESTINATARIOS no script' });
    var fora = d.para.filter(function (x) { return permitidos.indexOf(String(x).trim().toLowerCase()) === -1; });
    if (fora.length) return responder({ ok: false, erro: 'destinatário fora da lista DESTINATARIOS do script' });
    var anexos = (d.anexos || []).map(function (a) {
      return Utilities.newBlob(Utilities.base64Decode(a.base64), a.tipo || 'application/octet-stream', a.nome);
    });
    MailApp.sendEmail({
      to: d.para.join(','),
      subject: d.assunto,
      htmlBody: d.html,
      body: d.texto || '',
      name: d.remetente || 'CN2O · Relatórios',
      attachments: anexos
    });
    return responder({ ok: true, cota: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return responder({ ok: false, erro: String((err && err.message) || err) });
  }
}

function responder(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
