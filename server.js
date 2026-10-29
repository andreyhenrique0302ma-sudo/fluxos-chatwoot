// Fluxos Chatwoot — motor de fluxos com botões para WhatsApp via Chatwoot
// Node 18+ (usa fetch nativo). Única dependência: express.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- .env simples (sem dependência) ----------
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const CFG = {
  url: (process.env.CHATWOOT_URL || '').replace(/\/+$/, ''),
  account: process.env.CHATWOOT_ACCOUNT_ID,
  token: process.env.CHATWOOT_API_TOKEN,
  inbox: Number(process.env.CHATWOOT_INBOX_ID) || null,
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASSWORD || '',
  webhookToken: process.env.WEBHOOK_TOKEN || '',
  port: Number(process.env.PORT) || 3000,
  buttonMode: (process.env.BUTTON_MODE || 'botoes').toLowerCase(), // 'botoes' | 'texto'
  dispatchDelay: Number(process.env.DISPATCH_DELAY_MS) || 1500,
  stepDelay: Number(process.env.STEP_DELAY_MS) || 1200,
  mediaDelay: Number(process.env.MEDIA_DELAY_MS) || 2500,
  handoffKeywords: (process.env.HANDOFF_KEYWORDS || 'atendente,falar com atendente')
    .split(',').map(s => norm(s)).filter(Boolean),
  maxInvalid: Number(process.env.MAX_INVALID) || 2,
  labelDone: process.env.LABEL_DONE || 'fluxo-concluido',
  labelHuman: process.env.LABEL_HUMAN || 'atendimento-humano',
};

// ---------- Armazenamento (arquivo JSON) ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { flows: [], sessions: {}, dispatches: [], processed: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
// Mídias dos fluxos (imagem, vídeo, áudio, documento): arquivo + .json com nome/tipo
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const MB = 1024 * 1024;
const MEDIA_TYPES = { // limites do WhatsApp
  'image/jpeg': 5 * MB, 'image/png': 5 * MB,
  'video/mp4': 16 * MB, 'video/3gpp': 16 * MB,
  'audio/mpeg': 16 * MB, 'audio/ogg': 16 * MB, 'audio/mp4': 16 * MB, 'audio/aac': 16 * MB, 'audio/amr': 16 * MB,
  'application/pdf': 16 * MB, 'application/msword': 16 * MB, 'application/vnd.ms-excel': 16 * MB,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 16 * MB,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 16 * MB,
};
const MIME_ALIAS = { 'image/jpg': 'image/jpeg', 'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/x-aac': 'audio/aac' };
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  }, 200);
}

// ---------- Utilidades ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => crypto.randomBytes(5).toString('hex');
const now = () => new Date().toISOString();
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d; // DDD + número
  return d;
}
// Variantes BR com e sem o 9º dígito (o WhatsApp às vezes registra sem o 9)
function phoneVariants(d) {
  const v = new Set([d]);
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') v.add(d.slice(0, 4) + d.slice(5));
  if (d.startsWith('55') && d.length === 12) v.add(d.slice(0, 4) + '9' + d.slice(4));
  return [...v];
}
function render(text, vars) {
  return String(text || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => (vars[k] ?? vars[norm(k)] ?? ''));
}
function sessionVars(s) {
  const nome = s.contactName || '';
  return { nome, primeiro_nome: nome.split(' ')[0] || '', telefone: s.phone || '', ...(s.vars || {}), ...(s.answers || {}) };
}

// ---------- Cliente Chatwoot ----------
async function cw(method, p, body) {
  if (!CFG.url || !CFG.account || !CFG.token) throw new Error('Chatwoot não configurado (.env)');
  const form = body instanceof FormData; // anexos vão como multipart
  const res = await fetch(`${CFG.url}/api/v1/accounts/${CFG.account}${p}`, {
    method,
    headers: form ? { api_access_token: CFG.token } : { 'Content-Type': 'application/json', api_access_token: CFG.token },
    body: form ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const det = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`Chatwoot ${method} ${p} → ${res.status}: ${det.slice(0, 300)}`);
  }
  return data;
}
const sendMessage = (conv, payload) =>
  cw('POST', `/conversations/${conv}/messages`, { message_type: 'outgoing', private: false, ...payload });
const sendText = (conv, content) => sendMessage(conv, { content });
const sendNote = (conv, content) => cw('POST', `/conversations/${conv}/messages`, { content, message_type: 'outgoing', private: true });
function sendMedia(conv, media, caption) {
  const file = path.join(MEDIA_DIR, media.id);
  if (!/^[a-f0-9]{20}$/.test(media.id) || !fs.existsSync(file)) throw new Error(`Mídia "${media.name}" não encontrada no servidor`);
  const form = new FormData();
  if (caption) form.append('content', caption);
  form.append('message_type', 'outgoing');
  form.append('private', 'false');
  form.append('attachments[]', new Blob([fs.readFileSync(file)], { type: media.mime }), media.name);
  return cw('POST', `/conversations/${conv}/messages`, form);
}
// etiquetas do Chatwoot: minúsculas, sem espaços; aceita várias separadas por vírgula
const splitLabels = v => String(v || '').split(',').map(l => l.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
// o POST do Chatwoot substitui todas as etiquetas, então lê as atuais antes
// (se a leitura falhar, não grava nada — melhor não etiquetar do que apagar as que já existem)
async function setLabels(conv, add, remove = []) {
  const current = (await cw('GET', `/conversations/${conv}/labels`)).payload || [];
  const all = [...new Set([...current, ...add])].filter(l => !remove.includes(l) || add.includes(l));
  if (all.length === current.length && all.every(l => current.includes(l))) return;
  return cw('POST', `/conversations/${conv}/labels`, { labels: all });
}

// ---------- Motor de fluxos ----------
const getFlow = id => db.flows.find(f => f.id === id);
const END = '__fim__', HUMAN = '__humano__';

function log(s, who, text) {
  s.history = s.history || [];
  s.history.push({ at: now(), who, text: String(text || '').slice(0, 500) });
  if (s.history.length > 80) s.history = s.history.slice(-80);
  s.updatedAt = now();
  save();
}

async function sendStep(s, step) {
  const text = render(step.text, sessionVars(s));
  const conv = s.conversationId;
  if (step.media) {
    // texto vira legenda da mídia; áudio e mensagem com botões não aceitam legenda
    const caption = step.type !== 'botoes' && !step.media.mime.startsWith('audio/') ? text.trim() : '';
    await sendMedia(conv, step.media, caption);
    if (caption || (step.type !== 'botoes' && !text.trim())) return;
    await sleep(CFG.mediaDelay); // dá tempo da mídia chegar antes do texto
  }
  if (step.type === 'botoes' && step.buttons?.length) {
    if (CFG.buttonMode === 'texto') {
      const opts = step.buttons.map((b, i) => `*${i + 1}* - ${b.label}`).join('\n');
      await sendText(conv, `${text}\n\n${opts}\n\n_Responda com o número da opção._`);
    } else {
      const max = step.buttons.length <= 3 ? 20 : 24;
      await sendMessage(conv, {
        content: text,
        content_type: 'input_select',
        content_attributes: { items: step.buttons.slice(0, 10).map(b => ({ title: b.label.slice(0, max), value: b.label.slice(0, max) })) },
      });
    }
  } else if (text.trim()) {
    await sendText(conv, text);
  }
}

async function goTo(s, nextId) {
  for (let guard = 0; guard < 40; guard++) {
    if (!nextId || nextId === END) return finish(s, 'concluido');
    if (nextId === HUMAN) return finish(s, 'humano');
    const flow = getFlow(s.flowId);
    const step = flow?.steps.find(x => x.id === nextId);
    if (!step) return finish(s, 'erro', `Etapa "${nextId}" não existe no fluxo`);
    // blocos finais: mensagem opcional + etiqueta própria
    if (step.type === 'fim' || step.type === 'humano') {
      s.currentStepId = step.id;
      if (String(step.text || '').trim() || step.media) { await sendStep(s, step); log(s, 'bot', step.text || step.media.name); }
      return finish(s, step.type === 'fim' ? 'concluido' : 'humano', null, { add: step.label, remove: step.removeLabels });
    }
    s.currentStepId = step.id; s.status = 'ativo'; s.invalid = 0;
    await sendStep(s, step);
    log(s, 'bot', step.title || step.text);
    if (step.type === 'mensagem') { await sleep(step.media ? CFG.stepDelay + CFG.mediaDelay : CFG.stepDelay); nextId = step.next; continue; }
    return; // espera resposta (botoes / pergunta)
  }
  return finish(s, 'erro', 'Loop detectado no fluxo');
}

// labels: { add, remove } do bloco final; sem bloco (saída solta), vale o configurado no fluxo
async function finish(s, status, error, labels = {}) {
  s.status = status; s.finishedAt = now(); if (error) s.error = error;
  log(s, 'sistema', `Fluxo ${status}${error ? ': ' + error : ''}`);
  const flow = getFlow(s.flowId);
  const conv = s.conversationId;
  const human = status === 'humano' || status === 'erro';
  try {
    const answers = Object.entries(s.answers || {}).map(([k, v]) => `• ${k}: ${v}`).join('\n') || '(sem respostas)';
    const titulo = status === 'humano' ? '🙋 Paciente pediu/encaminhado para atendente'
      : status === 'erro' ? '⚠️ Fluxo interrompido por erro' : '✅ Fluxo concluído';
    await sendNote(conv, `${titulo} — ${flow?.name || ''}\n\n${answers}${error ? '\n\nErro: ' + error : ''}`);
  } catch (e) { console.error('[finish nota]', e.message); }
  try {
    const add = human ? [CFG.labelHuman, ...splitLabels(labels.add)]
      : splitLabels(labels.add).length ? splitLabels(labels.add) : splitLabels(flow?.labelDone || CFG.labelDone);
    const remove = splitLabels(labels.remove !== undefined && String(labels.remove).trim() ? labels.remove : human ? '' : flow?.removeLabels);
    await setLabels(conv, add, remove);
    s.labels = { add, remove }; save();
  } catch (e) { console.error('[finish etiquetas]', e.message); log(s, 'sistema', 'Não deu para atualizar as etiquetas: ' + e.message); }
  if (human) await cw('POST', `/conversations/${conv}/toggle_status`, { status: 'open' }).catch(() => {});
}

function matchButton(step, content) {
  const c = norm(content);
  if (!c) return null;
  const idx = parseInt(c, 10);
  if (String(idx) === c && step.buttons[idx - 1]) return step.buttons[idx - 1];
  return step.buttons.find(b => norm(b.label) === c)
    || step.buttons.find(b => norm(b.label.slice(0, 20)) === c || norm(b.label.slice(0, 24)) === c)
    || step.buttons.find(b => c.length >= 3 && norm(b.label).startsWith(c));
}

function newSession({ conv, flow, name, phone, vars, status, dispatchId }) {
  const s = {
    conversationId: conv, flowId: flow.id, flowName: flow.name, contactName: name || '', phone: phone || '',
    vars: vars || {}, answers: {}, history: [], status, currentStepId: null, invalid: 0,
    dispatchId: dispatchId || null, createdAt: now(), updatedAt: now(),
  };
  db.sessions[conv] = s; save();
  return s;
}

const ACTIVE = ['aguardando_inicio', 'ativo'];

async function handleIncoming(p) {
  const conv = p.conversation?.id;
  if (!conv) return;
  const inboxId = Number(p.inbox?.id ?? p.conversation?.inbox_id);
  if (CFG.inbox && inboxId && inboxId !== CFG.inbox) return;
  const content = String(p.content || '').trim() || (p.attachments?.length ? '[anexo]' : '');
  let s = db.sessions[conv];

  // Sem fluxo ativo: verifica palavra-chave que inicia fluxo
  if (!s || !ACTIVE.includes(s.status)) {
    const c = norm(content);
    const flow = db.flows.find(f => f.active !== false && (f.keywords || []).some(k => norm(k) && norm(k) === c));
    if (!flow) return;
    s = newSession({ conv, flow, name: p.sender?.name, phone: p.sender?.phone_number, status: 'ativo' });
    log(s, 'paciente', content);
    return goTo(s, flow.startStepId || flow.steps[0]?.id);
  }

  log(s, 'paciente', content);
  if (CFG.handoffKeywords.includes(norm(content))) return finish(s, 'humano');

  const flow = getFlow(s.flowId);
  if (!flow) return finish(s, 'erro', 'Fluxo foi apagado');

  if (s.status === 'aguardando_inicio') return goTo(s, flow.startStepId || flow.steps[0]?.id);

  const step = flow.steps.find(x => x.id === s.currentStepId);
  if (!step) return finish(s, 'erro', 'Etapa atual não existe mais');

  if (step.type === 'pergunta') {
    s.answers[step.saveAs || step.title || step.id] = content;
    return goTo(s, step.next);
  }
  if (step.type === 'botoes') {
    const b = matchButton(step, content);
    if (!b) {
      // paciente digitou em vez de tocar: segue a saída "se digitar", se estiver conectada
      if (step.onText && step.onText !== 'repetir') {
        s.answers[step.saveAs || step.title || step.id] = content;
        return goTo(s, step.onText === 'humano' ? HUMAN : step.onText);
      }
      s.invalid = (s.invalid || 0) + 1;
      if (s.invalid > CFG.maxInvalid) return finish(s, 'humano');
      await sendText(conv, step.invalidText || 'Não entendi 😅 Por favor, toque em uma das opções abaixo:');
      await sendStep(s, step);
      return save();
    }
    s.answers[step.saveAs || step.title || step.id] = b.label;
    return goTo(s, b.next);
  }
  return goTo(s, step.next);
}

// fila por conversa (evita processar 2 mensagens do mesmo paciente ao mesmo tempo)
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const p = prev.then(fn).catch(e => console.error('[fluxo]', e.message));
  locks.set(key, p);
  p.finally(() => { if (locks.get(key) === p) locks.delete(key); });
  return p;
}

// ---------- Disparo ----------
async function findOrCreateContact(name, digits) {
  for (const v of phoneVariants(digits)) {
    const r = await cw('GET', `/contacts/search?q=${encodeURIComponent('+' + v)}`);
    const hit = (r.payload || []).find(c => String(c.phone_number || '').replace(/\D/g, '') === v);
    if (hit) return hit.id;
  }
  const r = await cw('POST', '/contacts', { inbox_id: CFG.inbox, name: name || '+' + digits, phone_number: '+' + digits });
  return r.payload?.contact?.id ?? r.payload?.id ?? r.id;
}

async function getConversation(contactId, digits) {
  const convs = (await cw('GET', `/contacts/${contactId}/conversations`)).payload || [];
  const open = convs.filter(c => Number(c.inbox_id) === CFG.inbox && c.status !== 'resolved').sort((a, b) => b.id - a.id)[0];
  if (open) return open.id;
  const contact = (await cw('GET', `/contacts/${contactId}`)).payload || {};
  let sourceId = (contact.contact_inboxes || []).find(ci => Number(ci.inbox?.id) === CFG.inbox)?.source_id;
  if (!sourceId) {
    sourceId = digits;
    await cw('POST', `/contacts/${contactId}/contact_inboxes`, { inbox_id: CFG.inbox, source_id: sourceId }).catch(() => {});
  }
  const r = await cw('POST', '/conversations', { source_id: sourceId, inbox_id: CFG.inbox, contact_id: contactId });
  return r.id;
}

async function runDispatch(d) {
  const flow = getFlow(d.flowId);
  for (const item of d.items) {
    if (item.status !== 'pendente') continue;
    try {
      const digits = normPhone(item.phone);
      // escolhido na lista de conversas: usa a conversa que já existe
      let conv = item.conversationId;
      if (!conv) {
        if (digits.length < 12) throw new Error('Telefone inválido');
        const contactId = await findOrCreateContact(item.name, digits);
        conv = await getConversation(contactId, digits);
      }
      item.conversationId = conv;
      // automático: direto se a janela de 24h está aberta, senão template
      const mode = d.mode === 'auto' ? (item.canReply ? 'direto' : 'template') : d.mode;
      item.mode = mode;
      const s = newSession({ conv, flow, name: item.name, phone: digits, vars: item.vars, dispatchId: d.id,
        status: mode === 'template' ? 'aguardando_inicio' : 'ativo' });
      if (mode === 'template') {
        const vars = sessionVars(s);
        const body = {};
        (d.template.params || []).forEach((v, i) => { body[String(i + 1)] = render(v, vars); });
        let content = d.template.body || d.template.name;
        Object.entries(body).forEach(([k, v]) => { content = content.split(`{{${k}}}`).join(v); });
        await sendMessage(conv, {
          content,
          template_params: { name: d.template.name, category: d.template.category || 'UTILITY',
            language: d.template.language || 'pt_BR', processed_params: { body } },
        });
        log(s, 'bot', `Template "${d.template.name}" enviado — aguardando o paciente responder`);
      } else {
        await goTo(s, flow.startStepId || flow.steps[0]?.id);
      }
      item.status = 'enviado'; d.ok++;
    } catch (e) {
      item.status = 'erro'; item.error = e.message; d.fail++;
    }
    d.done++; save();
    await sleep(CFG.dispatchDelay);
  }
  d.finishedAt = now(); save();
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '5mb' }));

// Webhook (sem login, protegido por token na URL)
app.post('/webhook/chatwoot', (req, res) => {
  if (CFG.webhookToken && req.query.token !== CFG.webhookToken) return res.sendStatus(401);
  res.sendStatus(200);
  const p = req.body || {};
  if (p.event !== 'message_created' || p.message_type !== 'incoming' || p.private) return;
  if (p.id) {
    if (db.processed.includes(p.id)) return;
    db.processed.push(p.id); if (db.processed.length > 3000) db.processed = db.processed.slice(-2000);
  }
  withLock(String(p.conversation?.id), () => handleIncoming(p));
});
app.get('/health', (req, res) => res.json({ ok: true }));

// Login básico para o painel
app.use((req, res, next) => {
  if (!CFG.adminPass) return next();
  const [u, pw] = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':');
  if (u === CFG.adminUser && pw === CFG.adminPass) return next();
  res.set('WWW-Authenticate', 'Basic realm="Fluxos"').status(401).send('Login necessário');
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => res.json({
  configured: !!(CFG.url && CFG.account && CFG.token && CFG.inbox),
  chatwootUrl: CFG.url, account: CFG.account, inbox: CFG.inbox, buttonMode: CFG.buttonMode,
  webhookPath: `/webhook/chatwoot${CFG.webhookToken ? '?token=' + CFG.webhookToken : ''}`,
  hasPassword: !!CFG.adminPass,
}));
app.post('/api/test', async (req, res) => {
  try {
    const i = await cw('GET', `/inboxes/${CFG.inbox}`);
    res.json({ ok: true, inbox: i.name, channel: i.channel_type, provider: i.provider });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/templates', async (req, res) => {
  try {
    const i = await cw('GET', `/inboxes/${CFG.inbox}`);
    const list = (i.message_templates || []).filter(t => !t.status || String(t.status).toUpperCase() === 'APPROVED').map(t => {
      const body = (t.components || []).find(c => c.type === 'BODY')?.text || '';
      const n = new Set((body.match(/\{\{\s*\d+\s*\}\}/g) || [])).size;
      const buttons = ((t.components || []).find(c => c.type === 'BUTTONS')?.buttons || []).map(b => b.text);
      return { name: t.name, language: t.language, category: t.category, body, params: n, buttons };
    });
    res.json({ ok: true, templates: list });
  } catch (e) { res.json({ ok: false, error: e.message, templates: [] }); }
});

// Upload de mídia para os blocos do fluxo (corpo = arquivo cru; nome no cabeçalho X-Filename)
app.post('/api/media', express.raw({ type: () => true, limit: '17mb' }), (req, res) => {
  let mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  mime = MIME_ALIAS[mime] || mime;
  const max = MEDIA_TYPES[mime];
  if (!max) return res.status(400).json({ error: 'Tipo de arquivo não aceito pelo WhatsApp. Use JPG/PNG, MP4, MP3/OGG/M4A, PDF, Word ou Excel.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Arquivo vazio' });
  if (req.body.length > max) return res.status(400).json({ error: `Arquivo grande demais: o WhatsApp aceita até ${max / MB} MB para este tipo` });
  let name = 'arquivo';
  try { name = decodeURIComponent(req.headers['x-filename'] || 'arquivo'); } catch {}
  const meta = { id: crypto.randomBytes(10).toString('hex'), name: path.basename(name).slice(0, 120), mime, size: req.body.length };
  fs.writeFileSync(path.join(MEDIA_DIR, meta.id), req.body);
  fs.writeFileSync(path.join(MEDIA_DIR, meta.id + '.json'), JSON.stringify(meta));
  res.json(meta);
});
app.get('/api/media/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{20}$/.test(id) || !fs.existsSync(path.join(MEDIA_DIR, id))) return res.sendStatus(404);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, id + '.json'), 'utf8')); } catch {}
  res.type(meta.mime || 'application/octet-stream').sendFile(path.join(MEDIA_DIR, id));
});
// Respostas de erro do upload (ex.: arquivo acima do limite do express.raw)
app.use('/api/media', (err, req, res, next) => res.status(err.status || 400).json({ error: err.type === 'entity.too.large' ? 'Arquivo grande demais (máx. 16 MB)' : err.message }));

// Conversas da caixa do WhatsApp, para escolher quem recebe o disparo
app.get('/api/conversas', async (req, res) => {
  try {
    const status = ['open', 'pending', 'resolved', 'snoozed', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const page = Math.max(1, Number(req.query.page) || 1);
    const r = await cw('GET', `/conversations?inbox_id=${CFG.inbox}&status=${status}&assignee_type=all&page=${page}`);
    const raw = r.data?.payload || r.payload || [];
    const list = raw.map(c => {
      const last = c.last_non_activity_message || (c.messages || []).slice(-1)[0] || {};
      const s = db.sessions[c.id];
      return {
        id: c.id, name: c.meta?.sender?.name || '', phone: c.meta?.sender?.phone_number || '',
        status: c.status, labels: c.labels || [], unread: c.unread_count || 0,
        lastAt: c.last_activity_at || c.timestamp || 0, canReply: c.can_reply === true,
        lastText: String(last.content || (last.attachments?.length ? '[anexo]' : '')).slice(0, 140),
        lastIncoming: last.message_type === 0 || last.message_type === 'incoming',
        flow: s ? { status: s.status, name: s.flowName } : null,
      };
    });
    res.json({ ok: true, list, hasMore: raw.length >= 25 });
  } catch (e) { res.json({ ok: false, error: e.message, list: [] }); }
});

// Últimas mensagens de uma conversa (para identificar o paciente antes do disparo)
const FILE_TYPES = { image: '[imagem]', audio: '[áudio]', video: '[vídeo]', file: '[arquivo]', location: '[localização]', contact: '[contato]' };
app.get('/api/conversas/:id/mensagens', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'Conversa inválida' });
    const r = await cw('GET', `/conversations/${id}/messages`);
    const list = (r.payload || [])
      .filter(m => m.message_type !== 2 && m.message_type !== 'activity') // tira "conversa resolvida" etc.
      .sort((a, b) => a.created_at - b.created_at)
      .slice(-20)
      .map(m => ({
        id: m.id, at: m.created_at, private: !!m.private,
        who: m.message_type === 0 || m.message_type === 'incoming' ? 'paciente' : 'equipe',
        sender: m.sender?.name || '',
        text: String(m.content || (m.attachments || []).map(a => FILE_TYPES[a.file_type] || '[anexo]').join(' ') || '').slice(0, 600),
      }));
    res.json({ ok: true, list });
  } catch (e) { res.json({ ok: false, error: e.message, list: [] }); }
});

app.get('/api/flows', (req, res) => res.json(db.flows));
app.post('/api/flows', (req, res) => {
  const f = req.body;
  if (!f.name || !Array.isArray(f.steps)) return res.status(400).json({ error: 'Fluxo inválido' });
  f.id = f.id || uid(); f.updatedAt = now();
  const i = db.flows.findIndex(x => x.id === f.id);
  if (i >= 0) db.flows[i] = f; else db.flows.push(f);
  save(); res.json(f);
});
app.delete('/api/flows/:id', (req, res) => { db.flows = db.flows.filter(f => f.id !== req.params.id); save(); res.json({ ok: true }); });

app.post('/api/dispatch', (req, res) => {
  const { flowId, mode, template, contacts } = req.body;
  if (!getFlow(flowId)) return res.status(400).json({ error: 'Escolha um fluxo' });
  if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'Nenhum contato' });
  const needsTpl = mode === 'template' || (mode === 'auto' && contacts.some(c => !c.canReply));
  if (needsTpl && !template?.name) return res.status(400).json({ error: 'Informe o template (há pacientes fora da janela de 24h)' });
  const d = {
    id: uid(), flowId, flowName: getFlow(flowId).name, mode, template, createdAt: now(),
    total: contacts.length, done: 0, ok: 0, fail: 0,
    items: contacts.map(c => ({ name: c.name, phone: c.phone, vars: c.vars || {}, status: 'pendente',
      conversationId: Number(c.conversationId) || null, canReply: !!c.canReply })),
  };
  db.dispatches.unshift(d); db.dispatches = db.dispatches.slice(0, 100); save();
  runDispatch(d).catch(e => console.error('[disparo]', e));
  res.json({ id: d.id });
});
app.get('/api/dispatches', (req, res) => res.json(db.dispatches));

app.get('/api/sessions', (req, res) => {
  let list = Object.values(db.sessions);
  if (req.query.flowId) list = list.filter(s => s.flowId === req.query.flowId);
  res.json(list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 2000));
});
app.post('/api/sessions/:conv/cancel', (req, res) => {
  const s = db.sessions[req.params.conv];
  if (s) { s.status = 'cancelado'; log(s, 'sistema', 'Cancelado pelo painel'); }
  res.json({ ok: true });
});
app.get('/api/sessions.csv', (req, res) => {
  let list = Object.values(db.sessions);
  if (req.query.flowId) list = list.filter(s => s.flowId === req.query.flowId);
  const keys = [...new Set(list.flatMap(s => Object.keys(s.answers || {})))];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Nome', 'Telefone', 'Fluxo', 'Status', 'Conversa', 'Atualizado', ...keys].map(esc).join(';')];
  for (const s of list) rows.push([s.contactName, s.phone, s.flowName, s.status, s.conversationId, s.updatedAt, ...keys.map(k => s.answers?.[k])].map(esc).join(';'));
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="respostas.csv"');
  res.send('﻿' + rows.join('\n'));
});

// retoma disparos interrompidos por reinício
for (const d of db.dispatches) if (!d.finishedAt && d.items.some(i => i.status === 'pendente')) runDispatch(d).catch(() => {});

app.listen(CFG.port, () => {
  console.log(`Fluxos Chatwoot rodando em http://localhost:${CFG.port}`);
  if (!CFG.adminPass) console.warn('⚠️  ADMIN_PASSWORD vazio: painel sem senha.');
  if (!CFG.webhookToken) console.warn('⚠️  WEBHOOK_TOKEN vazio: webhook sem proteção.');
});
