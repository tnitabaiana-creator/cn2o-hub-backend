'use strict';
const f = require('./protocolo-fonte');
function instrucaoSaida() {
  return f.REGRA_FONTE + '\nFORMATO EXTERNO obrigatório nesta integração: responda somente JSON {"texto":"resultado integral no formato interno exigido pelo agente", "decisoes":[]}.' +
    '\nO conteúdo de texto preserva os marcadores e a minuta do agente. A matriz fica fora dele. ' + f.FORMATO_DECISOES;
}
function lerResultado(texto) {
  let r;
  try { r = JSON.parse(String(texto).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch (_) { throw f.falha(502, 'CONFERENCIA_INVALIDA', 'A IA não devolveu a minuta com a conferência estruturada da fonte. Refaça a geração.'); }
  if (!r || typeof r.texto !== 'string' || !r.texto.trim() || !Array.isArray(r.decisoes))
    throw f.falha(502, 'CONFERENCIA_INVALIDA', 'A IA não devolveu texto e conferência válidos.');
  return r;
}
function conferirResultado(fonte, resposta, manifestos) {
  if (!fonte) return { texto: resposta.texto, conferencia: [] };
  const r = lerResultado(resposta.texto);
  const conferencia = f.matrizCobertura(fonte, r.decisoes, manifestos, r.texto);
  let texto = r.texto;
  const inicio = texto.indexOf('===MINUTA_COPIAVEL===');
  if (inicio >= 0 && conferencia.some(c => c.revisao_humana)) {
    // Rebaixa somente a decisão externa, nunca insere comentários na escritura.
    const cabecalho = texto.slice(0, inicio).replace(/(^[ \t]*(?:-[ \t]*)?Estado:[ \t]*)(PRONTA|READY)[ \t]*$/gim, '$1PRELIMINAR');
    texto = cabecalho + texto.slice(inicio);
  }
  return { texto, conferencia };
}
function resumo(fonte, matriz) {
  if (!fonte) return { fonte_protocolo: null, conferencia_fonte: [], fonte_status: 'sem_protocolo' };
  return { fonte_protocolo: { numero: fonte.protocolo.numero, sha256: fonte.revisao.sha256 }, conferencia_fonte: matriz,
    fonte_status: matriz.some(c => c.revisao_humana) ? 'requer_conferencia' : 'conferir_antes_de_lavrar' };
}
module.exports = { instrucaoSaida, lerResultado, conferirResultado, resumo };
