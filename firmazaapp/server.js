/**
 * Firmaza — servidor de aplicación (sin dependencias externas de framework)
 * ------------------------------------------------------------
 * Este proyecto usa solo módulos nativos de Node.js para todo lo que no sea
 * la base de datos (Node 18+ trae `fetch` nativo, así que las integraciones
 * con Square y Proof.com se hacen con REST directo, sin SDKs oficiales).
 *
 * Persistencia: Postgres real (ver lib/db.js), no archivos locales. Antes
 * este servidor guardaba sesiones/clientes/autenticación en archivos JSON
 * dentro de `data/`, en el propio disco del contenedor — sin un disco
 * persistente adjunto en Render, ese disco se reinicia desde cero en cada
 * deploy o reinicio, así que cualquier cuenta de cliente, sesión o
 * documento subido se perdía. Ahora todo eso (incluidos los archivos
 * subidos/generados) vive en Postgres, que sí sobrevive deploys y reinicios.
 * Ver lib/db.js para el detalle de las tablas y consultas.
 *
 * PUBLIC_ORIGIN (recomendado: "https://firmaza.com"): de dónde salen las
 * URLs que este servidor genera y le manda a terceros (Square, Proof.com,
 * el enlace mágico por correo) — sin esta variable se usa el header Host de
 * la petición entrante, que cualquiera puede falsificar. Ver trustedOrigin().
 *
 * Rutas principales:
 *   GET  /                          -> landing page
 *   GET  /app                       -> flujo de notarización (SPA)
 *   GET  /notario                   -> panel para notarios activos (RON)
 *   POST /api/sessions              -> crea una sesión de notarización
 *   GET  /api/payment-mode           -> si el pago es real (Square configurado) o una simulación, para el aviso en /app
 *   GET  /api/document-templates    -> lista de plantillas que Firmaza puede preparar (ver lib/documentTemplates.js)
 *   POST /api/sessions/:id/prepare-document -> genera un PDF (plantilla o carta dictada por el cliente) y lo deja como el documento de la sesión
 *                                        (en inglés por defecto + versión en español; el permiso de viaje sale bilingüe)
 *   POST /api/sessions/:id/document-language -> el firmante elige con qué idioma se queda ('en' | 'es') y aprueba la traducción
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
 *   POST /webhooks/proof            -> recibe eventos de Proof.com (transacción actualizada; declined/expired disparan reembolso automático — ver refundSessionIfEligible)
 *   POST /admin/sessions/:id/refund -> reembolso manual protegido con ADMIN_SECRET, para casos que no califican para el reembolso automático (ej. 'canceled')
 *   POST /admin/register-proof-webhook -> registra la suscripción de webhooks v2 en Proof.com (una vez, protegido con ADMIN_SECRET)
 *   GET  /admin/list-proof-webhooks    -> lista las suscripciones de webhooks ya registradas en Proof.com (protegido con ADMIN_SECRET)
 *   GET  /uploads/:id               -> sirve un archivo guardado en la base de datos (documento/firma)
 *
 *   -- Acceso del panel de notario (/notario) --
 *   POST /api/notary/login             -> entra con el código de acceso compartido (NOTARY_ACCESS_CODE)
 *   POST /api/notary/logout            -> cierra la sesión de notario
 *   GET  /api/notary/me                -> si hay una sesión de notario activa
 *   GET  /api/queue                    -> cola de firmantes en espera (requiere sesión de notario)
 *   POST /api/sessions/:id/claim       -> un notario toma una sesión de la cola (requiere sesión de notario)
 *
 *   -- Cuentas de cliente (perfil, sin contraseña — enlace mágico por correo) --
 *   GET  /cuenta                       -> panel del cliente (login si no hay sesión, perfil si la hay)
 *   POST /api/auth/request-link        -> pide un enlace mágico de acceso para un correo
 *   GET  /auth/verify?token=...        -> valida el enlace, crea/encuentra al cliente, abre sesión (cookie httpOnly)
 *   GET  /api/auth/me                  -> quién es el cliente autenticado (o authenticated:false)
 *   POST /api/auth/logout              -> cierra la sesión del cliente
 *   GET  /api/cuenta/nucleo            -> datos "núcleo" guardados del cliente (para prellenar documentos futuros)
 *   PUT  /api/cuenta/nucleo            -> guarda/actualiza el núcleo del cliente
 *   GET  /api/cuenta/documentos        -> historial de documentos del cliente (por coincidencia de correo)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const proofRon = require('./integrations/proof');
const { renderPdf } = require('./lib/pdf');
const docTemplates = require('./lib/documentTemplates');
const { translateFields } = require('./lib/translate');
const db = require('./lib/db');

const PORT = process.env.PORT || 8080;
// Ruta del panel de notario (ver "Rutas de páginas" más abajo).
const NOTARY_PANEL_PATH = (() => {
  const raw = String(process.env.NOTARY_PANEL_PATH || '').trim().replace(/\/+$/, '');
  if (!raw) return '/notario';
  return raw.startsWith('/') ? raw : `/${raw}`;
})();
const DATA_DIR = path.join(__dirname, 'data');
// notaries.json sigue siendo un archivo estático dentro del repo (config
// editada a mano por el equipo, no datos generados por usuarios en runtime),
// así que no necesita vivir en la base de datos — se redeploya con el código.
const NOTARIES_FILE = path.join(DATA_DIR, 'notaries.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function loadNotaries() {
  const d = readJSON(NOTARIES_FILE);
  return Array.isArray(d.notaries) ? d.notaries : [];
}

function sanitizeNucleo(body) {
  const clamp = (v, max) => String(v == null ? '' : v).slice(0, max);
  const familiares = Array.isArray(body.familiares)
    ? body.familiares.slice(0, 20).map((f) => ({
        nombre: clamp(f && f.nombre, 120),
        parentesco: clamp(f && f.parentesco, 60),
        fechaNacimiento: clamp(f && f.fechaNacimiento, 20),
      }))
    : [];
  return {
    nombreCompleto: clamp(body.nombreCompleto, 160),
    telefono: clamp(body.telefono, 40),
    direccion: clamp(body.direccion, 240),
    ciudad: clamp(body.ciudad, 80),
    estado: clamp(body.estado, 80),
    codigoPostal: clamp(body.codigoPostal, 12),
    familiares,
    notas: clamp(body.notas, 1000),
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(pair.slice(idx + 1).trim()); } catch { /* cookie corrupta, se ignora */ }
  });
  return out;
}
function isHttps(req) {
  return (req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}
// El header Host (y x-forwarded-proto) los manda el cliente y no son de
// fiar para construir URLs que luego se usan para cosas sensibles: el
// enlace mágico de acceso, el redirectUrl que ve Square, la URL pública del
// documento que se le manda a Proof.com, o a dónde apunta el webhook que se
// registra en la cuenta de Proof.com. Si alguien manda un Host falsificado
// (p. ej. "evil.com"), esas URLs podrían apuntar a un dominio que no es
// firmaza.com. Con PUBLIC_ORIGIN configurado (recomendado:
// "https://firmaza.com") se usa siempre ese valor fijo; solo si no está
// configurada se cae de vuelta al header Host, igual que antes.
function trustedOrigin(req) {
  const configured = (process.env.PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  return `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
}
// IP real del cliente detrás del proxy de Render. Render añade la IP real
// del visitante como el ÚLTIMO salto de X-Forwarded-For (el salto que
// agrega el propio proxy de Render, en el que sí se puede confiar) — el
// PRIMER salto es el que manda el cliente en su petición original, y
// cualquiera puede falsificarlo (curl -H "X-Forwarded-For: 1.2.3.4" ...).
// El código anterior leía el primer salto tanto para el límite de intentos
// de login de notario como para el registro de auditoría de la firma: en
// ambos casos un atacante podía escribir ahí lo que quisiera, lo que
// permitía saltarse el límite de fuerza bruta (cada intento con una IP
// falsa distinta cuenta como "nueva") y falsificar la IP que queda
// registrada como prueba de quién firmó.
function trustedClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const hops = String(xff).split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || 'desconocido';
}
// Comparación de secretos en tiempo constante — evita filtrar por timing
// cuántos caracteres iniciales coinciden (como sí hace `!==` con strings).
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
// Límite simple de intentos por IP para el login de notario — sin esto,
// cualquiera podía probar códigos de NOTARY_ACCESS_CODE sin freno alguno
// (es un solo código compartido, así que fuerza bruta es más viable que con
// una contraseña individual). En memoria: se reinicia si el proceso
// reinicia, suficiente para frenar automatización básica.
const notaryLoginAttempts = new Map();
function isNotaryLoginRateLimited(req) {
  const ip = trustedClientIp(req);
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10 minutos
  const entry = notaryLoginAttempts.get(ip);
  if (!entry || now - entry.windowStart > windowMs) {
    notaryLoginAttempts.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > 20;
}
// Limpieza periódica para no acumular entradas indefinidamente.
setInterval(() => {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  for (const [ip, entry] of notaryLoginAttempts.entries()) {
    if (now - entry.windowStart > windowMs) notaryLoginAttempts.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// Catálogo de precios del lado del servidor — el monto y la descripción del
// cargo en Square NUNCA deben venir del cliente (antes /checkout confiaba
// ciegamente en body.amount/body.description: cualquiera podía mandar
// amount:0.01 y "pagar" un centavo por una notarización). El único producto
// que hoy realmente se cobra desde el flujo de /app es la notarización
// online ($39, ver public/index.html #precios); se deja como catálogo (en
// vez de una sola constante) para poder agregar sellos/testigos
// adicionales el día que el checkout los soporte, sin reabrir este hueco.
//
// Precio base $39 (antes $25 — ese precio igualaba exactamente el costo
// mayorista que cobra Proof.com por sesión vía Notarize Network, así que
// cada transacción perdía dinero después de las comisiones de Square; ver
// conversación con Ricardo sobre estrategia de precios). Los extras de
// firmante/sello ($10/$15) también igualaban el costo mayorista de Proof.com
// (additional signer $10, additional seal $15) sin ningún margen — se suben
// a $15/$25 con el mismo margen proporcional que el precio base.
const PRICE_CATALOG = {
  primer_sello: { amountCents: 3900, description: 'Notarización online — Firmaza' },
  // Mismos precios que public/index.html #precios. Cada firmante adicional
  // (p. ej. el otro padre/madre en el permiso de viaje) paga su firma y su
  // propio sello: $15 + $25 = $40 más.
  firmante_adicional: { amountCents: 1500, description: 'Firmante adicional' },
  sello_adicional: { amountCents: 2500, description: 'Sello notarial adicional' },
};
const DEFAULT_PRICE_ITEM = 'primer_sello';

/** Precio de una sesión, calculado SOLO del lado del servidor a partir del
 * documento guardado (nunca de lo que mande el navegador). */
function priceForSession(s) {
  const base = PRICE_CATALOG[DEFAULT_PRICE_ITEM];
  const extras = s.document && s.document.preparedByFirmaza
    ? docTemplates.additionalSigners(s.document.templateId, s.document.inputs).length
    : 0;
  const extraCents = extras * (PRICE_CATALOG.firmante_adicional.amountCents + PRICE_CATALOG.sello_adicional.amountCents);
  return {
    amountCents: base.amountCents + extraCents,
    extraSigners: extras,
    description: extras
      ? `${base.description} + ${extras} firmante(s) y sello(s) adicional(es)`
      : base.description,
  };
}
const SESSION_COOKIE = 'firmaza_session';
function sessionCookieHeader(req, token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'SameSite=Lax',
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

// Devuelve el cliente autenticado a partir de la cookie de sesión, o null.
async function getClientFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const ls = await db.getLoginSession(token);
  if (!ls) return null;
  return db.getClientByEmail(ls.email);
}

// ---------------------------------------------------------------------------
// Dueño de una sesión de notarización (/api/sessions/:id/*). Antes, conocer
// el id de una sesión (64 bits al azar — infactible de adivinar a ciegas,
// pero sí filtrable por otros medios: el historial del navegador en un
// equipo compartido, una captura de pantalla, un salto de referrer) bastaba
// para hacer CUALQUIER cosa con ella sin haberla creado: leer los datos del
// firmante, reemplazar el documento, forzar /confirm-payment, disparar
// /notarize. La sesión no necesita cuenta (Firmaza permite notarizar sin
// registrarse), así que no se puede exigir aquí el login de cliente — en su
// lugar, el propio servidor le da al navegador que CREA la sesión una
// cookie httpOnly con un token al azar (independiente por sesión, nunca
// viaja en el cuerpo JSON de ninguna respuesta — ver la nota en
// lib/db.js#getSessionOwnerToken), scoped con Path a esa sesión específica.
// Cualquier sub-ruta que muta la sesión exige que esa cookie coincida con
// lo que el servidor guardó.
const SESSION_OWNER_COOKIE_PREFIX = 'firmaza_sowner_';
const SESSION_OWNER_MAX_AGE = 60 * 60 * 24 * 3; // 3 días: de sobra para completar el trámite o retomarlo, sin dejar la cookie viva para siempre.
function sessionOwnerCookieName(id) {
  return `${SESSION_OWNER_COOKIE_PREFIX}${id}`;
}
function sessionOwnerCookieHeader(req, id, token) {
  const parts = [
    `${sessionOwnerCookieName(id)}=${token}`,
    'HttpOnly',
    `Path=/api/sessions/${id}`,
    `Max-Age=${SESSION_OWNER_MAX_AGE}`,
    'SameSite=Lax',
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}
// Sesiones creadas ANTES de este arreglo no tienen owner_token guardado
// (columna nueva, nula en filas viejas) — ahí se deja pasar sin exigir la
// cookie, para no dejar a alguien a mitad de su trámite sin poder
// continuar justo en el momento del despliegue. Toda sesión NUEVA desde
// ahora sí queda protegida.
async function verifySessionOwnership(req, id) {
  const expected = await db.getSessionOwnerToken(id);
  if (!expected) return true;
  const cookies = parseCookies(req);
  const provided = cookies[sessionOwnerCookieName(id)];
  return !!provided && timingSafeStringEqual(provided, expected);
}

// ---------------------------------------------------------------------------
// Acceso del panel de notario (/notario). Antes de esto, /api/queue y
// /api/sessions/:id/claim no tenían ningún control de acceso: cualquiera que
// visitara /notario (o llamara a esas rutas directo) podía ver la cola
// completa de firmantes en espera (nombre, correo, tipo/últimos 4 dígitos de
// identificación, nombre del documento) y "tomar" cualquier sesión, sin
// verificar que fuera realmente un notario autorizado de Firmaza.
//
// No hay todavía cuentas individuales de notario (eso sería una cuenta por
// notario, con su propia contraseña/enlace mágico), así que por ahora se usa
// un solo código de acceso compartido (NOTARY_ACCESS_CODE) que el equipo le
// da a cada notario autorizado. Si esa variable de entorno no está
// configurada, el acceso queda cerrado para todos (fail closed) — es más
// seguro que dejarlo abierto por accidente en producción.
const NOTARY_COOKIE = 'firmaza_notary';
const NOTARY_SESSION_MS = 12 * 60 * 60 * 1000; // 12 horas
function signNotaryToken(expiresAt) {
  const secret = process.env.NOTARY_ACCESS_CODE || '';
  return crypto.createHmac('sha256', secret).update(`notary:${expiresAt}`).digest('hex');
}
function notaryCookieHeader(req, token, maxAgeSeconds) {
  const parts = [`${NOTARY_COOKIE}=${token}`, 'HttpOnly', 'Path=/', `Max-Age=${maxAgeSeconds}`, 'SameSite=Lax'];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}
function isNotaryAuthenticated(req) {
  const secret = process.env.NOTARY_ACCESS_CODE;
  if (!secret) return false;
  const cookies = parseCookies(req);
  const raw = cookies[NOTARY_COOKIE] || '';
  const [expiresAtStr, sig] = raw.split('.');
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt || !sig) return false;
  const expected = signNotaryToken(expiresAt);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Envío de correo — enlace mágico de acceso. REST directo (sin SDK) contra
// Resend (resend.com). Sin RESEND_API_KEY configurada, el enlace se imprime
// en la consola del servidor y se devuelve en la respuesta (modo demo), para
// poder probar el flujo completo sin cuenta de correo transaccional todavía.
// ---------------------------------------------------------------------------
function magicLinkEmailHtml(link) {
  // Tabla + estilos inline a propósito: así se ve consistente en Gmail,
  // Outlook, Apple Mail, etc. (el CSS externo del sitio no aplica aquí).
  // Paleta y tipografía calcadas de public/css/style.css.
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tu enlace de acceso — Firmaza</title>
</head>
<body style="margin:0;padding:0;background:#f2e9dc;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Tu enlace para entrar a tu cuenta de Firmaza — válido por 15 minutos.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2e9dc;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf9;border-radius:16px;overflow:hidden;box-shadow:0 2px 10px rgba(28,25,23,.08);">

          <!-- Encabezado -->
          <tr>
            <td style="background:#0f3d3e;padding:28px 32px;border-bottom:3px solid #f0a93a;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-right:9px;">
                    <div style="width:11px;height:11px;border-radius:50%;background:#e8583a;font-size:0;line-height:0;">&nbsp;</div>
                  </td>
                  <td>
                    <span style="font-family:Georgia,'Iowan Old Style',serif;font-weight:700;font-size:21px;color:#ffffff;letter-spacing:.2px;">Firmaza</span>
                  </td>
                </tr>
              </table>
              <div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12.5px;color:#c9ddda;margin-top:4px;">Notarios de confianza, en tu idioma</div>
            </td>
          </tr>

          <!-- Cuerpo -->
          <tr>
            <td style="padding:40px 36px 32px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
              <h1 style="margin:0 0 14px;font-family:Georgia,'Iowan Old Style',serif;font-weight:700;font-size:24px;line-height:1.3;color:#1c1917;">Tu enlace de acceso</h1>
              <p style="margin:0 0 28px;font-size:15.5px;line-height:1.6;color:#4a4440;">Pediste entrar a tu cuenta de Firmaza. Da clic en el botón para continuar — no necesitas contraseña.</p>

              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="border-radius:999px;background:#e8583a;">
                    <a href="${link}" style="display:inline-block;padding:14px 34px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-weight:700;font-size:15.5px;color:#ffffff;text-decoration:none;border-radius:999px;">Entrar a mi cuenta →</a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 4px;font-size:13px;color:#9a9188;">¿El botón no funciona? Copia y pega este enlace en tu navegador:</p>
              <p style="margin:0 0 28px;font-size:12.5px;color:#155e5f;word-break:break-all;">${link}</p>

              <div style="border-top:1px solid #ece3d8;padding-top:18px;">
                <p style="margin:0;font-size:13px;line-height:1.6;color:#9a9188;">Este enlace expira en 15 minutos y solo funciona una vez. Si tú no lo pediste, puedes ignorar este correo — tu cuenta sigue segura.</p>
              </div>
            </td>
          </tr>

          <!-- Pie -->
          <tr>
            <td style="background:#0f3d3e;padding:20px 32px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;text-align:center;">
              <p style="margin:0;font-size:12.5px;color:#9fc2bd;">Firmaza · Notarios de confianza, en tu idioma</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function magicLinkEmailText(link) {
  return `Tu enlace de acceso — Firmaza\n\nPediste entrar a tu cuenta de Firmaza. Abre este enlace para continuar (no necesitas contraseña):\n\n${link}\n\nEste enlace expira en 15 minutos y solo funciona una vez. Si tú no lo pediste, puedes ignorar este correo.\n\n— Firmaza, notarios de confianza en tu idioma`;
}

async function sendMagicLinkEmail(email, link) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[DEMO] Enlace mágico para ${email}: ${link}`);
    return { demo: true };
  }
  const from = process.env.EMAIL_FROM || 'Firmaza <onboarding@resend.dev>';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: email,
      subject: 'Tu enlace para entrar a Firmaza',
      html: magicLinkEmailHtml(link),
      text: magicLinkEmailText(link),
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`No se pudo enviar el correo (${resp.status}): ${errText}`);
  }
  return { demo: false };
}

// Señalización WebRTC en memoria: { roomId: [ {from, type, payload, ts}, ... ] }
// (No necesita persistencia real — son mensajes efímeros de una llamada en
// curso, no datos que deban sobrevivir un reinicio del servidor.)
// Object.create(null) en vez de {} para que una room llamada "constructor"
// o "__proto__" (el nombre viene del regex de la ruta, cualquiera lo elige)
// no choque con el prototipo de Object.
const rtcRooms = Object.create(null);
const RTC_ROOM_TTL_MS = 30 * 60 * 1000; // 30 minutos sin actividad -> se limpia
const RTC_MAX_ROOMS = 500; // tope simple contra quien cree miles de rooms vacías
// Antes una room, una vez creada, nunca se borraba y su arreglo de mensajes
// crecía sin límite hasta 200 (el .shift() de más abajo) pero el número de
// ROOMS en sí no tenía tope — cualquiera podía golpear /api/rtc/:room/signal
// con miles de nombres de room distintos y quedarse ahí para siempre en
// memoria. Esto limpia rooms inactivas y pone un tope duro al total.
setInterval(() => {
  const now = Date.now();
  for (const room of Object.keys(rtcRooms)) {
    const msgs = rtcRooms[room];
    const lastTs = msgs.length ? msgs[msgs.length - 1].ts : 0;
    if (now - lastTs > RTC_ROOM_TTL_MS) delete rtcRooms[room];
  }
}, 5 * 60 * 1000).unref();

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

// Una vez que una sesión ya se pagó (o ya se mandó a notarizar), el
// documento que se va a notarizar no debe poder cambiarse por debajo —
// antes /upload y /prepare-document no revisaban el estado de la sesión en
// absoluto, así que alguien podía pagar por notarizar un documento y luego,
// antes de que el notario lo revisara, reemplazarlo por otro distinto.
function documentLocked(s) {
  return Boolean(s.payment?.paidAt || s.proof?.transactionId || s.status === 'notarizacion_completada');
}

// Tope de longitud por campo para lo que termina convertido en PDF — el
// límite global de 25MB por request (ver readBody) no evita que un solo
// campo de texto (p. ej. el cuerpo de una carta personalizada) traiga
// varios megabytes de texto, lo que puede hacer que renderPdf() tarde
// mucho o genere un PDF enorme. 20,000 caracteres es generoso para
// cualquier carta o campo real de una plantilla.
const MAX_FIELD_LENGTH = 20000;
function fieldsWithinLimit(values) {
  for (const [key, value] of Object.entries(values || {})) {
    if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH) {
      return `El campo "${key}" es demasiado largo (máximo ${MAX_FIELD_LENGTH} caracteres).`;
    }
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  // Sin esto, los PDF (incluidos los que genera lib/pdf.js) se servían como
  // application/octet-stream y el navegador los descargaba en vez de
  // mostrarlos dentro del <iframe> de vista previa del documento.
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
// Host de la API de Square según el ambiente configurado — antes esta misma
// línea (SQUARE_ENV === 'production' ? ... : ...) estaba repetida en cada
// función que llamaba a Square; con el reembolso automático se iba a repetir
// una cuarta vez, así que se saca a una sola función.
function squareApiHost() {
  return process.env.SQUARE_ENV === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
}

async function createSquarePaymentLink({ amountCents, description, redirectUrl }) {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!token || !locationId) return { demo: true };

  const env = squareApiHost();
  const resp = await fetch(`https://${env}/v2/online-checkout/payment-links`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
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
  return { demo: false, url: json.payment_link.url, id: json.payment_link.id, orderId: json.payment_link.order_id };
}

// Verifica contra la propia API de Square (Orders API) que una orden
// realmente se pagó, en vez de confiar en que el navegador del firmante
// volvió a /pagar-exito/:id — ese regreso lo puede simular cualquiera con
// una petición POST directa a /confirm-payment, sin haber pagado nada. Un
// pedido queda en state "COMPLETED" solo cuando Square registró el pago
// completo; "OPEN" significa que todavía no se ha pagado.
// Docs: https://developer.squareup.com/reference/square/orders-api/retrieve-order
async function verifySquareOrderPaid(orderId, expectedAmountCents) {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token || !orderId) return { paid: false, reason: 'sin_order_id' };
  const env = squareApiHost();
  const resp = await fetch(`https://${env}/v2/orders/${orderId}`, {
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, 'Square-Version': '2024-08-21' },
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.errors?.[0]?.detail || 'Error consultando la orden en Square');
  const order = json.order;
  const paid = order?.state === 'COMPLETED';
  // Chequeo adicional de monto: la orden la creamos nosotros con un monto
  // fijo, así que esto es más una red de seguridad que una necesidad, pero
  // evita confiar ciegamente si algún día el monto se vuelve variable.
  const amountOk = !expectedAmountCents || order?.total_money?.amount === expectedAmountCents;
  return { paid: paid && amountOk, state: order?.state, order };
}

// El Refunds API de Square pide un payment_id, no un order_id — hay que
// sacarlo de order.tenders (lo que se usó para pagar la orden). Cada tender
// trae `payment_id` (poblado cuando se pagó vía la API de Payments v2, que es
// como cobra el checkout de Payment Links que usa createSquarePaymentLink) y
// también `id` (el id propio del tender, que en tenders más viejos coincide
// con el id del pago) — se prueban ambos por si acaso, empezando por el más
// específico.
function extractSquarePaymentId(order) {
  const tender = order?.tenders?.[0];
  return tender?.payment_id || tender?.id || null;
}

// Reembolsa (total o parcial) un pago ya confirmado de Square.
// Docs: https://developer.squareup.com/reference/square/refunds-api/refund-payment
// `idempotencyKey` debe ser estable por reembolso (no aleatorio) para que,
// si esta función se llama dos veces para el mismo caso (reintento de red,
// el webhook de Proof.com llegando más de una vez, etc.), Square reconozca
// la segunda llamada como la MISMA solicitud en vez de cobrar... perdón,
// devolver el dinero dos veces.
async function refundSquarePayment({ paymentId, amountCents, reason, idempotencyKey }) {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) return { demo: true };
  if (!paymentId) throw new Error('Falta el payment_id de Square para poder reembolsar.');
  const env = squareApiHost();
  const resp = await fetch(`https://${env}/v2/refunds`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-08-21',
    },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      payment_id: paymentId,
      amount_money: { amount: amountCents, currency: 'USD' },
      reason: (reason || '').slice(0, 192), // Square limita "reason" a 192 caracteres
    }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.errors?.[0]?.detail || 'Error pidiendo el reembolso a Square');
  return { demo: false, refundId: json.refund?.id, status: json.refund?.status };
}

// Texto legible por caso de reembolso automático — se usa tanto en el
// historial de la sesión como en el correo al firmante.
const REFUND_REASONS = {
  declined: 'No fue posible verificar tu identidad con el notario (control de seguridad de Proof.com no superado)',
  expired: 'La sesión de notarización venció sin que llegaras a conectarte con un notario',
  canceled: 'La sesión de notarización fue cancelada',
  admin_manual: 'Reembolso manual solicitado',
};

function refundNotificationEmailHtml({ amount, reasonLabel }) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f1ea;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1ea;padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="background:#0f3d3e;padding:24px 32px;">
              <div style="font-family:Georgia,'Iowan Old Style',serif;font-weight:700;font-size:20px;color:#ffffff;">Firmaza</div>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 32px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
              <h1 style="margin:0 0 14px;font-family:Georgia,'Iowan Old Style',serif;font-weight:700;font-size:22px;line-height:1.3;color:#1c1917;">Te devolvimos tu pago</h1>
              <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#4a4440;">No pudimos completar tu notarización, así que te reembolsamos <strong>$${amount.toFixed(2)}</strong> a la misma tarjeta con la que pagaste.</p>
              <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#6b6560;">Motivo: ${reasonLabel}.</p>
              <p style="margin:0 0 4px;font-size:13px;line-height:1.6;color:#9a9188;">El reembolso puede tardar de 7 a 10 días hábiles en reflejarse en tu estado de cuenta. Si quieres intentar de nuevo, puedes volver a iniciar el proceso cuando quieras.</p>
            </td>
          </tr>
          <tr>
            <td style="background:#0f3d3e;padding:20px 32px;text-align:center;">
              <p style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12.5px;color:#9fc2bd;">Firmaza · Notarios de confianza, en tu idioma</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function refundNotificationEmailText({ amount, reasonLabel }) {
  return `Te devolvimos tu pago — Firmaza\n\nNo pudimos completar tu notarización, así que te reembolsamos $${amount.toFixed(2)} a la misma tarjeta con la que pagaste.\n\nMotivo: ${reasonLabel}.\n\nEl reembolso puede tardar de 7 a 10 días hábiles en reflejarse en tu estado de cuenta. Si quieres intentar de nuevo, puedes volver a iniciar el proceso cuando quieras.\n\n— Firmaza, notarios de confianza en tu idioma`;
}

async function sendRefundNotificationEmail(email, { amount, reasonLabel }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !email) {
    console.log(`[DEMO] Correo de reembolso para ${email}: $${amount.toFixed(2)} — ${reasonLabel}`);
    return { demo: true };
  }
  const from = process.env.EMAIL_FROM || 'Firmaza <onboarding@resend.dev>';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: email,
      subject: 'Te devolvimos tu pago — Firmaza',
      html: refundNotificationEmailHtml({ amount, reasonLabel }),
      text: refundNotificationEmailText({ amount, reasonLabel }),
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`No se pudo enviar el correo de reembolso (${resp.status}): ${errText}`);
  }
  return { demo: false };
}

// Punto central del reembolso automático — se llama desde el webhook de
// Proof.com Y desde el polling de /proof-status (por si el webhook nunca
// llega o llega tarde), así que tiene que ser segura de llamar más de una
// vez para la MISMA sesión sin reembolsar dos veces.
//
// Reglas de elegibilidad (a propósito, todas tienen que cumplirse):
// - El pago fue real con Square (mode 'square' con paidAt) — un pago demo no
//   tiene nada que reembolsar.
// - Todavía no se había reembolsado esta sesión (s.payment.refund).
// - Tenemos guardado el payment_id de Square (se captura en /confirm-payment
//   justo después de verificar el pago — ver ahí).
//
// `reasonCode` es una clave de REFUND_REASONS ('declined' | 'expired' |
// 'canceled' | 'admin_manual'), no el string crudo del evento/estado de
// Proof.com, para que el webhook y el polling (que usan formatos de string
// distintos — 'transaction.declined' vs 'declined') se normalicen antes de
// llegar aquí.
async function refundSessionIfEligible(s, reasonCode) {
  if (!s || s.payment?.mode !== 'square' || !s.payment?.paidAt) return null;
  if (s.payment?.refund) return null; // ya reembolsada — no hacer nada de nuevo
  const paymentId = s.payment?.paymentId;
  const reasonLabel = REFUND_REASONS[reasonCode] || REFUND_REASONS.canceled;
  if (!paymentId) {
    // No debería pasar (se guarda en /confirm-payment), pero si pasa hay que
    // dejar rastro claro en vez de fallar en silencio — Ricardo puede
    // reembolsar a mano desde el dashboard de Square usando el orderId.
    s.history.push({ event: 'reembolso_omitido_sin_payment_id', at: new Date().toISOString(), reasonCode });
    console.warn(`Sesión ${s.id}: no se pudo reembolsar automáticamente — falta payment_id (orderId: ${s.payment?.orderId})`);
    return null;
  }
  const amountCents = Math.round((s.payment.amount || 0) * 100);
  try {
    const result = await refundSquarePayment({
      paymentId,
      amountCents,
      reason: reasonLabel,
      idempotencyKey: `refund:${s.id}`, // estable — ver nota en refundSquarePayment
    });
    s.payment.refund = {
      mode: result.demo ? 'demo' : 'square',
      refundId: result.refundId || null,
      status: result.status || null,
      amountCents,
      reasonCode,
      at: new Date().toISOString(),
    };
    s.history.push({ event: 'reembolso_automatico', at: new Date().toISOString(), reasonCode, amount: amountCents / 100 });
    if (s.email) {
      try {
        await sendRefundNotificationEmail(s.email, { amount: amountCents / 100, reasonLabel });
      } catch (emailErr) {
        // El reembolso YA se hizo — que falle el correo de aviso no debe
        // hacer parecer que el reembolso también falló.
        console.error(`Sesión ${s.id}: reembolso hecho pero falló el correo de aviso:`, emailErr.message);
      }
    }
    return s.payment.refund;
  } catch (e) {
    s.history.push({ event: 'reembolso_fallido', at: new Date().toISOString(), reasonCode, error: e.message });
    console.error(`Sesión ${s.id}: falló el reembolso automático:`, e.message);
    return null;
  }
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

// Adivina el content-type de un archivo subido a partir de su nombre, para
// poder servirlo de vuelta con el header correcto (el navegador decide si
// mostrarlo o descargarlo según esto).
function guessContentType(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// Tipos permitidos para lo que un firmante SUBE (documento a notarizar,
// firma PNG) y para lo que /uploads/:id sirve de vuelta. Antes, /upload
// tomaba el Content-Type directo del prefijo "data:TIPO;base64," que manda
// el propio cliente, sin validarlo contra nada — cualquiera podía crear una
// sesión gratis (no requiere autenticación) y subir un "documento" con
// Content-Type "text/html" (o "image/svg+xml", que también ejecuta
// <script>). GET /uploads/:id no requiere autenticación (tiene que poder
// sin ella: Proof.com necesita poder descargar el documento) y devolvía ese
// Content-Type tal cual — es decir, cualquiera podía alojar HTML/JS
// arbitrario en el propio dominio firmaza.com y mandarle el enlace a otra
// persona (phishing "mira tu documento notarizado"): quien lo abriera
// ejecutaba ese script con el origen real del sitio, con acceso a fetch()
// autenticado contra /api/auth/me, /api/cuenta/*, /api/queue, etc. (las
// cookies son HttpOnly, pero eso no bloquea fetch() same-origin). Ahora
// cualquier tipo fuera de esta lista blanca se guarda/sirve como
// application/octet-stream (el navegador lo descarga, nunca lo ejecuta).
const SAFE_UPLOAD_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);
function sanitizeUploadContentType(candidate) {
  const normalized = String(candidate || '').split(';')[0].trim().toLowerCase();
  return SAFE_UPLOAD_CONTENT_TYPES.has(normalized) ? normalized : 'application/octet-stream';
}

async function handleApi(req, res, pathname, query) {
  // --- Cuentas de cliente (enlace mágico, sin contraseña) --------------
  if (pathname === '/api/auth/request-link' && req.method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return send(res, 400, { error: 'Escribe un correo válido' });
    }
    const recentCount = await db.countActiveMagicLinksForEmail(email);
    if (recentCount >= 5) {
      return send(res, 429, { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await db.createMagicLink(token, email, expiresAt);
    const origin = trustedOrigin(req);
    const link = `${origin}/auth/verify?token=${token}`;
    try {
      const result = await sendMagicLinkEmail(email, link);
      return send(res, 200, { ok: true, demo: !!result.demo, devLink: result.demo ? link : undefined });
    } catch (e) {
      // No exponemos el error crudo del proveedor de correo (puede incluir
      // detalles internos de la cuenta) — lo registramos en el servidor y
      // mostramos al cliente un mensaje genérico y accionable.
      console.error('[email] No se pudo enviar el enlace mágico:', e.message);
      return send(res, 500, { error: 'No pudimos enviarte el correo en este momento. Inténtalo de nuevo en unos minutos, o escríbenos si el problema sigue.' });
    }
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const client = await getClientFromRequest(req);
    if (!client) return send(res, 200, { authenticated: false });
    return send(res, 200, { authenticated: true, email: client.email, nucleo: client.nucleo || db.defaultNucleo() });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (token) await db.deleteLoginSession(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookieHeader(req, '', 0) });
  }

  // --- Acceso del panel de notario (ver nota junto a isNotaryAuthenticated) ---
  if (pathname === '/api/notary/login' && req.method === 'POST') {
    if (isNotaryLoginRateLimited(req)) {
      return send(res, 429, { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
    }
    const body = await readBody(req);
    const secret = process.env.NOTARY_ACCESS_CODE;
    if (!secret || !body.code || !timingSafeStringEqual(String(body.code), secret)) {
      return send(res, 401, { error: 'Código incorrecto' });
    }
    const expiresAt = Date.now() + NOTARY_SESSION_MS;
    const sig = signNotaryToken(expiresAt);
    return send(res, 200, { ok: true }, {
      'Set-Cookie': notaryCookieHeader(req, `${expiresAt}.${sig}`, NOTARY_SESSION_MS / 1000),
    });
  }

  if (pathname === '/api/notary/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': notaryCookieHeader(req, '', 0) });
  }

  if (pathname === '/api/notary/me' && req.method === 'GET') {
    return send(res, 200, { authenticated: isNotaryAuthenticated(req) });
  }

  if (pathname === '/api/cuenta/nucleo' && req.method === 'GET') {
    const client = await getClientFromRequest(req);
    if (!client) return send(res, 401, { error: 'No autenticado' });
    return send(res, 200, { nucleo: client.nucleo || db.defaultNucleo() });
  }

  if (pathname === '/api/cuenta/nucleo' && (req.method === 'PUT' || req.method === 'POST')) {
    const client = await getClientFromRequest(req);
    if (!client) return send(res, 401, { error: 'No autenticado' });
    const body = await readBody(req);
    const nucleo = sanitizeNucleo(body);
    await db.updateClientNucleo(client.email, nucleo);
    return send(res, 200, { nucleo });
  }

  if (pathname === '/api/cuenta/documentos' && req.method === 'GET') {
    const client = await getClientFromRequest(req);
    if (!client) return send(res, 401, { error: 'No autenticado' });
    const clientSessions = await db.getSessionsByEmail(client.email);
    const docs = clientSessions
      .filter((s) => s.document)
      .map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        status: s.status,
        titulo: (s.document && s.document.originalName) || 'Documento',
        archivo: (s.document && s.document.storedAs) || null,
        firmado: !!s.signature,
        templateId: (s.document && s.document.templateId) || null,
        mode: (s.document && s.document.mode) || null,
        preparedByFirmaza: !!(s.document && s.document.preparedByFirmaza),
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return send(res, 200, { documentos: docs });
  }

  // Devuelve los datos (plantilla + valores que el cliente escribió, o la
  // carta dictada) de un documento pasado que Firmaza preparó, para
  // prellenar el formulario de un documento NUEVO en /app con esos mismos
  // datos y que el cliente solo tenga que hacer cambios ligeros — Fase 2 de
  // cuentas de cliente. Solo el dueño del documento (mismo correo que la
  // sesión) puede leer esto; los documentos que el cliente subió por su
  // cuenta (sin preparedByFirmaza) no tienen datos estructurados que
  // reutilizar, así que no aplican aquí.
  const reuseMatch = pathname.match(/^\/api\/cuenta\/documentos\/([a-f0-9]+)\/reusar$/);
  if (reuseMatch && req.method === 'GET') {
    const client = await getClientFromRequest(req);
    if (!client) return send(res, 401, { error: 'No autenticado' });
    const s = await db.getSession(reuseMatch[1]);
    const ownsIt = s && (s.email || '').trim().toLowerCase() === client.email;
    if (!s || !ownsIt || !s.document || !s.document.preparedByFirmaza || !s.document.inputs) {
      return send(res, 404, { error: 'No encontramos ese documento para reutilizar' });
    }
    return send(res, 200, {
      mode: s.document.mode,
      templateId: s.document.templateId || null,
      inputs: s.document.inputs,
    });
  }

  // --- Sesiones -------------------------------------------------------
  if (pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readBody(req);
    const id = newId();
    const client = await getClientFromRequest(req);
    const s = {
      id,
      createdAt: new Date().toISOString(),
      signerName: body.signerName || (client && client.nucleo && client.nucleo.nombreCompleto) || '',
      email: body.email || (client && client.email) || '',
      language: body.language || 'es',
      status: 'iniciada',
      document: null,
      identity: null,
      payment: null,
      signature: null,
      notaryId: null,
      history: [{ event: 'sesion_creada', at: new Date().toISOString() }],
    };
    await db.saveSession(s);
    // Ver la nota junto a verifySessionOwnership() más arriba: este token es
    // lo único que distingue, de aquí en adelante, a quien creó la sesión de
    // cualquier otra persona que llegue a conocer su id.
    const ownerToken = crypto.randomBytes(24).toString('hex');
    await db.setSessionOwnerToken(id, ownerToken);
    return send(res, 200, { session: s }, { 'Set-Cookie': sessionOwnerCookieHeader(req, id, ownerToken) });
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([a-f0-9]+)(\/.*)?$/);
  if (sessionMatch) {
    const id = sessionMatch[1];
    const sub = sessionMatch[2] || '';

    // El GET simple es de solo lectura — no pasa por withSessionLock() para
    // no pagar el costo de una transacción/advisory lock en cada poll del
    // estado de la sesión (el frontend hace polling de esto mientras
    // espera al notario o a que Proof.com confirme la notarización).
    if (sub === '' && req.method === 'GET') {
      const s = await db.getSession(id);
      if (!s) return send(res, 404, { error: 'Sesión no encontrada' });
      if (!(await verifySessionOwnership(req, id))) {
        return send(res, 403, { error: 'No autorizado para ver esta sesión.' });
      }
      return send(res, 200, { session: s });
    }

    // Todas las demás sub-rutas leen, modifican y guardan la sesión — se
    // ejecutan dentro de withSessionLock() para que dos peticiones que
    // mutan la MISMA sesión casi al mismo tiempo (doble clic en "pagar",
    // el navegador reintentando una petición que en realidad sí llegó,
    // un webhook de Proof.com cruzándose con el polling de /proof-status,
    // etc.) no se pisen entre sí. Ver el comentario de withSessionLock()
    // en lib/db.js para el porqué completo.
    return db.withSessionLock(id, async (txn) => {
      const s = await txn.getSession();
      if (!s) return send(res, 404, { error: 'Sesión no encontrada' });

      // /claim lo usa el NOTARIO, no el firmante dueño de la sesión — un
      // notario nunca tiene (ni debe tener) la cookie de dueño de la sesión
      // que está tomando de la cola. Su propio control de acceso es
      // isNotaryAuthenticated() más abajo, así que /claim se salta esta
      // verificación a propósito.
      if (sub !== '/claim' && !(await verifySessionOwnership(req, id))) {
        return send(res, 403, { error: 'No autorizado para modificar esta sesión.' });
      }

      if (sub === '/upload' && req.method === 'POST') {
        if (documentLocked(s)) {
          return send(res, 409, { error: 'Esta sesión ya está pagada/notarizada — no se puede reemplazar el documento.' });
        }
        const body = await readBody(req);
        if (!body.filename || !body.base64) return send(res, 400, { error: 'Falta filename o base64' });
        const dataUriMatch = /^data:([^;]+);base64,/.exec(body.base64);
        const contentType = sanitizeUploadContentType(dataUriMatch ? dataUriMatch[1] : guessContentType(body.filename));
        const base64Data = body.base64.replace(/^data:.*;base64,/, '');
        const safeName = `${id}-${Date.now()}-${body.filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
        await db.saveFile(safeName, Buffer.from(base64Data, 'base64'), contentType);
        s.document = { originalName: body.filename, storedAs: safeName, uploadedAt: new Date().toISOString() };
        // El nombre/correo del firmante se capturan en este mismo paso del flujo
        // (paso 0 en app.js); los guardamos aquí porque /api/sessions se crea
        // antes de que el usuario los escriba.
        if (body.signerName) s.signerName = body.signerName;
        if (body.email) s.email = body.email;
        s.status = 'documento_subido';
        s.history.push({ event: 'documento_subido', at: new Date().toISOString() });
        await txn.saveSession(s);
        return send(res, 200, { session: s });
      }

      // Genera un documento PDF para el firmante (plantilla llenada por él
      // mismo, o una carta cuyo texto completo escribió él) y lo deja como si
      // lo hubiera subido — mismo estado/flujo que /upload de aquí en adelante.
      // IMPORTANTE: Firmaza NUNCA decide el contenido legal aquí, solo lo
      // acomoda en formato de documento — ver aviso en lib/documentTemplates.js.
      if (sub === '/prepare-document' && req.method === 'POST') {
        if (documentLocked(s)) {
          return send(res, 409, { error: 'Esta sesión ya está pagada/notarizada — no se puede reemplazar el documento.' });
        }
        const body = await readBody(req);
        // renderFor(lang, tr) → bloques del PDF en ese idioma. Ver
        // "IDIOMAS" en lib/documentTemplates.js.
        let renderFor, docTitle, templateId = null, inputs = null;
        try {
          if (body.mode === 'template') {
            const template = docTemplates.getTemplate(body.templateId);
            if (!template) return send(res, 400, { error: 'Plantilla no encontrada' });
            const values = body.values || {};
            const lengthError = fieldsWithinLimit(values);
            if (lengthError) return send(res, 400, { error: lengthError });
            const missing = docTemplates.validateValues(template, values);
            if (missing.length) {
              return send(res, 400, {
                error: `Falta completar: ${missing.map((f) => f.label).join(', ')}`,
                missingFields: missing,
              });
            }
            // Segundo firmante (permiso de viaje): Proof.com le manda su propia
            // invitación, así que su correo tiene que ser válido y distinto
            // del de quien llena el formulario.
            for (const extra of docTemplates.additionalSigners(template.id, values)) {
              const mainEmail = String(body.email || s.email || '').trim().toLowerCase();
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extra.email)) {
                return send(res, 400, { error: `El correo de ${extra.name} no es válido.`, missingFields: [{ key: 'segundoCorreo', label: 'Correo del otro firmante' }] });
              }
              if (extra.email.toLowerCase() === mainEmail) {
                return send(res, 400, { error: 'El otro firmante necesita un correo distinto al tuyo: cada firmante recibe su propia invitación para notarizar.', missingFields: [{ key: 'segundoCorreo', label: 'Correo del otro firmante' }] });
              }
            }
            renderFor = (lang, tr) => template.render(values, { lang, tr });
            docTitle = template.name;
            templateId = template.id;
            // Guardamos los valores que el cliente escribió (no solo el PDF ya
            // renderizado) para que más adelante pueda "reutilizar" este
            // documento como base de uno nuevo con cambios ligeros — ver
            // GET /api/cuenta/documentos/:id/reusar.
            inputs = values;
          } else if (body.mode === 'custom') {
            const cuerpo = String(body.cuerpo || '').trim();
            if (!cuerpo) return send(res, 400, { error: 'Escribe el texto de tu carta' });
            // `autor` (que termina en el PDF, ver renderCustomLetter) sale de
            // s.signerName o, si no hay, de body.autor — ambos texto que
            // controla quien llama a esta ruta. Antes fieldsWithinLimit()
            // solo revisaba titulo/cuerpo/lugar: un autor (o un
            // body.signerName, que es lo que termina poblando s.signerName)
            // de varios megabytes se colaba sin límite y caía en el mismo
            // problema — PDF lento o enorme — que este límite existe para
            // evitar en primer lugar.
            const autor = s.signerName || body.autor || '';
            const lengthError = fieldsWithinLimit({ titulo: body.titulo, cuerpo, lugar: body.lugar, autor, signerName: body.signerName });
            if (lengthError) return send(res, 400, { error: lengthError });
            renderFor = (lang, tr) => docTemplates.renderCustomLetter({
              titulo: body.titulo,
              cuerpo,
              autor,
              lugar: body.lugar,
            }, { lang, tr });
            docTitle = body.titulo || 'Carta';
            inputs = { titulo: body.titulo || '', cuerpo, lugar: body.lugar || '' };
          } else {
            return send(res, 400, { error: 'mode debe ser "template" o "custom"' });
          }
          // --- Idiomas ------------------------------------------------------
          // El cliente escribe en español. Se generan de una vez las dos
          // versiones (inglés y español) para que en la vista previa pueda
          // cambiar entre ellas al instante y elegir con cuál se queda; el
          // documento que queda activo por defecto es el INGLÉS. El permiso
          // de viaje para menores genera solo la versión bilingüe.
          const langKey = templateId || 'carta_propia';
          const pending = docTemplates.fieldsToTranslate(langKey, inputs);
          let translation;
          try {
            translation = await translateFields(pending);
          } catch (e) {
            console.error('[translate]', e.message);
            return send(res, 502, { error: 'No pudimos traducir tu documento en este momento. Intenta de nuevo en un minuto.' });
          }
          const langs = docTemplates.ALWAYS_BILINGUAL.has(langKey) ? ['bi'] : ['en', 'es'];
          const stamp = Date.now();
          const versions = {};
          for (const lang of langs) {
            const pdfBuffer = renderPdf(renderFor(lang, translation.en));
            const name = `${id}-preparado-${stamp}-${lang}.pdf`;
            await db.saveFile(name, pdfBuffer, 'application/pdf');
            versions[lang] = name;
          }
          const defaultLang = langs[0]; // 'en' o 'bi'
          // Lo que el cliente revisa en la vista previa: lo que escribió, cómo
          // quedó en inglés y la traducción de regreso al español.
          const review = (docTemplates.REVIEW_FIELDS[langKey] || [])
            .filter(([key]) => pending[key])
            .map(([key, label]) => ({
              key, label,
              original: pending[key],
              en: translation.en[key],
              back: translation.back[key],
            }));
          s.document = {
            originalName: `${docTitle}.pdf`,
            storedAs: versions[defaultLang],
            uploadedAt: new Date().toISOString(),
            preparedByFirmaza: true,
            mode: body.mode,
            templateId,
            inputs,
            language: defaultLang,
            versions,
            translationMode: translation.mode, // 'real' | 'demo' | 'none'
            review,
            // Solo hace falta aprobar si hay versión en inglés con texto traducido.
            translationApproved: review.length === 0,
          };
          // Para mostrar el total correcto en el paso de pago (el cobro real
          // lo vuelve a calcular /checkout del lado del servidor).
          s.document.price = priceForSession(s);
          if (body.signerName) s.signerName = body.signerName;
          if (body.email) s.email = body.email;
          s.status = 'documento_subido';
          s.history.push({ event: 'documento_preparado_por_firmaza', at: new Date().toISOString(), mode: body.mode, templateId });
          await txn.saveSession(s);
          return send(res, 200, { session: s });
        } catch (e) {
          return send(res, 500, { error: e.message });
        }
      }

      // El firmante elige con qué versión se queda ('en' o 'es') y, si se
      // queda con la de inglés, confirma que revisó la traducción. Cambia
      // `storedAs` — que es el archivo que se paga y se manda a notarizar.
      if (sub === '/document-language' && req.method === 'POST') {
        if (documentLocked(s)) {
          return send(res, 409, { error: 'Esta sesión ya está pagada/notarizada — no se puede cambiar el documento.' });
        }
        const d = s.document;
        if (!d || !d.versions) return send(res, 400, { error: 'Este documento no tiene versiones de idioma.' });
        const body = await readBody(req);
        const lang = d.versions.bi ? 'bi' : body.lang;
        if (!d.versions[lang]) return send(res, 400, { error: 'Idioma no válido.' });
        const needsApproval = lang !== 'es' && (d.review || []).length > 0;
        if (needsApproval && body.approved !== true) {
          return send(res, 400, { error: 'Confirma que revisaste la traducción antes de continuar.' });
        }
        d.language = lang;
        d.storedAs = d.versions[lang];
        if (needsApproval) {
          d.translationApproved = true;
          d.translationApprovedAt = new Date().toISOString();
        }
        s.history.push({ event: 'idioma_documento_elegido', at: new Date().toISOString(), language: lang });
        await txn.saveSession(s);
        return send(res, 200, { session: s });
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
        await txn.saveSession(s);
        return send(res, 200, { session: s });
      }

      if (sub === '/checkout' && req.method === 'POST') {
        // Ya pagada — no crear otro cargo, solo confirmar lo que ya hay.
        // (Antes esta ruta no revisaba esto: un doble clic o un POST repetido
        // podía generar más de un payment link/orden para la misma sesión.)
        if (s.payment?.paidAt) {
          return send(res, 200, { demo: s.payment.mode === 'demo', session: s });
        }
        // Un documento en inglés con texto traducido automáticamente no se
        // cobra ni se notariza sin que el firmante haya aprobado la traducción.
        if (s.document?.versions && s.document.language !== 'es' && !s.document.translationApproved) {
          return send(res, 400, { error: 'Primero revisa y aprueba la traducción de tu documento.' });
        }
        await readBody(req); // se descarta a propósito — ver nota abajo sobre PRICE_CATALOG
        // El monto y la descripción del cargo NUNCA deben venir del cliente:
        // antes se tomaban directo de body.amount/body.description, así que
        // cualquiera podía mandar {amount: 0.01} y pagar un centavo por una
        // notarización de $39. El servidor decide el precio a partir de un
        // catálogo fijo (ver PRICE_CATALOG arriba); hoy solo existe un
        // producto real en el flujo de /app.
        // Incluye firmantes adicionales (ver priceForSession): $39 base,
        // $79 si firman dos personas.
        const item = priceForSession(s);
        const amountCents = item.amountCents;
        const origin = trustedOrigin(req);
        try {
          const result = await createSquarePaymentLink({
            amountCents,
            description: item.description,
            redirectUrl: `${origin}/app#/pagar-exito/${id}`,
          });
          if (result.demo) {
            s.payment = { mode: 'demo', amount: amountCents / 100, paidAt: new Date().toISOString() };
            s.status = 'pagado_demo';
            s.history.push({ event: 'pago_demo', at: new Date().toISOString() });
            await txn.saveSession(s);
            return send(res, 200, { demo: true, session: s });
          }
          // orderIds acumula TODAS las órdenes creadas para esta sesión (no
          // solo la más reciente), para que /confirm-payment pueda reconocer
          // un pago aunque haya sido en una orden anterior a la última creada
          // — ver nota junto a /confirm-payment.
          const priorOrderIds = s.payment?.orderIds || [];
          s.payment = {
            mode: 'square',
            paymentLinkId: result.id,
            orderId: result.orderId,
            orderIds: [...priorOrderIds, result.orderId].filter(Boolean),
            amount: amountCents / 100,
          };
          await txn.saveSession(s);
          return send(res, 200, { demo: false, url: result.url });
        } catch (e) {
          return send(res, 500, { error: e.message });
        }
      }

      // Square redirige aquí (`redirectUrl` de arriba) cuando el firmante
      // termina el checkout, así que el frontend llama esta ruta apenas
      // detecta el regreso (#/pagar-exito/:id) para dejar la sesión marcada
      // como pagada y poder seguir directo a /notarize.
      //
      // Ese regreso del navegador NO es prueba de pago por sí solo — cualquiera
      // puede mandar un POST directo a esta ruta sin haber pagado nada. Por
      // eso, antes de marcar la sesión como pagada, se confirma con la propia
      // API de Square (Orders API) que la orden asociada de verdad quedó en
      // estado COMPLETED. Ver verifySquareOrderPaid() arriba.
      if (sub === '/confirm-payment' && req.method === 'POST') {
        if (s.payment?.mode === 'demo') {
          return send(res, 200, { session: s });
        }
        if (s.payment?.paidAt) {
          // Ya se había verificado en una llamada anterior (p. ej. el
          // firmante recargó la página de éxito) — no hace falta repetir la
          // consulta a Square.
          return send(res, 200, { session: s });
        }
        try {
          const expectedAmountCents = s.payment?.amount != null ? Math.round(s.payment.amount * 100) : null;
          // Revisa TODAS las órdenes creadas para esta sesión, no solo
          // s.payment.orderId (la más reciente). Antes, si /checkout se
          // llamaba dos veces (doble clic, reintento de red) se generaban dos
          // órdenes de Square distintas y s.payment.orderId quedaba apuntando
          // solo a la última; si el firmante había pagado la primera, esta
          // ruta nunca lo encontraba y la sesión quedaba huérfana sin poder
          // avanzar aunque sí se hubiera cobrado.
          const orderIdsToCheck = (s.payment?.orderIds?.length ? s.payment.orderIds : [s.payment?.orderId]).filter(Boolean);
          let verification = { paid: false, state: null };
          for (const orderId of orderIdsToCheck) {
            // Cada orden se revisa en su propio try/catch: antes, si
            // verifySquareOrderPaid() lanzaba una excepción para UNA orden
            // (p. ej. una orden vieja o inválida que Square ya no reconoce),
            // el bucle completo abortaba con un 500 y ni siquiera se llegaba
            // a revisar las demás órdenes de la sesión — pudiendo dejar sin
            // detectar un pago real que sí estaba en una orden posterior.
            try {
              verification = await verifySquareOrderPaid(orderId, expectedAmountCents);
            } catch (perOrderErr) {
              console.error(`Error verificando la orden de Square ${orderId}:`, perOrderErr.message);
              continue;
            }
            if (verification.paid) { s.payment = { ...(s.payment || {}), orderId }; break; }
          }
          if (!verification.paid) {
            return send(res, 402, {
              error: 'Todavía no detectamos tu pago con Square. Si acabas de pagar, espera unos segundos e inténtalo de nuevo.',
              state: verification.state || null,
              session: s,
            });
          }
          // Guardamos el payment_id (no solo el orderId) porque el Refunds
          // API de Square pide el ID del pago, no el de la orden — sin esto,
          // si más adelante Proof.com rechaza la notarización, no habría
          // forma de reembolsar automáticamente (ver refundSessionIfEligible
          // y extractSquarePaymentId).
          const paymentId = extractSquarePaymentId(verification.order);
          if (!paymentId) {
            console.warn(`Sesión ${id}: pago confirmado pero no se encontró payment_id en la orden de Square ${s.payment.orderId} — el reembolso automático no podrá hacerse solo.`);
          }
          s.payment = { ...(s.payment || {}), mode: 'square', paidAt: new Date().toISOString(), paymentId };
          s.status = 'pagado_square';
          s.history.push({ event: 'pago_square_confirmado', at: new Date().toISOString() });
          await txn.saveSession(s);
          return send(res, 200, { session: s });
        } catch (e) {
          return send(res, 500, { error: e.message });
        }
      }

      if (sub === '/notarize' && req.method === 'POST') {
        if (!s.document) return send(res, 400, { error: 'Primero hay que subir el documento' });
        if (!s.email) return send(res, 400, { error: 'La sesión no tiene correo del firmante' });
        // Sin esto, cualquiera con el id de una sesión (o creando una propia)
        // podía llamar /notarize directo sin pasar por /checkout ni
        // /confirm-payment, y eso crea una transacción real y de pago en
        // Proof.com — es decir, notarizaciones gratis a costa de Firmaza.
        if (!s.payment?.paidAt) {
          return send(res, 402, { error: 'Esta sesión todavía no tiene un pago confirmado.' });
        }
        const origin = trustedOrigin(req);
        const documentUrl = `${origin}/uploads/${s.document.storedAs}`;
        try {
          const result = await proofRon.createRonSession({
            sessionId: id,
            signerName: s.signerName,
            signerEmail: s.email,
            documentUrl,
            // Otros firmantes del mismo documento (p. ej. el otro padre/madre
            // en el permiso de viaje) — ver additionalSigners().
            additionalSigners: docTemplates.additionalSigners(s.document.templateId, s.document.inputs),
          });
          if (!result) {
            // Sin PROOF_API_KEY configurada: seguimos en modo demo (cola interna + WebRTC).
            s.history.push({ event: 'notarize_modo_demo', at: new Date().toISOString() });
            await txn.saveSession(s);
            return send(res, 200, { demo: true, session: s });
          }
          s.proof = {
            transactionId: result.transactionId,
            status: result.status,
            createdAt: new Date().toISOString(),
          };
          s.status = 'enviado_a_notario_proof';
          s.history.push({ event: 'enviado_a_proof', at: new Date().toISOString(), transactionId: result.transactionId });
          await txn.saveSession(s);
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
          // 'declined' (no pasó el control de identidad/seguridad) y
          // 'expired' (nunca se conectó) disparan el reembolso automático —
          // ver refundSessionIfEligible. Este polling es la red de
          // seguridad por si el webhook de /webhooks/proof nunca llega o
          // llega tarde; refundSessionIfEligible ya es segura de llamar más
          // de una vez (revisa s.payment.refund antes de hacer nada).
          if (tx?.status === 'completed' || tx?.status === 'released') {
            s.status = 'notarizacion_completada';
          } else if (tx?.status === 'declined') {
            s.status = 'notarizacion_rechazada';
            await refundSessionIfEligible(s, 'declined');
          } else if (tx?.status === 'expired') {
            s.status = 'notarizacion_rechazada';
            await refundSessionIfEligible(s, 'expired');
          }
          await txn.saveSession(s);
          return send(res, 200, { session: s, transaction: tx });
        } catch (e) {
          return send(res, 500, { error: e.message });
        }
      }

      if (sub === '/claim' && req.method === 'POST') {
        if (!isNotaryAuthenticated(req)) return send(res, 401, { error: 'No autenticado como notario' });
        const body = await readBody(req);
        s.notaryId = body.notaryId;
        s.status = 'en_sesion_con_notario';
        s.roomId = s.roomId || newId();
        s.history.push({ event: 'notario_tomo_sesion', at: new Date().toISOString(), notaryId: body.notaryId });
        await txn.saveSession(s);
        return send(res, 200, { session: s });
      }

      if (sub === '/sign' && req.method === 'POST') {
        // Antes esta ruta no tenía NINGÚN candado de estado: se podía llamar
        // en cualquier momento (sin haber pagado, sin haber sido notarizada)
        // y, peor, se podía volver a llamar después de ya firmada,
        // reemplazando la firma/PNG y el auditHash ya registrados — es decir,
        // cualquiera con el id de la sesión (ver nota sobre IDOR en
        // documentLocked) podía alterar el registro legal de la firma en
        // cualquier momento, no solo leerlo. Ahora exige pago confirmado
        // (igual que /notarize) y rechaza (409) si la sesión ya tiene firma.
        if (!s.payment?.paidAt) {
          return send(res, 402, { error: 'Esta sesión todavía no tiene un pago confirmado.' });
        }
        if (s.signature) {
          return send(res, 409, { error: 'Esta sesión ya tiene una firma registrada — no se puede reemplazar.' });
        }
        const body = await readBody(req);
        if (!body.signaturePng) return send(res, 400, { error: 'Falta signaturePng' });
        const safeName = `${id}-firma-${Date.now()}.png`;
        await db.saveFile(safeName, Buffer.from(body.signaturePng.replace(/^data:.*;base64,/, ''), 'base64'), 'image/png');
        const hash = crypto.createHash('sha256')
          .update(JSON.stringify({ id, doc: s.document, at: Date.now() }))
          .digest('hex');
        // Detrás del proxy de Render, req.socket.remoteAddress es la IP
        // interna del proxy, no la del firmante — para que el rastro de
        // auditoría de la firma sea útil de verdad (y no falsificable) hay
        // que leer x-forwarded-for con trustedClientIp() (ver su comentario).
        const signerIp = trustedClientIp(req);
        s.signature = {
          storedAs: safeName,
          signedAt: new Date().toISOString(),
          ip: signerIp,
          auditHash: hash,
        };
        s.status = 'firmado';
        s.history.push({ event: 'documento_firmado', at: new Date().toISOString(), auditHash: hash });
        await txn.saveSession(s);
        return send(res, 200, { session: s });
      }

      return send(res, 404, { error: 'Ruta no encontrada' });
    });
  }

  // Le dice al frontend si el pago va a ser un cargo real con Square o una
  // simulación, para que el aviso de la pantalla de pago sea correcto — antes
  // ese aviso se decidía (por error) mirando el modo de verificación de
  // identidad, que es una cosa totalmente distinta. No expone el token, solo
  // si está configurado.
  if (pathname === '/api/payment-mode' && req.method === 'GET') {
    return send(res, 200, { demo: !process.env.SQUARE_ACCESS_TOKEN });
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
    if (!isNotaryAuthenticated(req)) return send(res, 401, { error: 'No autenticado como notario' });
    // Solo sesiones YA PAGADAS que no se mandaron a Proof.com. Antes también
    // aparecían sesiones con identidad verificada pero sin pagar (clientes
    // que abandonaron antes del pago), exponiendo sus datos en la cola.
    const pending = (await db.getSessionsByStatuses(['pagado_demo', 'pagado_square', 'en_cola']))
      .filter((q) => q.payment && q.payment.paidAt && !(q.proof && q.proof.transactionId));
    return send(res, 200, { queue: pending });
  }

  // --- Señalización WebRTC (oferta/respuesta/ICE) ----------------------
  const rtcMatch = pathname.match(/^\/api\/rtc\/([a-zA-Z0-9-]+)\/signal$/);
  if (rtcMatch) {
    const room = rtcMatch[1];
    if (!rtcRooms[room] && Object.keys(rtcRooms).length >= RTC_MAX_ROOMS) {
      return send(res, 503, { error: 'Demasiadas llamadas activas, intenta de nuevo en un momento.' });
    }
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

  // Cabeceras de seguridad de línea base para TODA respuesta (API y
  // páginas estáticas) — antes no se mandaba ninguna de estas. Se ponen
  // aquí con setHeader (no writeHead) para que apliquen sin tocar cada
  // punto de la app que ya llama a writeHead/send con sus propias
  // cabeceras. No se agrega Content-Security-Policy: definir una CSP
  // correcta requeriría auditar todos los recursos externos que carga
  // cada página (fuentes, WhatsApp, Square) y un error ahí rompe el
  // sitio en producción — mejor dejarlo como tarea aparte, deliberada.
  // X-Frame-Options: SAMEORIGIN, no DENY — DENY rompía el propio iframe de
  // vista previa del documento (public/app.html #docPreviewFrame, que
  // carga /uploads/<id>, mismo origen) para cualquier firmante: la ronda
  // anterior de arreglos agregó DENY sin probar el flujo completo del
  // sitio y esto quedó roto en producción. SAMEORIGIN sigue bloqueando que
  // OTRO sitio incruste firmaza.com en un iframe (protección real contra
  // clickjacking) sin romper el uso legítimo que hace el propio sitio.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // Verificación del enlace mágico: crea (o encuentra) el cliente, abre una
  // sesión de acceso de 30 días con cookie httpOnly, y manda al firmante a
  // su cuenta. GET porque es el destino de un clic desde el correo.
  if (pathname === '/auth/verify' && req.method === 'GET') {
    const token = u.searchParams.get('token') || '';
    try {
      const link = await db.getMagicLink(token);
      const valid = link && !link.used && new Date(link.expiresAt).getTime() >= Date.now();
      if (!valid) {
        res.writeHead(302, { Location: '/cuenta?error=enlace_invalido' });
        return res.end();
      }
      await db.markMagicLinkUsed(token);
      const client = await db.createClientIfMissing(link.email, newId(), new Date().toISOString());
      const sessionToken = crypto.randomBytes(32).toString('hex');
      const THIRTY_DAYS = 30 * 24 * 60 * 60;
      const expiresAt = new Date(Date.now() + THIRTY_DAYS * 1000).toISOString();
      await db.createLoginSession(sessionToken, link.email, client.id, expiresAt);
      res.writeHead(302, {
        Location: '/cuenta',
        'Set-Cookie': sessionCookieHeader(req, sessionToken, THIRTY_DAYS),
      });
      return res.end();
    } catch (e) {
      console.error('Error en /auth/verify:', e.message);
      res.writeHead(302, { Location: '/cuenta?error=enlace_invalido' });
      return res.end();
    }
  }

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
      // Búsqueda inicial (sin lock) solo para encontrar el id de la sesión
      // — la lectura/escritura real que importa pasa por withSessionLock()
      // más abajo, con su propio getSession() ya adentro del lock: este
      // webhook puede llegar casi al mismo tiempo que el propio firmante
      // hace polling de /proof-status (que también consulta y guarda el
      // mismo campo s.proof/s.status), así que sin el lock uno de los dos
      // puede pisar en silencio el cambio del otro.
      const found = await db.getSessionByProofTransactionId(transactionId);
      if (found) {
        await db.withSessionLock(found.id, async (txn) => {
          const match = await txn.getSession();
          if (!match) return;
          match.proof.status = event;
          match.proof.lastEventAt = new Date().toISOString();
          if (event === 'transaction.completed' || event === 'transaction.released') {
            match.status = 'notarizacion_completada';
          } else if (event === 'transaction.declined' || event === 'transaction.canceled' || event === 'transaction.expired') {
            match.status = 'notarizacion_rechazada';
            // Reembolso automático solo para 'declined' (no pasó el control
            // de identidad/seguridad) y 'expired' (nunca se conectó) — el
            // firmante no tuvo la culpa en ninguno de los dos casos, así que
            // no recibió el servicio que pagó. 'canceled' se deja fuera a
            // propósito (puede ser el propio firmante arrepintiéndose a
            // mitad de la videollamada, no solo una falla técnica) — para
            // esos casos existe POST /admin/sessions/:id/refund.
            if (event === 'transaction.declined') await refundSessionIfEligible(match, 'declined');
            else if (event === 'transaction.expired') await refundSessionIfEligible(match, 'expired');
          } else if (event === 'transaction.meeting.requested' || event === 'transaction.meeting.created' || event === 'notary.signer_ready') {
            match.status = 'en_reunion_con_notario';
          } else if (event === 'transaction.sent_to_signer') {
            match.status = 'enviado_a_notario_proof';
          }
          match.history.push({ event: `proof:${event}`, at: new Date().toISOString() });
          await txn.saveSession(match);
        });
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

  // Registra (una sola vez, como paso de configuración) la suscripción de
  // webhooks v2 de Proof.com apuntando a /webhooks/proof — sin esto, Proof
  // nunca avisa a Firmaza cuando una transacción cambia de estado, y el sitio
  // depende solo de que el propio firmante haga polling de /proof-status.
  // Protegido con ADMIN_SECRET (no con NOTARY_ACCESS_CODE: esto es
  // configuración de infraestructura, no algo que un notario deba poder
  // hacer) para que no cualquiera pueda registrar webhooks arbitrarios en la
  // cuenta de Proof.com de Firmaza. Sin ADMIN_SECRET configurado, la ruta
  // queda cerrada (fail closed).
  if (pathname === '/admin/register-proof-webhook' && req.method === 'POST') {
    const adminSecret = process.env.ADMIN_SECRET;
    const provided = req.headers['x-admin-secret'];
    if (!adminSecret || !provided || !timingSafeStringEqual(provided, adminSecret)) {
      return send(res, 401, { error: 'No autorizado' });
    }
    try {
      const origin = trustedOrigin(req);
      const result = await proofRon.registerWebhook(`${origin}/webhooks/proof`);
      if (!result) return send(res, 400, { error: 'PROOF_API_KEY no está configurada en el servidor' });
      return send(res, 200, { ok: true, result });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // Solo lectura — para confirmar qué webhooks quedaron registrados de verdad
  // en la cuenta de Proof.com (útil porque /admin/register-proof-webhook
  // devuelve error si ya existe una suscripción para esa URL, sin decir a
  // qué eventos está suscrita esa suscripción existente).
  if (pathname === '/admin/list-proof-webhooks' && req.method === 'GET') {
    const adminSecret = process.env.ADMIN_SECRET;
    const provided = req.headers['x-admin-secret'];
    if (!adminSecret || !provided || !timingSafeStringEqual(provided, adminSecret)) {
      return send(res, 401, { error: 'No autorizado' });
    }
    try {
      const result = await proofRon.listWebhooks();
      if (!result) return send(res, 400, { error: 'PROOF_API_KEY no está configurada en el servidor' });
      return send(res, 200, { ok: true, result });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // Reembolso manual — para casos que a propósito NO califican para el
  // reembolso automático de refundSessionIfEligible (ej. 'canceled': el
  // firmante se arrepintió a mitad de la videollamada, o cualquier otro caso
  // donde Ricardo decide reembolsar por su cuenta). Protegido con
  // ADMIN_SECRET, igual que los otros /admin/*: esto mueve dinero real, así
  // que no puede quedar abierto a nadie con el id de la sesión.
  const refundMatch = pathname.match(/^\/admin\/sessions\/([a-f0-9]+)\/refund$/);
  if (refundMatch && req.method === 'POST') {
    const adminSecret = process.env.ADMIN_SECRET;
    const provided = req.headers['x-admin-secret'];
    if (!adminSecret || !provided || !timingSafeStringEqual(provided, adminSecret)) {
      return send(res, 401, { error: 'No autorizado' });
    }
    const sessionId = refundMatch[1];
    try {
      const body = await readBody(req);
      // Cualquier código fuera de esta lista cae a 'admin_manual' — no se
      // deja que el body elija un texto arbitrario para REFUND_REASONS, ese
      // catálogo es fijo a propósito (mismo motivo que PRICE_CATALOG: nada
      // que venga del cliente decide texto que después se usa para explicar
      // un movimiento de dinero real).
      const reasonCode = ['declined', 'expired', 'canceled'].includes(body.reasonCode) ? body.reasonCode : 'admin_manual';
      const result = await db.withSessionLock(sessionId, async (txn) => {
        const s = await txn.getSession();
        if (!s) return { notFound: true };
        if (s.payment?.mode !== 'square' || !s.payment?.paidAt) {
          return { error: 'Esta sesión no tiene un pago real de Square para reembolsar (¿modo demo, o todavía no pagada?).' };
        }
        if (s.payment?.refund) {
          return { error: 'Esta sesión ya fue reembolsada.', refund: s.payment.refund };
        }
        const refund = await refundSessionIfEligible(s, reasonCode);
        await txn.saveSession(s);
        if (!refund) {
          return { error: 'No se pudo procesar el reembolso — revisa los logs del servidor (falta payment_id, o Square rechazó la solicitud).' };
        }
        return { refund, session: s };
      });
      if (result.notFound) return send(res, 404, { error: 'Sesión no encontrada' });
      if (result.error) return send(res, 400, { error: result.error, refund: result.refund || null });
      return send(res, 200, { ok: true, refund: result.refund });
    } catch (e) {
      return send(res, 500, { error: e.message });
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

  // Documentos/firmas guardados en la base de datos (antes: archivos sueltos
  // en disco bajo data/uploads/ — ver nota de persistencia arriba).
  if (pathname.startsWith('/uploads/')) {
    const fileId = decodeURIComponent(pathname.replace('/uploads/', ''));
    try {
      const file = await db.getFile(fileId);
      if (!file) return send(res, 404, { error: 'No encontrado' });
      // sanitizeUploadContentType() de nuevo aquí, en defensa en profundidad:
      // así, aunque algún día otro punto del código guarde un content-type
      // sin pasar por ahí (o queden filas viejas guardadas antes de este
      // arreglo), esta ruta nunca sirve HTML/SVG/JS ejecutable.
      res.writeHead(200, { 'Content-Type': sanitizeUploadContentType(file.contentType) });
      return res.end(file.data);
    } catch (e) {
      console.error('Error sirviendo /uploads/:', e.message);
      return send(res, 500, { error: 'Error interno' });
    }
  }

  // Rutas de páginas (SPA con rutas "bonitas")
  const routes = {
    '/': 'index.html',
    '/app': 'app.html',
    '/cuenta': 'cuenta.html',
    '/terminos': 'terminos.html',
    '/privacidad': 'privacidad.html',
  };
  // Panel de notario: no está enlazado en ningún lado y vive en una ruta
  // secreta configurable (NOTARY_PANEL_PATH en Render) para que clientes u
  // otras personas no lleguen a él por casualidad — el repo es público, así
  // que la ruta NO se escribe aquí. Sin la variable, sigue en /notario.
  // Además sigue protegido por NOTARY_ACCESS_CODE y no se indexa en Google.
  if (pathname === NOTARY_PANEL_PATH) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    return serveStatic(req, res, path.join(PUBLIC_DIR, 'notario.html'));
  }
  if (pathname === '/notario.html' || pathname === '/notario' || pathname === '/notario/') {
    return send(res, 404, { error: 'No encontrado' });
  }
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

db.migrate()
  .then(() => {
    console.log('Base de datos: tablas listas (Postgres)');
    server.listen(PORT, () => {
      console.log(`Firmaza corriendo en http://localhost:${PORT}`);
      console.log(process.env.SQUARE_ACCESS_TOKEN ? 'Square: modo real' : 'Square: modo demo (sin SQUARE_ACCESS_TOKEN)');
      console.log(process.env.RESEND_API_KEY ? 'Correo (enlaces mágicos): modo real' : 'Correo (enlaces mágicos): modo demo (sin RESEND_API_KEY, el enlace se imprime aquí en la consola)');
    });
  })
  .catch((e) => {
    console.error('No se pudo preparar la base de datos (revisa DATABASE_URL):', e.message);
    process.exit(1);
  });
