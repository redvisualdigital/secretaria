/* Secretária RedVisual · motor (v2, 24/11/2026)
 * Roda a cada ~2 min (GitHub Actions, ver workflow). Lê a agenda (Firestore) e manda mensagens pela Uazapi.
 * Tudo que a dona do negócio ajusta fica em config/secretaria (editável pela agenda, em Ajustes → Secretária):
 *   ativo, tipos{confirmacao,lembrete,retorno,cuidados,conflito}, textos{...}, teste[] (finais liberados; [] = todas),
 *   janela[ini,fim], lembreteDe, cuidadosDe, limiteDia, porRodada, endereco, linkSite, expediente.
 * Variáveis: FIREBASE_SA | UAZ_URL | UAZ_TOKEN | TESTE (só se config/secretaria não tiver "teste") | DRY_RUN=1 | FORCAR=1
 * Economia: o plano grátis do Firestore dá 50 mil leituras/dia. Cada rodada lê só o necessário (~25 leituras).
 * O log não mostra nome, telefone nem texto de cliente: o repositório é público.
 */
const admin = require('firebase-admin');
const SA = process.env.FIREBASE_SA ? JSON.parse(process.env.FIREBASE_SA) : null;
admin.initializeApp({ credential: admin.credential.cert(SA) });
const db = admin.firestore();
const UAZ = (process.env.UAZ_URL || '').replace(/\/$/, ''), TOKEN = process.env.UAZ_TOKEN || '';
const DRY = process.env.DRY_RUN === '1', FORCAR = process.env.FORCAR === '1';
const TESTE_ENV = (process.env.TESTE || '').split(',').map(s => s.replace(/\D/g, '').slice(-8)).filter(Boolean);
const agoraISO = () => new Date().toISOString();

/* ---------- datas no fuso de Brasília ---------- */
const TZ = 'America/Sao_Paulo';
const agoraBR = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value])); return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` }; };
const addDias = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diaBR = iso => iso ? new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(0, 10) : '';
const DS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const ddmm = data => { const d = new Date(data + 'T12:00:00Z'); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} (${DS[d.getUTCDay()]})`; };
const quando = (data, hoje) => data === hoje ? 'hoje' : data === addDias(hoje, 1) ? 'amanhã' : `dia ${ddmm(data)}`;
const dExt = ymd => { const [, m, d] = ymd.split('-').map(Number); return `${d} de ${MES[m - 1]}`; };
const entre = (a, b) => { const [, ma, da] = a.split('-').map(Number), [, mb, db2] = b.split('-').map(Number); return ma === mb ? `entre os dias ${da} e ${db2} de ${MES[mb - 1]}` : `entre o dia ${dExt(a)} e o dia ${dExt(b)}`; };
const toMin = h => { const [a, b] = String(h || '0:0').split(':'); return (+a) * 60 + (+b || 0); };

/* ---------- textos ---------- */
const nomeServ = s => String(s || 'atendimento').replace(/\s*\([^)]*\)/g, '').split(' + ').map(x => x.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*·\s*(colocação|manutenção.*)$/i, '').trim()).join(' + '); /* sem o que vem entre parênteses: "Retorno Brow Lamination", "Combo Essencial" */
const minusc = n => /brow|lash/i.test(n) ? n : n.charAt(0).toLowerCase() + n.slice(1);
const primeiro = n => String(n || '').trim().split(/\s+/)[0] || '';
const ehSobrancelha = n => /sobrancelh|design|henna|brow|lamination/i.test(String(n || ''));
/* textos aprovados pela Lyslie (23 e 24/11). Ela pode trocar pela agenda; o que estiver vazio usa estes. */
const TEXTOS_PADRAO = {
  confirmacao: 'Oii {nome}, seu horário de {servico} está marcado para {quando} às {hora}. 💗 Te espero na {endereco}. Qualquer mudança, é só me avisar por aqui.',
  lembrete: 'Oii {nome}, posso confirmar seu horário de {servico} {quando} às {hora}? É só me responder "sim" ou "não". 💗',
  sim: 'Perfeito, {nome}! Seu horário está confirmado. Te espero {quando} às {hora}, na {endereco}. 💗',
  nao: 'Tudo bem, {nome}! Vou liberar esse horário. Se quiser marcar outro dia, é só escolher aqui: {link} 💗',
  retorno: 'Oii {nome}, seu último {servico} foi dia {data_atendimento} e, {manter}, o ideal é que você retorne {janela}. Vou te enviar o link pra você ver quais horários tenho disponíveis pra te atender: {link} 💗',
  cuidados: 'Oi, {nome}! Seguem os cuidados com seu {servico}:\n{cuidados}\n\nObrigada pela confiança, foi um prazer te atender! 💗 Qualquer dúvida, estou à disposição.',
  conflito: 'Oii {nome}, que pena! O horário de {hora} do {quando} acabou de ser reservado por outra cliente. 😕 Escolhe outro horário aqui, por favor: {link} 💗',
};
const monta = (cfg, tipo, v) => String((cfg.textos || {})[tipo] || TEXTOS_PADRAO[tipo]).replace(/\{(\w+)\}/g, (m, k) => v[k] != null ? String(v[k]) : '').replace(/[ \t]+([.,!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim(); /* mantém as quebras de linha (a Uazapi aceita) */

/* ---------- WhatsApp (Uazapi) ---------- */
const digitos = t => String(t || '').replace(/\D/g, '');
const numeroBR = t => { let d = digitos(t); if (d.startsWith('55') && d.length >= 12) d = d.slice(2); return d.length >= 10 ? '55' + d : null; };
async function uaz(path, body) {
  const r = await fetch(UAZ + path, { method: 'POST', headers: { token: TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j).slice(0, 200)}`); return j;
}
const espera = ms => new Promise(r => setTimeout(r, ms));

/* ---------- motor ---------- */
(async () => {
  const { ymd: hoje, hm } = agoraBR();
  const cfgRef = db.doc('config/secretaria');
  const cfg = (await cfgRef.get()).data() || {};
  cfg.tipos = cfg.tipos || {}; cfg.janela = cfg.janela || ['07:00', '23:00'];
  const TESTE = Array.isArray(cfg.teste) ? cfg.teste.map(s => digitos(s).slice(-8)).filter(Boolean) : TESTE_ENV;
  const liberado = t => !TESTE.length || TESTE.includes(digitos(t).slice(-8));
  const vale = tipo => (tipo === 'cuidados' || tipo === 'conflito') ? cfg.tipos[tipo] === true : cfg.tipos[tipo] !== false; /* cuidados e conflito só se ligados de propósito (conflito virou só notificação na agenda, 24/11) */
  const log = []; const L = s => { log.push(s); console.log(s); };
  L(`[${process.env.CLIENTE || ''} ${hoje} ${hm}] mensagens=${cfg.ativo !== false ? 'ligadas' : 'desligadas'} teste=${TESTE.length ? 'sim' : 'não'} dry=${DRY}`);
  const marca = async extra => { if (!DRY) await cfgRef.set({ ultimaRodada: agoraISO(), ...(extra || {}) }, { merge: true }); };
  /* secretária desligada: as mensagens param, mas o site continua ligado à agenda (pedidos e horários livres) */
  const envia = cfg.ativo !== false && !!TOKEN;
  const dentro = FORCAR || (hm >= cfg.janela[0] && hm <= cfg.janela[1]);

  const geral = (await db.doc('config/geral').get()).data() || {};
  const svcById = id => (geral.servicos || []).find(x => x.id === id) || {};
  const ags = (await db.collection('agendamentos').where('data', '>=', hoje).get()).docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
  /* clientes: só as que aparecem nesta rodada (todas só se houver pedido do site, pra achar pelo telefone) */
  const clientes = {};
  const carregaClientes = async ids => { const falta = [...new Set(ids)].filter(id => id && !clientes[id]); if (!falta.length) return; const docs = await db.getAll(...falta.map(id => db.collection('clientes').doc(id))); docs.forEach(d => { if (d.exists) clientes[d.id] = { id: d.id, ...d.data() }; }); };
  const envCol = db.collection('secretaria_envios');
  const avisos = db.collection('avisos');
  const fila = [];

  /* 0) pedidos do site viram agendamento (o site só cria pedido; quem grava na agenda é o motor) */
  const pedidos = (await db.collection('pedidos_site').where('status', '==', 'novo').get()).docs;
  if (pedidos.length) {
    (await db.collection('clientes').get()).docs.forEach(d => { clientes[d.id] = { id: d.id, ...d.data() }; });
    const dig8 = t => digitos(t).slice(-8);
    const ocupa = (pf, data, ini, fim) => ags.some(x => x.data === data && !['cancelado', 'faltou'].includes(x.status) && (x.profId === pf || !x.profId || (x.divisao || []).some(d => d.profId === pf)) && ini < toMin(x.hora) + (Number(x.duracao) || 60) && fim > toMin(x.hora));
    for (const pd of pedidos) {
      const p = pd.data(); const ini = toMin(p.hora), fim = ini + (Number(p.duracao) || 60);
      if (DRY) { L('DRY pedido ' + pd.id); continue; }
      const sv = svcById(p.servicoId);
      const profs = (sv.divisao || []).length ? sv.divisao.map(d => d.profId) : [p.profId];
      const bloq = (geral.bloqueios || []).some(b => b.data === p.data && (!b.profId || b.profId === 'todas' || profs.includes(b.profId)) && (b.diaTodo || (ini < toMin(b.ate) && fim > toMin(b.de))));
      let cli = Object.values(clientes).find(c => dig8(c.telefone) && dig8(c.telefone) === dig8(p.telefone));
      if (!cli) { const r = db.collection('clientes').doc(); cli = { id: r.id, nome: p.nome, telefone: p.telefone, obs: 'Cadastrada pelo site', criadoEm: hoje }; await r.set(cli); clientes[cli.id] = cli; }
      if (bloq || profs.some(pf => ocupa(pf, p.data, ini, fim))) {
        await pd.ref.update({ status: 'conflito', clienteId: cli.id, processadoEm: agoraISO() });
        await avisos.add({ tipo: 'conflito', nome: cli.nome || p.nome, telefone: p.telefone, servico: sv.nome || p.servicoNome, data: p.data, hora: p.hora, pedidoId: pd.id, criadoEm: agoraISO() });
        L('pedido em conflito ' + pd.id); continue;
      }
      const agRef = db.collection('agendamentos').doc();
      const ag = { clienteId: cli.id, profId: sv.profId || ((sv.divisao || [])[0] || {}).profId || p.profId || '', divisao: sv.divisao || [], servicos: [{ id: sv.id || p.servicoId || '', nome: sv.nome || p.servicoNome, preco: sv.preco ?? null, duracao: Number(p.duracao) || sv.duracao || 60 }], servicoId: sv.id || p.servicoId || '', servicoNome: sv.nome || p.servicoNome, domicilio: null, data: p.data, hora: p.hora, valor: sv.preco == null ? null : sv.preco + (Number(p.acrescimo) || 0), duracao: Number(p.duracao) || sv.duracao || 60, obs: 'Agendado pelo site' + (Number(p.acrescimo) ? ` · domingo/feriado +R$ ${Number(p.acrescimo)}` : ''), status: 'agendado', origem: 'site', criadoEm: agoraISO() };
      await agRef.set(ag); ags.push({ id: agRef.id, ref: agRef, ...ag });
      await pd.ref.update({ status: 'feito', agId: agRef.id, processadoEm: agoraISO() });
      await avisos.add({ tipo: 'agendou', nome: cli.nome || p.nome, telefone: p.telefone, servico: ag.servicoNome, data: p.data, hora: p.hora, agId: agRef.id, criadoEm: agoraISO() });
      L('pedido do site → agenda ' + pd.id);
    }
  }

  /* 1) o que o site público vê: catálogo e horários ocupados (sem nome). Só grava se mudou. */
  const exp = cfg.expediente || { ini: '08:00', fim: '18:00', passo: 30, dias: [1, 2, 3, 4, 5, 6] };
  const servPub = (geral.servicos || []).filter(x => !x.ocultarSite && x.duracao && (x.profId || (x.divisao || []).length)).map(x => { const profs = (x.divisao || []).length ? x.divisao.map(d => d.profId) : [x.profId]; return { id: x.id, nome: x.nome, preco: x.preco ?? null, duracao: x.duracao, profId: x.profId || profs[0], profs, combo: profs.length > 1 }; });
  const catalogo = { estudio: geral.estudio || '', profissionais: (geral.profissionais || []).map(x => ({ id: x.id, nome: x.nome })), servicos: servPub, expediente: exp };
  const ate = addDias(hoje, 45), ocup = {};
  for (const a of ags) { if (a.data > ate || ['cancelado', 'faltou'].includes(a.status)) continue; const k = a.data; (ocup[k] = ocup[k] || []).push([a.profId || '', toMin(a.hora), toMin(a.hora) + (Number(a.duracao) || 60)].join('|')); for (const d of (a.divisao || [])) if (d.profId && d.profId !== a.profId) ocup[k].push([d.profId, toMin(a.hora), toMin(a.hora) + (Number(a.duracao) || 60)].join('|')); }
  for (const b of (geral.bloqueios || [])) { if (b.data < hoje || b.data > ate) continue; (ocup[b.data] = ocup[b.data] || []).push([b.profId && b.profId !== 'todas' ? b.profId : '', b.diaTodo ? 0 : toMin(b.de), b.diaTodo ? 1440 : toMin(b.ate)].join('|')); }
  const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };
  const hCat = hash(JSON.stringify(catalogo)), hAg = hash(JSON.stringify(ocup)), extraCfg = {};
  if (!DRY && cfg.hashCatalogo !== hCat) { await db.doc('publico/catalogo').set({ ...catalogo, atualizadoEm: agoraISO() }); extraCfg.hashCatalogo = hCat; }
  if (!DRY && cfg.hashAgenda !== hAg) { await db.doc('publico/agenda').set({ ocupados: ocup, atualizadoEm: agoraISO() }); extraCfg.hashAgenda = hAg; }

  /* 2) respostas ao lembrete: "sim" confirma, "não" libera o horário; a secretária responde */
  const pend = envia ? (await envCol.where('tipo', '==', 'lembrete').where('resposta', '==', null).get()).docs : [];
  await carregaClientes(pend.map(e => e.data().clienteId));
  for (const e of pend) {
    const v = e.data(); if (!v.chatid || DRY) continue;
    if (v.enviadoTs && Date.now() / 1000 - v.enviadoTs > 3 * 86400) { await e.ref.update({ resposta: 'sem-resposta' }); continue; }
    try {
      const j = await uaz('/message/find', { chatid: v.chatid, limit: 15, offset: 0 });
      const msgs = (j.messages || j.data || []).filter(m => !m.fromMe && Number(m.messageTimestamp) > v.enviadoTs);
      if (!msgs.length) continue;
      const t = String(msgs[msgs.length - 1].text || msgs[msgs.length - 1].content?.text || '').trim().toLowerCase();
      const sim = /^(sim|s|confirmo|confirmado|pode confirmar|ok|👍|✅)\b/.test(t) || t === 'sim!';
      const nao = /^(n[aã]o|nao posso|não vou)/.test(t);
      await e.ref.update({ resposta: sim ? 'sim' : nao ? 'nao' : 'outra', respostaTexto: t.slice(0, 200), respondidoEm: agoraISO() });
      const agRef = db.collection('agendamentos').doc(v.agId); const ag = (await agRef.get()).data() || {}; const cl = clientes[v.clienteId] || {};
      if (sim) await agRef.update({ status: 'confirmado', confirmadoPor: 'whatsapp', confirmadoEm: agoraISO() });
      if (nao) { await agRef.update({ status: 'cancelado', canceladoPor: 'whatsapp', canceladoEm: agoraISO(), obs: ((ag.obs || '') + ' · cancelado pela cliente no WhatsApp').replace(/^ · /, '') }); await avisos.add({ tipo: 'cancelou', nome: cl.nome || '', servico: ag.servicoNome || '', data: ag.data, hora: ag.hora, agId: v.agId, criadoEm: agoraISO() }); }
      if ((sim || nao) && liberado(cl.telefone)) {
        const txt = monta(cfg, sim ? 'sim' : 'nao', { nome: primeiro(cl.nome), servico: nomeServ(ag.servicoNome), quando: quando(ag.data, hoje), hora: ag.hora, endereco: cfg.endereco || '', link: cfg.linkSite || '' });
        try { await uaz('/send/text', { number: v.chatid.split('@')[0], text: txt, delay: 2000, track_source: 'secretaria', track_id: 'resp-' + e.id }); await e.ref.update({ respostaEnviada: txt }); } catch (err) { L('erro resposta envio'); }
      }
      L(`resposta ${v.agId}: ${sim ? 'SIM' : nao ? 'NÃO' : 'outra'}`);
    } catch (err) { L('erro resposta'); }
  }

  if (!envia) { await marca(extraCfg); L('mensagens desligadas'); return; }
  if (!dentro) { await marca(extraCfg); L('fora do horário de envio'); return; }

  /* 3) fila de envios */
  await carregaClientes(ags.map(a => a.clienteId));
  const wa = a => a.wa || {};
  for (const a of ags) {
    const c = clientes[a.clienteId]; if (!c || !numeroBR(c.telefone)) continue;
    if (vale('confirmacao') && a.status === 'agendado' && (String(a.criadoEm || '') >= (cfg.inicio || '') || (cfg.antigosAte && a.data <= cfg.antigosAte)) && !wa(a).conf) /* antigosAte: horários marcados antes da secretária também confirmam, só até essa data (liberação de 24/11) */ fila.push({ id: 'conf-' + a.id, tipo: 'confirmacao', a, c });
    /* quem agendou na véspera (ou no mesmo dia) acabou de receber a confirmação: não precisa de lembrete */
    if (vale('lembrete') && a.status === 'agendado' && a.data === addDias(hoje, 1) && !(diaBR(a.criadoEm) >= addDias(a.data, -1)) && (FORCAR || hm >= (cfg.lembreteDe || '09:00')) && !wa(a).lemb) fila.push({ id: 'lemb-' + a.id, tipo: 'lembrete', a, c });
  }
  /* pedidos do site que bateram com outro horário: avisa a cliente com o link */
  if (vale('conflito')) {
    const conf = (await db.collection('pedidos_site').where('status', '==', 'conflito').get()).docs.filter(d => !d.data().avisadoEm);
    await carregaClientes(conf.map(d => d.data().clienteId));
    for (const d of conf) { const p = d.data(); const c = clientes[p.clienteId] || { nome: p.nome, telefone: p.telefone }; if (numeroBR(c.telefone)) fila.push({ id: 'confl-' + d.id, tipo: 'conflito', a: p, c, ref: d.ref }); }
  }
  /* chamadas de retorno marcadas na agenda ("Chamar para retorno daqui 15 dias") */
  if (vale('retorno')) {
    const rets = (await db.collection('secretaria_retornos').where('status', '==', 'agendado').get()).docs.filter(d => d.data().enviarEm <= hoje);
    await carregaClientes(rets.map(d => d.data().clienteId));
    for (const rd of rets) {
      const r = rd.data(); const c = clientes[r.clienteId];
      if (!c || !numeroBR(c.telefone)) { if (!DRY) await rd.ref.update({ status: 'sem-telefone' }); continue; }
      if (ags.some(x => x.clienteId === r.clienteId && ['agendado', 'confirmado'].includes(x.status))) { if (!DRY) await rd.ref.update({ status: 'ja-marcou', vistoEm: agoraISO() }); L('retorno dispensado (já marcou) ' + rd.id); continue; }
      fila.push({ id: rd.id, tipo: 'retorno', a: r, c, ref: rd.ref });
    }
  }
  /* cuidados no dia seguinte ao atendimento (desligado até a Lyslie ligar) */
  if (vale('cuidados') && hm >= (cfg.cuidadosDe || '09:00')) {
    const cs = (await db.collection('acompanhamentos').where('tipo', '==', 'cuidados').where('feito', '==', false).get()).docs.filter(d => d.data().data <= hoje && d.data().data >= addDias(hoje, -2));
    await carregaClientes(cs.map(d => d.data().clienteId));
    for (const d of cs) { const x = d.data(); const c = clientes[x.clienteId]; const sv = svcById(x.servicoId); const cuid = (sv.cuidados || '').trim(); /* combo: os cuidados e o nome são os da parte da sobrancelha (cuidadosNome) */ if (c && numeroBR(c.telefone) && cuid) fila.push({ id: 'cuid-' + d.id, tipo: 'cuidados', a: { ...x, cuidados: cuid, servicoNome: sv.cuidadosNome || x.servicoNome }, c, ref: d.ref }); }
  }

  const envHoje = (await envCol.where('dia', '==', hoje).count().get()).data().count;
  let restante = Math.max(0, Math.min(cfg.porRodada || 5, (cfg.limiteDia || 20) - envHoje));
  for (const f of fila) {
    if (restante <= 0) { L('limite atingido; o resto vai na próxima rodada'); break; }
    const a = f.a, c = f.c;
    const v = { nome: primeiro(c.nome), servico: f.tipo === 'retorno' ? minusc(nomeServ(a.servicoNome)) : nomeServ(a.servicoNome), quando: a.data ? quando(a.data, hoje) : '', hora: a.hora || '', endereco: cfg.endereco || '', link: cfg.linkSite || '', cuidados: String(a.cuidados || '').split(/\n+/).map(x => x.trim().replace(/[.;]+$/, '')).filter(Boolean).map(x => '• ' + x).join('\n') };
    if (f.tipo === 'retorno') Object.assign(v, { data_atendimento: dExt(a.dataAtendimento), janela: entre(addDias(a.dataAtendimento, a.de || 20), addDias(a.dataAtendimento, a.ate || 30)), manter: ehSobrancelha(a.servicoNome) ? 'pra manter suas sobrancelhas lindas' : 'pra manter tudo sempre lindo' });
    const texto = monta(cfg, f.tipo, v);
    if (!liberado(c.telefone)) { L(`(teste) segurado: ${f.id}`); continue; }
    if (DRY) { L(`DRY ${f.tipo} → ${texto}`); restante--; continue; }
    try {
      const r = await uaz('/send/text', { number: numeroBR(c.telefone), text: texto, delay: 3000, track_source: 'secretaria', track_id: f.id });
      await envCol.doc(f.id).set({ tipo: f.tipo, agId: a.id || a.agendamentoId || a.agId || null, clienteId: c.id || null, chatid: r.chatid || null, msgId: r.messageid || r.id || null, texto, dia: hoje, enviadoEm: agoraISO(), enviadoTs: Math.floor(Date.now() / 1000), resposta: f.tipo === 'lembrete' ? null : 'n/a' });
      if (f.tipo === 'confirmacao') await a.ref.update({ 'wa.conf': agoraISO() });
      if (f.tipo === 'lembrete') await a.ref.update({ 'wa.lemb': agoraISO(), confEnviadaEm: `${hoje} ${agoraBR().hm}` }); /* a faixa "Confirmar horários" da agenda mostra "Mensagem enviada HH:MM" */
      if (f.tipo === 'retorno') await f.ref.update({ status: 'enviado', enviadoEm: agoraISO() });
      if (f.tipo === 'cuidados') await f.ref.update({ feito: true, feitoEm: hoje, feitoPor: 'secretaria' });
      if (f.tipo === 'conflito') await f.ref.update({ avisadoEm: agoraISO() });
      L(`ENVIADO ${f.id}`); restante--;
      await espera(20000 + Math.random() * 25000);
    } catch (err) { L('erro envio ' + f.id); }
  }
  L(`fila=${fila.length} enviadosHoje=${envHoje + ((cfg.porRodada || 5) - restante)}`);
  await marca(extraCfg);
})().then(() => process.exit(0)).catch(e => { console.error('ERRO', e && e.message); process.exit(1); });
