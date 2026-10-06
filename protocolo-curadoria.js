/* CURADORIA_REGRAS_INICIO — regras puras compartilhadas com os testes */
const CN2OCuradoria = (()=>{
  const estados=['compativeis','sem_comprovante','nao_conferidos','divergentes'];
  const formas=['especie','pix','transferencia','deposito','cheque','outro'];
  const atosPagamento=['CV-Urbano','CV-Rural','CDP','CDH','PER','DIV','DUE'];
  const atosPreco=['CV-Urbano','CV-Rural','CDP','CDH'];
  function centavos(valor){
    if(typeof valor==='number') return Number.isSafeInteger(valor) && valor>0 ? valor : null;
    let t=String(valor||'').trim().replace(/^R\$\s*/i,'').replace(/\s/g,'');
    if(!t || !/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(t)) return null;
    const [inteiro,decimal='']=t.split(',');
    const n=Number(inteiro.replace(/\./g,''))*100+Number(decimal.padEnd(2,'0'));
    return Number.isSafeInteger(n) && n>0 && n<100000000000000 ? n : null;
  }
  const txt=v=>String(v||'').trim();
  function normalizarPagamentos(linhas){
    return (linhas||[]).map(p=>({
      valor_centavos:centavos(p.valor_centavos!==undefined ? p.valor_centavos : p.valor),
      forma:txt(p.forma),forma_detalhe:txt(p.forma_detalhe),data:txt(p.data),status:txt(p.status),
      pagador:txt(p.pagador),beneficiario:txt(p.beneficiario),comprovante_referencia:txt(p.comprovante_referencia)
    }));
  }
  function avaliar({ato,triagem={},pagamentos=[],curadoria={}}){
    const parcelas=normalizarPagamentos(pagamentos), erros=[], alertas=[];
    if(parcelas.length>100) erros.push('Registre no máximo 100 parcelas por protocolo.');
    if((curadoria.divergencias||[]).length>60) erros.push('Registre no máximo 60 divergências por conferência.');
    if(!estados.includes(curadoria.estado)) erros.push('Selecione a situação real da conferência.');
    if(curadoria.confirmado!==true) erros.push('Confirme expressamente a situação registrada antes de protocolizar.');
    parcelas.forEach((p,i)=>{
      const prefixo='Parcela '+(i+1)+': ';
      if(p.valor_centavos===null) erros.push(prefixo+'informe um valor positivo com até duas casas decimais.');
      if(!formas.includes(p.forma)) erros.push(prefixo+'selecione a forma de pagamento.');
      if(!['realizado','previsto'].includes(p.status)) erros.push(prefixo+'informe se foi realizado ou se está previsto.');
      if(p.forma==='outro' && !p.forma_detalhe) erros.push(prefixo+'descreva a outra forma de pagamento.');
      if(p.data && (!/^\d{4}-\d{2}-\d{2}$/.test(p.data) || Number.isNaN(Date.parse(p.data)) || new Date(p.data).toISOString().slice(0,10)!==p.data)) erros.push(prefixo+'informe uma data válida.');
      if(!p.data || !p.pagador || !p.beneficiario) alertas.push(prefixo+'há dados não informados (data, pagador ou beneficiário); não serão presumidos.');
      if(p.status==='realizado' && p.forma!=='especie' && !p.comprovante_referencia) alertas.push(prefixo+'pagamento declarado sem referência de comprovante; o registro não demonstra sua realização.');
    });
    const especie=Object.keys(triagem).some(k=>/^pag_.*forma$/.test(k) && /espécie/i.test(String(triagem[k]))) || parcelas.some(p=>p.forma==='especie');
    if(especie) alertas.unshift('Pagamento em espécie informado. Confira valor, data e destinatário: existe depósito, PIX, transferência ou cheque relativo ao mesmo pagamento? Se existir contraposição, registre a divergência; um comprovante de outro negócio não substitui esta declaração.');
    const momento=String(triagem.pag_momento||'');
    const legados = /Já pago integralmente/.test(momento) ? {realizado:triagem.pag_ant_forma} : /Integralmente no ato/.test(momento) ? {previsto:triagem.pag_ato_forma} : /Misto/.test(momento) ? {realizado:triagem.pag_m_antes_forma,previsto:triagem.pag_m_ato_forma} : {};
    function aceitaForma(legado,forma){
      const t=String(legado||'');
      if(/espécie/i.test(t)) return forma==='especie';
      if(/cheque/i.test(t)) return forma==='cheque';
      if(/transferência|depósito|PIX/i.test(t)) return ['pix','transferencia','deposito'].includes(forma);
      return true;
    }
    const contradicaoLegado=parcelas.some(p=>legados[p.status] && formas.includes(p.forma) && !aceitaForma(legados[p.status],p.forma));
    const contradicaoMomento=parcelas.some(p=>(/Já pago integralmente/.test(momento) && p.status==='previsto') || (/^Integralmente no ato/.test(momento) && p.status==='realizado'));
    if(contradicaoLegado||contradicaoMomento){
      alertas.push('As parcelas e a triagem apresentam formas ou momentos de pagamento diferentes. Confira a declaração original e os documentos do mesmo negócio; corrija os campos ou registre a divergência/pendência.');
      if(['compativeis','sem_comprovante'].includes(curadoria.estado)) erros.push('A oposição entre parcelas e triagem precisa ser registrada como conferência pendente ou divergência.');
    }
    const preco=atosPreco.includes(ato) ? centavos(triagem.preco) : null;
    const soma=parcelas.length && parcelas.every(p=>p.valor_centavos!==null) ? parcelas.reduce((v,p)=>v+p.valor_centavos,0) : null;
    const somaDiverge=preco!==null && soma!==null && preco!==soma;
    if(somaDiverge){
      alertas.push('A soma das parcelas difere do preço informado na triagem. Complete as parcelas, corrija os dados ou registre a pendência/divergência.');
      if(['compativeis','sem_comprovante'].includes(curadoria.estado)) erros.push('A diferença entre preço e parcelas precisa ser registrada como conferência pendente ou divergência.');
    }
    if(atosPreco.includes(ato) && !parcelas.length) alertas.push('Sem parcelas discriminadas: as respostas da triagem serão preservadas, e detalhes ausentes continuarão pendentes.');
    if(curadoria.estado==='divergentes'){
      if(!(curadoria.divergencias||[]).length) erros.push('Identifique pelo menos uma divergência.');
      (curadoria.divergencias||[]).forEach((d,i)=>{
        if(!txt(d.fato)||!txt(d.documento)||!txt(d.descricao)) erros.push('Divergência '+(i+1)+': preencha fato, referência do documento/fonte e explicação.');
      });
    }
    return {ok:!erros.length,erros,alertas,soma_centavos:soma,preco_centavos:preco};
  }
  return {centavos,normalizarPagamentos,avaliar,atosPagamento,estados};
})();
/* CURADORIA_REGRAS_FIM */
if(typeof module!=='undefined' && module.exports) module.exports=CN2OCuradoria;
