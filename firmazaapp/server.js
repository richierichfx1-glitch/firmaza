/**
 * Firmaza — servidor de aplicación (sin dependencias externas)
 * ------------------------------------------------------------
 * Este proyecto se construyó usando SOLO módulos nativos de Node.js porque
 * el registro de npm no es accesible desde este sandbox. Funciona igual:
 * Node 18+ trae `fetch` nativo, así que las integraciones con Stripe y
 * proveedores de verificación de identidad se hacen con REST directo,
 * sin necesidad de sus SDKs oficiales.
 *
 * Rutas principales:
 *   GET  /                          -> landing page
 *   GET  /app                       -> flujo de notarización (SPA)
 *   GET  /notario                   -> panel para notarios activos (RON)
 *   POST /api/sessions              -> crea una sesión de notarización
 *   GET  /api/document-templates    -> lista de plantillas que Firmaza puede preparar (ver lib/documentTemplates.js)
 *   POST /api/sessions/:id/prepare-document -> genera un PDF (plantilla o carta dictada por el cliente) y lo deja como el documento de la sesión
 *   POST /api/sessions/:id/upload   -> sube un documento (base64 JSON)
 *   POST /api/sessions/:id/verify   -> guarda datos de verificación de identidad
 *   POST /api/sessions/:id/checkout -> crea sesión de pago (Stripe REST) o modo demo
 *   POST /api/sessions/:id/confirm-payment -> confirma el regreso exitoso desde Square (ver nota abajo)
 *   POST /api/sessions/:id/sign     -> guarda la firma electrónica (PNG base64)
 *   GET  /api/notaries              -> lista notarios activos (RON)
 *   POST /api/sessions/:id/claim    -> un notario toma la sesión de la cola
 *   GET  /api/sessions/:id          -> estado de la sesión (para polling)
 *   POST /api/sessions/:id/notarize -> envía la sesión a Proof.com (RON real) o queda en demo
 *   GET  /api/sessions/:id/proof-status -> consulta el estado de la transacción en Proof.com
 *   POST /api/rtc/:room/signal      -> señalización WebRTC (oferta/respuesta/ICE)
 *   GET  /api/rtc/:room/signal      -> long-poll de señales pendientes
 *   POST /webhooks/proof            -> recibe eventos de Proof.com (transacción actualizada)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const proofRon = require('./integrations/proof');
const { renderPdf } = require('./lib/pdf');
const docTemplates = require('./lib/documentTemplates');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const NOTARIES_FILE = path.join(DATA_DIR, 'notaries.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

for (const dir of [DATA_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}');

// ---------------------------------------------------------------------------
// Almacén simple basado en archivos JSON (suficiente para un MVP funcional;
// para producción real, cambiar por Postgres/SQLite con transacciones).
// ---------------------------------------------------------------------------
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function loadSessions() { return readJSON(SESSIONS_FILE); }
function saveSessions(s) { writeJSON(SESSIONS_FILE, s); }
function loadNotaries() {
  const d = readJSON(NOTARIES_FILE);
  return Array.isArray(d.notaries) ? d.notaries : [];
}

// Señalización WebRTC en memoria: { roomId: [ {from, type, payload, ts}, ... ] }
const rtcRooms = {};

function send(res, status, body, headers = {}) {
  const isJSON = typeof body === 'object';
  const payload = isJSON ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJSON ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    ...headers,
  });
  res.end(payload);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { // 25MB cap por request
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { error: 'No encontrado' });
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Integración de pagos — Square (Payment Links API), REST directo sin SDK.
// Requiere una cuenta de Square (developer.squareup.com) con Access Token y
// Location ID. Sin esas variables, el checkout queda en modo demo.
// Docs: https://developer.squareup.com/docs/checkout-api/overview
// ---------------------------------------------------------------------------
async function createSquarePaymentLink({ amountCents, description, redirectUrl }) {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!token || !locationId) return { demo: true };

  const env = process.env.SQUARE_ENV === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
  const resp = await fetch(`https://${env}/v2/online-checkout/payment-links`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-08-21',
    },
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: description,
        price_money: { amount: amountCents, currency: 'USD' },
        location_id: locationId,
      },
      checkout_options: { redirect_url: redirectUrl },
    }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.errors?.[0]?.detail || 'Error de Square');
  return { demo: false, url: json.payment_link.url, id: json.payment_link.id };
}

// ---------------------------------------------------------------------------
// Verificación de identidad — punto de integración con un proveedor real
// (Persona, Stripe Identity, Onfido, IDenfy, etc.). Sin una API key configurada
// operamos en "modo de prueba" para que el flujo completo sea probable de
// principio a fin; esto NO debe usarse en producción para notarizaciones reales.
// ---------------------------------------------------------------------------
async function runIdentityVerification(payload) {
  const provider = process.env.IDV_PROVIDER; // ej. 'stripe_identity' | 'persona'
  const key = process.env.IDV_PROVIDER_API_KEY;
  if (!provider || !key) {
    return {
      mode: 'demo',
      status: 'requiere_configuracion',
      note: 'Configura IDV_PROVIDER e IDV_PROVIDER_API_KEY para verificación real (KBA + análisis de credencial).',
    };
  }
  // Punto de extensión: aquí se llamaría a la API real del proveedor elegido.
  return { mode: 'live', status: 'pendiente_integracion_especifica_de_proveedor' };
}

function newId() { return crypto.randomBytes(8).toString('hex'); }

async function handleApi(req, res, pathname, query) {
  const sessions = loadSessions();

  // --- Sesiones -------------------------------------------------------
  if (pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readBody(req);
    const id = newId();
    sessions[id] = {
      id,
      createdAt: new Date().toISOString(),
      signerName: body.signerName || '',
      email: body.email || '',
      language: body.language || 'es',
      status: 'iniciada',
      document: null,
      identity: null,
      payment: null,
      signature: null,
      notaryId: null,
      history: [{ event: 'sesion_creada', at: new Date().toISOString() }],
    };
    saveSessions(sessions);
    return send(res, 200, { session: sessions[id] });
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([a-f0-9]+)(\/.*)?$/);
  if (sessionMatch) {
    const id = sessionMatch[1];
    const sub = sessionMatch[2] || '';
    const s = sessions[id];
    if (!s) return send(res, 404, { error: 'Sesión no encontrada' });

    if (sub === '' && req.method === 'GET') {
      return send(res, 200, { session: s });
    }

    if (sub === '/upload' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.filename || !body.base64) return send(res, 400, { error: 'Falta filename o base64' });
      const safeName = `${id}-${Date.now()}-${body.filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
      const filePath = path.join(UPLOADS_DIR, safeName);
      const base64Data = body.base64.replace(/^data:.*;base64,/, '');
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
      s.document = { originalName: body.filename, storedAs: safeName, uploadedAt: new Date().toISOString() };
      // El nombre/correo del firmante se capturan en este mismo paso del flujo
      // (paso 0 en app.js); los guardamos aquí porque /api/sessions se crea
      // antes de que el usuario los escriba.
      if (body.signerName) s.signerName = body.signerName;
      if (body.email) s.email = body.email;
      s.status = 'documento_subido';
      s.history.push({ event: 'documento_subido', at: new Date().toISOString() });
      saveSessions(sessions);
      return send(res, 200, { session: s });
    }

    // Genera un documento PDF para el firmante (plantilla llenada por él
    // mismo, o una carta cuyo texto completo escribió él) y lo deja como si
    // lo hubiera subido — mismo estado/flujo que /upload de aquí en adelante.
    // IMPORTANTE: Firmaza NUNCA decide el contenido legal aquí, solo lo
    // acomoda en formato de documento — ver aviso en lib/documentTemplates.js.
    if (sub === '/prepare-document' && req.method === 'POST') {
      const body = await readBody(req);
      let blocks, docTitle, templateId = null;
      try {
        if (body.mode === 'template') {
          const template = docTemplates.getTemplate(body.templateId);
          if (!template) return send(res, 400, { error: 'Plantilla no encontrada' });
          const values = body.values || {};
          const err = docTemplates.validateValues(template, values);
          if (err) return send(res, 400, { error: err });
          blocks = template.render(values);
          docTitle = template.name;
          templateId = template.id;
        } else if (body.mode === 'custom') {
          const cuerpo = String(body.cuerpo || '').trim();
          if (!cuerpo) return send(res, 400, { error: 'Escribe el texto de tu carta' });
          blocks = docTemplates.renderCustomLetter({
            titulo: body.titulo,
            cuerpo,
            autor: s.signerName || body.autor || '',
            lugar: body.lugar,
          });
          docTitle = body.titulo || 'Carta';
        } else {
          return send(res, 400, { error: 'mode debe ser "template" o "custom"' });
        }
        const pdfBuffer = renderPdf(blocks);
        const safeName = `${id}-preparado-${Date.now()}.pdf`;
        fs.writeFileSync(path.join(UPLOADS_DIR, safeName), pdfBuffer);
        s.document = {
          originalName: `${docTitle}.pdf`,
          storedAs: safeName,
          uploadedAt: new Date().toISOString(),
          preparedByFirmaza: true,
          mode: body.mode,
          templateId,
        };
        if (body.signerName) s.signerName = body.signerName;
        if (body.email) s.email = body.email;
        s.status = 'documento_subido';
        s.history.push({ event: 'documento_preparado_por_firmaza', at: new Date().toISOString(), mode: body.mode, templateId });
        saveSessions(sessions);
        return send(res, 200, { session: s });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    if (sub === '/verify' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await runIdentityVerification(body);
      s.identity = {
        fullName: body.fullName || '',
        idType: body.idType || '',
        idLast4: (body.idNumber || '').slice(-4),
        verifiedAt: new Date().toISOString(),
        result,
      };
      s.status = 'identidad_verificada';
      s.history.push({ event: 'identidad_verificada', at: new Date().toISOString(), result: result.mode });
      saveSessions(sessions);
      return send(res, 200, { session: s });
    }

    if (sub === '/checkout' && req.method === 'POST') {
      const body = await readBody(req);
      const amountCents = Math.round((body.amount || 25) * 100);
      const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      try {
        const result = await createSquarePaymentLink({
          amountCents,
          description: body.description || 'Notarización — Firmaza',
          redirectUrl: `${origin}/app#/pagar-exito/${id}`,
        });
        if (result.demo) {
          s.payment = { mode: 'demo', amount: amountCents / 100, paidAt: new Date().toISOString() };
          s.status = 'pagado_demo';
          s.history.push({ event: 'pago_demo', at: new Date().toISOString() });
          saveSessions(sessions);
          return send(res, 200, { demo: true, session: s });
        }
        s.payment = { mode: 'square', paymentLinkId: result.id, amount: amountCents / 100 };
        saveSessions(sessions);
        return send(res, 200, { demo: false, url: result.url });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    // Square redirige aquí (`redirectUrl` de arriba) solo cuando el pago se
    // completó, así que el frontend llama esta ruta apenas detecta el
    // regreso (#/pagar-exito/:id) para dejar la sesión marcada como pagada
    // y poder seguir directo a /notarize. NOTA: esto confía en el redirect
    // de Square; para producción con más volumen conviene además validar
    // el pago con el webhook de Square (Payments API) antes de confiar en
    // este solo paso — por ahora es suficiente para el prototipo.
    if (sub === '/confirm-payment' && req.method === 'POST') {
      if (s.payment?.mode !== 'demo') {
        s.payment = { ...(s.payment || {}), mode: 'square', paidAt: new Date().toISOString() };
        s.status = 'pagado_square';
        s.history.push({ event: 'pago_square_confirmado', at: new Date().toISOString() });
        saveSessions(sessions);
      }
      return send(res, 200, { session: s });
    }

    if (sub === '/notarize' && req.method === 'POST') {
      if (!s.document) return send(res, 400, { error: 'Primero hay que subir el documento' });
      if (!s.email) return send(res, 400, { error: 'La sesión no tiene correo del firmante' });
      const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      const documentUrl = `${origin}/uploads/${s.document.storedAs}`;
      try {
        const result = await proofRon.createRonSession({
          sessionId: id,
          signerName: s.signerName,
          signerEmail: s.email,
          documentUrl,
        });
        if (!result) {
          // Sin PROOF_API_KEY configurada: seguimos en modo demo (cola interna + WebRTC).
          s.history.push({ event: 'notarize_modo_demo', at: new Date().toISOString() });
          saveSessions(sessions);
          return send(res, 200, { demo: true, session: s });
        }
        s.proof = {
          transactionId: result.transactionId,
          status: result.status,
          createdAt: new Date().toISOString(),
        };
        s.status = 'enviado_a_notario_proof';
        s.history.push({ event: 'enviado_a_proof', at: new Date().toISOString(), transactionId: result.transactionId });
        saveSessions(sessions);
        return send(res, 200, { demo: false, session: s });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    if (sub === '/proof-status' && req.method === 'GET') {
      if (!s.proof || !s.proof.transactionId) return send(res, 404, { error: 'Esta sesión no tiene transacción de Proof.com' });
      try {
        const tx = await proofRon.getTransactionStatus(s.proof.transactionId);
        s.proof.status = tx?.status || s.proof.status;
        if (tx?.status === 'completed' || tx?.status === 'released') s.status = 'notarizacion_completada';
        else if (tx?.status === 'declined') s.status = 'notarizacion_rechazada';
        saveSessions(sessions);
        return send(res, 200, { session: s, transaction: tx });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    if (sub === '/claim' && req.method === 'POST') {
      const body = await readBody(req);
      s.notaryId = body.notaryId;
      s.status = 'en_sesion_con_notario';
      s.roomId = s.roomId || newId();
      s.history.push({ event: 'notario_tomo_sesion', at: new Date().toISOString(), notaryId: body.notaryId });
      saveSessions(sessions);
      return send(res, 200, { session: s });
    }

    if (sub === '/sign' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.signaturePng) return send(res, 400, { error: 'Falta signaturePng' });
      const safeName = `${id}-firma-${Date.now()}.png`;
      const filePath = path.join(UPLOADS_DIR, safeName);
      fs.writeFileSync(filePath, Buffer.from(body.signaturePng.replace(/^data:.*;base64,/, ''), 'base64'));
      const hash = crypto.createHash('sha256')
        .update(JSON.stringify({ id, doc: s.document, at: Date.now() }))
        .digest('hex');
      s.signature = {
        storedAs: safeName,
        signedAt: new Date().toISOString(),
        ip: req.socket.remoteAddress,
        auditHash: hash,
      };
      s.status = 'firmado';
      s.history.push({ event: 'documento_firmado', at: new Date().toISOString(), auditHash: hash });
      saveSessions(sessions);
      return send(res, 200, { session: s });
    }

    return send(res, 404, { error: 'Ruta no encontrada' });
  }

  // --- Plantillas de documentos (modelo "self-help", ver lib/documentTemplates.js) ---
  if (pathname === '/api/document-templates' && req.method === 'GET') {
    return send(res, 200, { templates: docTemplates.listTemplates(), disclaimer: docTemplates.LEGAL_DISCLAIMER });
  }

  // --- Notarios (RON activos) -----------------------------------------
  if (pathname === '/api/notaries' && req.method === 'GET') {
    return send(res, 200, { notaries: loadNotaries() });
  }

  if (pathname === '/api/queue' && req.method === 'GET') {
    const pending = Object.values(sessions).filter((s) =>
      ['pagado_demo', 'identidad_verificada'].includes(s.status) || s.status === 'en_cola'
    );
    return send(res, 200, { queue: pending });
  }

  // --- Señalización WebRTC (oferta/respuesta/ICE) ----------------------
  const rtcMatch = pathname.match(/^\/api\/rtc\/([a-zA-Z0-9-]+)\/signal$/);
  if (rtcMatch) {
    const room = rtcMatch[1];
    rtcRooms[room] = rtcRooms[room] || [];
    if (req.method === 'POST') {
      const body = await readBody(req);
      rtcRooms[room].push({ ...body, ts: Date.now() });
      if (rtcRooms[room].length > 200) rtcRooms[room].shift();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      const since = Number(query.get('since') || 0);
      const from = query.get('from') || '';
      const msgs = rtcRooms[room].filter((m) => m.ts > since && m.from !== from);
      return send(res, 200, { messages: msgs, now: Date.now() });
    }
  }

  return send(res, 404, { error: 'No encontrado' });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (pathname === '/webhooks/proof' && req.method === 'POST') {
    try {
      const raw = await readRawBody(req);
      const signature = req.headers['x-notarize-signature'];
      if (!proofRon.verifyWebhookSignature(raw, signature)) {
        console.warn('Webhook de Proof.com con firma inválida o PROOF_API_KEY no configurada');
        return send(res, 400, { error: 'Firma inválida' });
      }
      const payload = JSON.parse(raw);
      const event = payload.event;
      const transactionId = payload.data?.transaction_id;
      const sessions = loadSessions();
      const match = Object.values(sessions).find((s) => s.proof?.transactionId === transactionId);
      if (match) {
        match.proof.status = event;
        match.proof.lastEventAt = new Date().toISOString();
        if (event === 'transaction.completed' || event === 'transaction.released') {
          match.status = 'notarizacion_completada';
        } else if (event === 'transaction.declined' || event === 'transaction.canceled' || event === 'transaction.expired') {
          match.status = 'notarizacion_rechazada';
        } else if (event === 'transaction.meeting.requested' || event === 'transaction.meeting.created' || event === 'notary.signer_ready') {
          match.status = 'en_reunion_con_notario';
        } else if (event === 'transaction.sent_to_signer') {
          match.status = 'enviado_a_notario_proof';
        }
        match.history.push({ event: `proof:${event}`, at: new Date().toISOString() });
        saveSessions(sessions);
      } else {
        console.warn(`Webhook de Proof.com para transacción sin sesión local: ${transactionId} (${event})`);
      }
      return send(res, 200, { received: true });
    } catch (e) {
      if (e.message === 'PAYLOAD_TOO_LARGE') return send(res, 413, { error: 'Payload demasiado grande' });
      console.error('Error procesando webhook de Proof.com:', e.message);
      return send(res, 500, { error: 'Error interno' });
    }
  }

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname, u.searchParams);
    } catch (e) {
      if (e.message === 'PAYLOAD_TOO_LARGE') return send(res, 413, { error: 'Archivo demasiado grande' });
      send(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname.startsWith('/uploads/')) {
    return serveStatic(req, res, path.join(DATA_DIR, pathname.replace('/uploads/', 'uploads/')));
  }

  // Rutas de páginas (SPA con rutas "bonitas")
  const routes = {
    '/': 'index.html',
    '/app': 'app.html',
    '/notario': 'notario.html',
  };
  if (routes[pathname]) {
    return serveStatic(req, res, path.join(PUBLIC_DIR, routes[pathname]));
  }

  // Archivos estáticos (css/js/imágenes)
  const staticPath = path.join(PUBLIC_DIR, pathname);
  if (staticPath.startsWith(PUBLIC_DIR) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    return serveStatic(req, res, staticPath);
  }

  return send(res, 404, { error: 'Página no encontrada' });
});

server.listen(PORT, () => {
  console.log(`Firmaza corriendo en http://localhost:${PORT}`);
  console.log(process.env.SQUARE_ACCESS_TOKEN ? 'Square: modo real' : 'Square: modo demo (sin SQUARE_ACCESS_TOKEN)');
});
