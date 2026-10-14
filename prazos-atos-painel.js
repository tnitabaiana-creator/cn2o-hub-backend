'use strict';
const M = require('./prazos-atos-modelo');
const cal = require('./horas-uteis');
function resolverResponsavel(board, lista, usuarios, escreventes, anterior = null) {
  const e = escreventes.find(x=>x.board_id === board && x.ativo !== false);
  let candidatos = [];
  if (e) candidatos = usuarios.filter(u=>u.login === e.login || M.normalizar(u.nome) === M.normalizar(e.nome));
  else if (/^escrevente\s/.test(M.normalizar(lista))) {
    const nome = M.normalizar(lista).replace(/^escrevente\s+/, '');
    candidatos = usuarios.filter(u=>M.normalizar(u.nome) === nome);
  }
  const unicos = [...new Set(candidatos.map(u=>u.login))];
  if (unicos.length > 1) return null; // Ambiguidade precisa de correção cadastral, não de palpite.
  return unicos[0] || (usuarios.some(u=>u.login === anterior) ? anterior : null);
}
function item(row, agora = new Date()) {
  const estado = { ...row, inicio:new Date(row.inicio).toISOString(), vencimento:new Date(row.vencimento).toISOString() };
  const s = M.situacao(estado,agora);
  const marco = M.avisoDoDia(estado.vencimento,agora);
  return { relogio:'ato',card_id:row.card_id, protocolo:row.protocolo, ato:row.regra.ato,
    responsavel:row.responsavel_login, inicio:estado.inicio, vencimento:estado.vencimento,
    dia:cal.local(estado.vencimento).data, cor:s.cor, texto:s.texto,
    aviso:marco, marcos:M.marcos(estado.vencimento),
    trello_url:row.card_url || null, confirmado_em:row.confirmado_em || null, sincronizacao_pendente:!!row.erro };
}
function setorItem(row, agora = new Date()) {
  const inicio = row.detalhes?.inicio;
  if (!inicio || row.detalhes?.marco_inicial !== 'cadastro_extradigital') return null;
  const horas=cal.horasUteis(inicio,agora),prazo=cal.somarHorasUteis(inicio,8).toISOString();
  const aviso=horas>=8?'vencido':horas>=7?'uma_hora':horas>=6?'duas_horas':null;
  const restante=Math.max(0,Math.ceil((8-horas)*60)),tempo=String(Math.floor(restante/60)).padStart(2,'0')+'h'+String(restante%60).padStart(2,'0');
  return { relogio:'setor',card_id:row.card_id,protocolo:row.protocolo,ato:'Setor · 8h úteis',
    responsavel:row.responsavel_login||null,inicio:new Date(inicio).toISOString(),vencimento:prazo,dia:cal.local(prazo).data,
    cor:horas>=8?'vermelho':horas>=6?'amarelo':'verde',texto:horas>=8?'🔴 Limite de 8h úteis atingido':(horas>=6?'🟡 ':'🟢 ')+tempo+' úteis restantes',aviso,
    marcos:[6,7,8].map((h,i)=>{const instante=cal.somarHorasUteis(inicio,h),l=cal.local(instante);return {dia:l.data,hora:String(Math.floor(l.minutos/60)).padStart(2,'0')+':'+String(l.minutos%60).padStart(2,'0'),tipo:['duas_horas','uma_hora','hoje'][i],rotulo:['Setor: faltam 2h úteis','Setor: falta 1h útil','Setor: limite de 8h úteis'][i]};}),
    trello_url:row.card_url||null,confirmado_em:row.confirmado_em,sincronizacao_pendente:!!row.erro };
}
function criarConsulta({ pool, agora = ()=>new Date() }) {
  return async function consultar(usuario, admin = false) {
    if (!usuario?.login) throw Object.assign(Error('sessao_obrigatoria'),{status:401});
    const r = await pool.query(`SELECT card_id,protocolo,inicio,vencimento,regra,responsavel_login,
      card_url,confirmado_em,erro FROM prazos_atos WHERE estado IN ('ativo','assinatura')
      AND ($2::boolean OR responsavel_login=$1) ORDER BY vencimento,protocolo LIMIT 2001`,[usuario.login,admin === true]);
    const itens = r.rows.slice(0,2000).map(x=>item(x,agora()));
    let setores=[];
    try {
      const rs=await pool.query(`SELECT r.card_id,r.prazo,r.detalhes,r.confirmado_em,r.erro,p.numero AS protocolo,
        a.responsavel_login,a.card_url FROM relogio_setor r LEFT JOIN protocolos p ON p.card_id=r.card_id
        LEFT JOIN prazos_atos a ON a.card_id=r.card_id WHERE r.ativo AND r.estado='em_andamento'
        AND ($2::boolean OR a.responsavel_login=$1 OR $3::boolean)`,[usuario.login,admin===true,
        String(process.env.PRAZOS_SETOR_LOGINS||'milvo.neto').split(',').map(x=>x.trim()).includes(usuario.login)]);
      setores=rs.rows.map(x=>setorItem(x,agora())).filter(Boolean);
    } catch(e) { if(e.code!=='42P01')throw e; }
    itens.push(...setores);itens.sort((a,b)=>Date.parse(a.vencimento)-Date.parse(b.vencimento));
    const resumo = { atrasados:0,hoje:0,vespera:0,dois_dias:0,demais:0,sem_responsavel:0,setor_alerta:0,setor_total:setores.length };
    for (const i of itens) {
      if(i.relogio==='setor'){if(i.aviso)resumo.setor_alerta++;continue;}
      if (!i.responsavel) resumo.sem_responsavel++;
      resumo[i.aviso === 'vencido' ? 'atrasados' : (i.aviso || 'demais')]++;
    }
    return { versao:M.VERSAO, atualizado_em:agora().toISOString(), escopo:admin?'equipe':'pessoal',
      itens,resumo,truncado:r.rows.length > 2000 };
  };
}
module.exports = { resolverResponsavel,item,setorItem,criarConsulta };
