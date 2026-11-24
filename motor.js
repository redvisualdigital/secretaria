/* Secretária RedVisual · motor
 * Roda a cada ~15 min (GitHub Actions). Lê a agenda (Firestore) e manda mensagens pela Uazapi.
 * Variáveis: FIREBASE_SA (JSON da conta de serviço) | UAZ_URL | UAZ_TOKEN | TESTE (finais de 8 dígitos liberados, separados por vírgula; vazio = todos) | DRY_RUN=1
 */
const admin = require('firebase-admin');
const SA = process.env.FIREBASE_SA ? JSON.parse(process.env.FIREBASE_SA) : null;
admin.initializeApp({ credential: admin.credential.cert(SA) });
const db = admin.firestore();
const UAZ = (process.env.UAZ_URL || '').replace(/\/$/, ''), TOKEN = process.env.UAZ_TOKEN || '';
const DRY = process.env.DRY_RUN === '1';
const TESTE = (process.env.TESTE || '').split(',').map(s => s.replace(/\D/g, '').slice(-8)).filter(Boolean);

/* ---------- datas no fuso de Brasília ---------- */
const TZ = 'America/Sao_Paulo';
const agoraBR = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value])); return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` }; };
const addDias = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const quando = (data, hoje) => { if (data === hoje) return 'hoje'; if (data === addDias(hoje, 1)) return 'amanhã'; const d = new Date(data + 'T12:00:00Z'); return `dia ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} (${DS[d.getUTCDay()]})`; };

/* ---------- textos (aprovados pela Lyslie em 23/11) ---------- */
const nomeServ = s => String(s || 'atendimento').split(' + ').map(x => x.replace(/^Combo\s+/i, '').replace(/\s*·\s*(colocação|manutenção.*)$/i, '').trim()).join(' + ');
const primeiro = n => String(n || '').trim().split(/\s+/)[0] || '';
const TXT = {
  confirmacao: (c, a, hoje) => `Oii ${primeiro(c.nome)}, seu horário de ${nomeServ(a.servicoNome)} está marcado para ${quando(a.data, hoje)} às ${a.hora}. 💗 Qualquer mudança, é só responder aqui.`,
  lembrete: (c, a, hoje) => `Oii ${primeiro(c.nome)}, posso confirmar seu horário de ${nomeServ(a.servicoNome)} ${quando(a.data, hoje)} às ${a.hora}? É só me responder "sim" ou "não". 💗`,
};

/* ---------- WhatsApp (Uazapi) ---------- */
const digitos = t => String(t || '').replace(/\D/g, '');
const numeroBR = t => { let d = digitos(t); if (d.startsWith('55') && d.length >= 12) d = d.slice(2); return d.length >= 10 ? '55' + d : null; };
const liberado = t => !TESTE.length || TESTE.includes(digitos(t).slice(-8));
async function uaz(path, body) {
  const r = await fetch(UAZ + path, { method: 'POST', headers: { token: TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j).slice(0, 200)}`); return j;
}
const espera = ms => new Promise(r => setTimeout(r, ms));

/* ---------- motor ---------- */
(async () => {
  const { ymd: hoje, hm } = agoraBR();
  const cfgRef = db.doc('config/secretaria');
  let cfg = (await cfgRef.get()).data();
  if (!cfg) { cfg = { ativo: true, inicio: new Date().toISOString(), tipos: { confirmacao: true, lembrete: true, sumida: false, aniversario: false }, limiteDia: 20, porRodada: 5, janela: ['08:00', '20:00'], lembreteDe: '09:00' }; if (!DRY) await cfgRef.set(cfg); }
  console.log(`[${hoje} ${hm}] ativo=${cfg.ativo} teste=${TESTE.join(',') || 'NÃO (todos)'} dry=${DRY}`);
  if (!cfg.ativo) return;
  const FORCAR = process.env.FORCAR === '1';
  const dentro = FORCAR || (hm >= cfg.janela[0] && hm <= cfg.janela[1]);

  const clientes = Object.fromEntries((await db.collection('clientes').get()).docs.map(d => [d.id, { id: d.id, ...d.data() }]));
  const ags = (await db.collection('agendamentos').where('data', '>=', hoje).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const envCol = db.collection('secretaria_envios');
  const envHoje = (await envCol.where('dia', '==', hoje).get()).size;
  let restante = Math.max(0, Math.min(cfg.porRodada, cfg.limiteDia - envHoje));

  /* 0a) pedidos do site viram agendamento (o site só cria pedido; quem grava na agenda é o motor) */
  const toMin = h => { const [a, b] = String(h || '0:0').split(':'); return (+a) * 60 + (+b || 0); };
  const dig8 = t => digitos(t).slice(-8);
  const conflito = (lista, profId, data, ini, fim) => lista.some(x => x.data === data && (x.profId === profId || !x.profId) && !['cancelado', 'faltou'].includes(x.status) && ini < toMin(x.hora) + (Number(x.duracao) || 60) && fim > toMin(x.hora));
  const geral = (await db.doc('config/geral').get()).data() || {};
  const pedidos = (await db.collection('pedidos_site').where('status', '==', 'novo').get()).docs;
  for (const pd of pedidos) {
    const p = pd.data(); const ini = toMin(p.hora), fim = ini + (Number(p.duracao) || 60);
    const bloq = (geral.bloqueios || []).some(b => b.data === p.data && (!b.profId || b.profId === 'todas' || b.profId === p.profId) && (b.diaTodo || (ini < toMin(b.ate) && fim > toMin(b.de))));
    if (DRY) { console.log('DRY pedido', p.nome, p.data, p.hora); continue; }
    const svp = (geral.servicos || []).find(x => x.id === p.servicoId) || {};
    const profsP = (svp.divisao || []).length ? svp.divisao.map(d => d.profId) : [p.profId];
    if (bloq || profsP.some(pf => conflito(ags, pf, p.data, ini, fim) || ags.some(x => x.data === p.data && (x.divisao || []).some(d => d.profId === pf) && !['cancelado','faltou'].includes(x.status) && ini < toMin(x.hora) + (Number(x.duracao) || 60) && fim > toMin(x.hora)))) { await pd.ref.update({ status: 'conflito', processadoEm: new Date().toISOString() }); console.log('pedido em conflito', pd.id); continue; }
    let cli = Object.values(clientes).find(c => dig8(c.telefone) && dig8(c.telefone) === dig8(p.telefone));
    if (!cli) { const r = db.collection('clientes').doc(); cli = { id: r.id, nome: p.nome, telefone: p.telefone, obs: 'Cadastrada pelo site', criadoEm: hoje, ...(p.nascimento ? { nascimento: p.nascimento } : {}) }; await r.set(cli); clientes[cli.id] = cli; }
    else if (p.nascimento && !cli.nascimento) await db.collection('clientes').doc(cli.id).update({ nascimento: p.nascimento });
    const sv = (geral.servicos || []).find(x => x.id === p.servicoId) || {};
    const agRef = db.collection('agendamentos').doc();
    const ag = { clienteId: cli.id, profId: sv.profId || ((sv.divisao || [])[0] || {}).profId || p.profId || '', divisao: sv.divisao || [], servicos: [{ id: sv.id || p.servicoId || '', nome: sv.nome || p.servicoNome, preco: sv.preco ?? null, duracao: Number(p.duracao) || sv.duracao || 60 }], servicoId: sv.id || p.servicoId || '', servicoNome: sv.nome || p.servicoNome, domicilio: null, data: p.data, hora: p.hora, valor: sv.preco ?? null, duracao: Number(p.duracao) || sv.duracao || 60, obs: 'Agendado pelo site', status: 'agendado', origem: 'site', criadoEm: new Date().toISOString() };
    await agRef.set(ag); ags.push({ id: agRef.id, ...ag });
    await pd.ref.update({ status: 'feito', agId: agRef.id, processadoEm: new Date().toISOString() });
    console.log('pedido do site → agenda', p.data, p.hora);
  }

  /* 0b) o que o site público pode ver: catálogo e horários ocupados (sem nome de cliente) */
  if (!DRY) {
    const exp = cfg.expediente || { ini: '08:00', fim: '18:00', passo: 30, dias: [1, 2, 3, 4, 5, 6] };
    const servPub = (geral.servicos || []).filter(x => x.duracao && (x.profId || (x.divisao || []).length)).map(x => { const profs = (x.divisao || []).length ? x.divisao.map(d => d.profId) : [x.profId]; return { id: x.id, nome: x.nome, preco: x.preco ?? null, duracao: x.duracao, profId: x.profId || profs[0], profs, combo: profs.length > 1 }; });
    await db.doc('publico/catalogo').set({ estudio: geral.estudio || '', profissionais: (geral.profissionais || []).map(x => ({ id: x.id, nome: x.nome })), servicos: servPub, expediente: exp, atualizadoEm: new Date().toISOString() });
    const ate = addDias(hoje, 45), ocup = {};
    for (const a of ags) { if (a.data > ate || ['cancelado', 'faltou'].includes(a.status)) continue; const k = a.data; (ocup[k] = ocup[k] || []).push([a.profId || '', toMin(a.hora), toMin(a.hora) + (Number(a.duracao) || 60)]); for (const d of (a.divisao || [])) if (d.profId && d.profId !== a.profId) ocup[k].push([d.profId, toMin(a.hora), toMin(a.hora) + (Number(a.duracao) || 60)]); }
    for (const b of (geral.bloqueios || [])) { if (b.data < hoje || b.data > ate) continue; (ocup[b.data] = ocup[b.data] || []).push([b.profId && b.profId !== 'todas' ? b.profId : '', b.diaTodo ? 0 : toMin(b.de), b.diaTodo ? 1440 : toMin(b.ate)]); }
    const plano = {}; for (const [d, l] of Object.entries(ocup)) plano[d] = l.map(x => x.join('|'));
    await db.doc('publico/agenda').set({ ocupados: plano, atualizadoEm: new Date().toISOString() });
  }

  /* 1) respostas ao lembrete: "sim" confirma na agenda */
  const pend = (await envCol.where('tipo', '==', 'lembrete').where('resposta', '==', null).get()).docs;
  for (const e of pend) {
    const v = e.data(); if (!v.chatid || DRY) continue;
    try {
      const j = await uaz('/message/find', { chatid: v.chatid, limit: 15, offset: 0 });
      const msgs = (j.messages || j.data || []).filter(m => !m.fromMe && Number(m.messageTimestamp) > v.enviadoTs);
      if (!msgs.length) continue;
      const t = String(msgs[msgs.length - 1].text || msgs[msgs.length - 1].content?.text || '').trim().toLowerCase();
      const sim = /^(sim|s|confirmo|confirmado|pode confirmar|ok|👍|✅)\b/.test(t) || t === 'sim!' ;
      const nao = /^(n[aã]o|nao posso|não vou)/.test(t);
      await e.ref.update({ resposta: sim ? 'sim' : nao ? 'nao' : 'outra', respostaTexto: t.slice(0, 200), respondidoEm: new Date().toISOString() });
      if (sim) await db.collection('agendamentos').doc(v.agId).update({ status: 'confirmado', confirmadoPor: 'whatsapp', confirmadoEm: new Date().toISOString() });
      console.log(`resposta ${v.agId}: ${sim ? 'SIM' : nao ? 'NÃO' : 'outra'} (${t.slice(0, 40)})`);
    } catch (err) { console.log('erro resposta', err.message); }
  }

  if (!dentro) { console.log('fora do horário de envio'); return; }

  /* 2) fila de envios */
  const fila = [];
  const novo = async id => !(await envCol.doc(id).get()).exists;
  for (const a of ags) {
    const c = clientes[a.clienteId]; if (!c || !numeroBR(c.telefone)) continue;
    if (cfg.tipos.confirmacao && a.status === 'agendado' && String(a.criadoEm || '') >= cfg.inicio && await novo('conf-' + a.id)) fila.push({ id: 'conf-' + a.id, tipo: 'confirmacao', a, c });
    if (cfg.tipos.lembrete && a.status === 'agendado' && a.data === addDias(hoje, 1) && (FORCAR || hm >= cfg.lembreteDe) && await novo('lemb-' + a.id)) fila.push({ id: 'lemb-' + a.id, tipo: 'lembrete', a, c });
  }
  for (const f of fila) {
    if (restante <= 0) { console.log('limite atingido; o resto vai na próxima rodada'); break; }
    const texto = TXT[f.tipo](f.c, f.a, hoje);
    if (!liberado(f.c.telefone)) { console.log(`(teste) não enviado a ${f.c.nome}: ${f.tipo}`); continue; }
    if (DRY) { console.log(`DRY ${f.tipo} → ${f.c.nome} (${numeroBR(f.c.telefone)}): ${texto}`); restante--; continue; }
    try {
      const r = await uaz('/send/text', { number: numeroBR(f.c.telefone), text: texto, delay: 3000, track_source: 'secretaria', track_id: f.id });
      await envCol.doc(f.id).set({ tipo: f.tipo, agId: f.a.id, clienteId: f.c.id, chatid: r.chatid || null, msgId: r.messageid || r.id || null, texto, dia: hoje, enviadoEm: new Date().toISOString(), enviadoTs: Math.floor(Date.now() / 1000), resposta: null });
      if (f.tipo === 'lembrete') await db.collection('agendamentos').doc(f.a.id).update({ confEnviadaEm: `${hoje} ${agoraBR().hm}` }); /* mesmo formato que a agenda usa: a faixa "Confirmar horários" mostra "Mensagem enviada HH:MM" */
      console.log(`ENVIADO ${f.tipo} → ${f.c.nome}`); restante--;
      await espera(20000 + Math.random() * 25000);
    } catch (err) { console.log('erro envio', f.id, err.message); }
  }
  console.log(`fila=${fila.length} enviadosHoje=${envHoje + (cfg.porRodada - restante)}`);
})().then(() => process.exit(0)).catch(e => { console.error('ERRO', e); process.exit(1); });
