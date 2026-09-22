/**
 * Integración real con Proof.com (antes Notarize.com) — Business API v1/v2.
 * =============================================================================
 * A diferencia de BlueNotary y NotaryCam, la cuenta de negocio de Ricardo en
 * Proof.com ("Firmaza", organización ord7gqygz) SÍ tiene autoservicio real:
 * Settings → API Keys genera llaves al instante, sin hablar con ventas.
 *
 * Documentación usada para este archivo:
 *   - Auth y llaves:        https://dev.proof.com/docs/api-keys
 *   - Quickstart negocio:   https://dev.proof.com/docs/business-quick-start
 *   - Crear transacción:    https://dev.proof.com/reference/createtransaction
 *   - Consultar transacción: https://dev.proof.com/reference/gettransaction
 *   - Webhooks v2:          https://dev.proof.com/docs/webhooks-v2
 *
 * Cómo funciona el flujo con Proof (distinto al demo WebRTC propio):
 *   1. Firmaza crea una "transaction" con el documento (URL pública) y el
 *      correo del firmante.
 *   2. Proof le manda automáticamente al firmante un correo (y SMS si hay
 *      teléfono) invitándolo a conectarse con un notario por video dentro de
 *      la propia app de Proof (no dentro de firmaza.com).
 *   3. Un notario de la Red de Proof (Notarize Network) — o el propio Ricardo,
 *      si el firmante entra durante su turno — atiende la sesión, verifica
 *      identidad y notariza.
 *   4. Proof avisa a firmaza.com por webhook cuando cambia el estado
 *      (enviado, en reunión, completado, documentos liberados).
 *
 * IMPORTANTE — sobre quién notariza: la cuenta actual de Ricardo (plan
 * self-serve de "Firmaza") NO incluye la función "in-house notaries" (eso
 * está bloqueado detrás de un plan de pago — ver Settings → Notary Settings
 * en el panel de Proof for Notaries, botón "View plans"). Eso significa que,
 * mientras no se actualice el plan, las transacciones creadas por la API se
 * asignan a CUALQUIER notario disponible de la Red de Proof, no exclusivamente
 * a Ricardo. Se puede acotar (no garantizar) con `PROOF_ALLOWED_NOTARY_STATES`
 * (p. ej. "MO") para que solo tomen la sesión notarios comisionados en ese
 * estado — pero eso requiere que Proof lo tenga habilitado para la cuenta.
 * Si más adelante Ricardo confirma que puede fijar su propio notary_id (por
 * ejemplo tras hablar con soporte de Proof o actualizar de plan), se puede
 * pasar por PROOF_NOTARY_ID.
 */

const PROOF_BASE_URL = (process.env.PROOF_API_BASE_URL || 'https://api.proof.com/v1').replace(/\/$/, '');
const PROOF_BASE_URL_V2 = PROOF_BASE_URL.replace(/\/v1$/, '/v2');

function splitName(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return {};
    const first_name = parts[0];
    const last_name = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
    return last_name ? { first_name, last_name } : { first_name };
}

async function proofFetch(url, { apiKey, method = 'GET', body } = {}) {
    const resp = await fetch(url, {
          method,
          signal: AbortSignal.timeout(15000),
          headers: {
                  ApiKey: apiKey,
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    let rawText = null;
    try {
          rawText = await resp.text();
          json = rawText ? JSON.parse(rawText) : null;
    } catch { /* respuesta vacía o no-JSON: nos quedamos con rawText tal cual */ }
    if (!resp.ok) {
          // Antes esto colapsaba cualquier error sin uno de esos tres campos
          // exactos a un simple "HTTP 422", sin decir por qué Proof.com
          // rechazó la solicitud — deja el cuerpo completo (o el texto crudo,
          // si no era JSON válido) para poder diagnosticar de verdad.
          const detail = json?.message || json?.error || json?.errors?.[0]?.message
            || (json ? JSON.stringify(json) : null) || rawText || `HTTP ${resp.status}`;
          throw new Error(`Proof.com: ${detail}`);
    }
    return json;
}

/**
 * Crea una transacción de notarización real en Proof.com.
 * Devuelve `null` (modo demo) si PROOF_API_KEY no está configurada, igual que
 * bluenotary.js / notarycam.js, para que server.js pueda usar su flujo propio
 * (WebRTC) como respaldo mientras no haya credenciales.
 */
async function createRonSession({ sessionId, signerName, signerEmail, signerPhone, documentUrl, message, subject, additionalSigners = [] }) {
    const apiKey = process.env.PROOF_API_KEY;
    if (!apiKey) return null;

  if (!signerEmail) throw new Error('Proof.com requiere el correo del firmante para crear la transacción.');
    if (!documentUrl) throw new Error('Proof.com requiere una URL pública del documento a notarizar.');

  const signer = { email: signerEmail, ...splitName(signerName) };
    if (signerPhone) signer.phone_number = signerPhone;

  // Firmantes adicionales (p. ej. el otro padre/madre en el permiso de viaje).
  // Proof.com permite varios firmantes en una transacción: cada uno recibe su
  // propia invitación por correo, verifica su identidad y firma frente al
  // notario — juntos en la misma videollamada o por separado ("split
  // signing"). La transacción se completa cuando firman TODOS.
  const extraSigners = (additionalSigners || [])
    .filter((x) => x && x.email)
    .map((x) => {
      const o = { email: x.email, ...splitName(x.name) };
      if (x.phone) o.phone_number = x.phone;
      return o;
    });

  // NOTA sobre idioma del correo: la API de Proof.com NO tiene un parámetro de
  // idioma/locale. Solo estos dos campos de texto son personalizables — el
  // resto de la plantilla (saludo, "How it works", "Signer Checklist", aviso
  // de reenvío y el pie "About Proof") la genera Proof en inglés fijo y no se
  // puede traducir desde la API. Ver README para el detalle de esta limitación.
  const body = {
        external_id: sessionId, // para poder emparejar los webhooks con la sesión de Firmaza
        transaction_name: `Firmaza — ${signerName || signerEmail}`,
        transaction_type: 'Notarización remota (RON) — Firmaza',
        message_subject: subject || `${signerName ? signerName.split(/\s+/)[0] : 'Hola'}, tu documento de Firmaza está listo para notarizar`,
        message_to_signer: message || 'Tu documento está listo. Haz clic en el botón de abajo para conectarte con un notario por video y completar la notarización. Cuando entres a la videollamada, puedes pedir un notario que hable español.',
        config_id: 'notarization',
        signers: [signer, ...extraSigners],
        documents: [{ resource: documentUrl, requirement: 'notarization' }],
  };

  const allowedStates = String(process.env.PROOF_ALLOWED_NOTARY_STATES || '')
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (allowedStates.length) body.allowed_notary_states = allowedStates;
    if (process.env.PROOF_NOTARY_ID) body.notary_id = process.env.PROOF_NOTARY_ID;

  const json = await proofFetch(`${PROOF_BASE_URL}/transactions`, { apiKey, method: 'POST', body });
    return {
          transactionId: json.id,
          status: json.status || 'started',
          raw: json,
    };
}

/** Consulta el estado actual de una transacción ya creada. */
async function getTransactionStatus(transactionId) {
    const apiKey = process.env.PROOF_API_KEY;
    if (!apiKey || !transactionId) return null;
    return proofFetch(`${PROOF_BASE_URL}/transactions/${transactionId}`, { apiKey });
}

/** Lista las suscripciones de webhooks v2 ya configuradas en la cuenta. */
async function listWebhooks() {
    const apiKey = process.env.PROOF_API_KEY;
    if (!apiKey) return null;
    return proofFetch(`${PROOF_BASE_URL_V2}/webhooks`, { apiKey });
}

/**
 * Registra (o reemplaza) la suscripción de webhooks v2 apuntando a
 * `webhookUrl` (debe ser pública, ej. https://firmaza.com/webhooks/proof).
 * Se corre una sola vez como parte de la configuración inicial — no hace
 * falta llamarla en cada arranque del servidor.
 */
async function registerWebhook(webhookUrl, subscriptions) {
    const apiKey = process.env.PROOF_API_KEY;
    if (!apiKey) return null;
    const body = {
          url: webhookUrl,
          subscriptions: subscriptions || [
                  'transaction.created',
                  'transaction.sent_to_signer',
                  'transaction.meeting.requested',
                  'transaction.meeting.created',
                  'transaction.meeting.failed',
                  'transaction.completed',
                  'transaction.released',
                  'transaction.completed_with_rejections',
                  'transaction.declined',
                  'transaction.canceled',
                  'transaction.expired',
                  'notary.signer_ready',
                  'transaction.notary.assigned',
                ],
    };
    return proofFetch(`${PROOF_BASE_URL_V2}/webhooks`, { apiKey, method: 'POST', body });
}

/**
 * Verifica la firma HMAC-SHA256 que Proof manda en el header
 * `X-Notarize-Signature` (usa la propia API key como llave de firma por
 * defecto). Regresa `true`/`false`. Requiere el cuerpo RAW (string, antes de
 * hacer JSON.parse) porque la firma se calcula sobre esos bytes exactos.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
    const apiKey = process.env.PROOF_API_KEY;
    if (!apiKey || !signatureHeader) return false;
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', apiKey).update(rawBody, 'utf8').digest('hex');
    try {
          return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signatureHeader, 'hex'));
    } catch {
          return false; // longitudes distintas u otro formato -> no coincide
    }
}

module.exports = { createRonSession, getTransactionStatus, registerWebhook, listWebhooks, verifyWebhookSignature };
