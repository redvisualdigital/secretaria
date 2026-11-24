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
