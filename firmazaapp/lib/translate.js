/**
 * Traducción automática español → inglés para los documentos que prepara Firmaza.
 * =============================================================================
 * El cliente escribe en español; la mayoría necesita el documento en inglés.
 * Aquí se traduce SOLO el texto libre que escribió el cliente (el alcance de
 * una autorización, lo que declara, el cuerpo de su carta, etc.). El texto
 * fijo de cada plantilla ya está traducido a mano en documentTemplates.js.
 *
 * Además de traducir al inglés, se hace una TRADUCCIÓN DE REGRESO al español
 * en una llamada separada (sin ver el original). El cliente la lee en la
 * vista previa para comprobar, sin saber inglés, que la versión en inglés
 * dice lo mismo que él escribió — y la aprueba antes de continuar.
 *
 * Coherente con el aviso de documentTemplates.js: la traducción es fiel y
 * NO agrega, quita ni "mejora" nada — Firmaza sigue sin redactar contenido.
 *
 * Usa la API de Claude (Anthropic) con fetch nativo (Node 18+), sin
 * dependencias, igual que Resend y Square en server.js.
 *   ANTHROPIC_API_KEY  → sin ella, modo demo (ver abajo)
 *   ANTHROPIC_MODEL    → opcional, modelo a usar
 *
 * Modo demo (sin ANTHROPIC_API_KEY): no se traduce; el texto del cliente se
 * deja en español dentro del documento en inglés y `mode: 'demo'` para que
 * la vista previa avise que la traducción no está activa.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-5';

const RULES = `Rules:
- Translate faithfully. Do NOT add, remove, soften, summarize or embellish anything. Do not give legal advice and do not "improve" the content.
- Keep personal names, company names, street addresses, ID numbers, tracking numbers, phone numbers, emails, dates and amounts EXACTLY as written.
- Keep the same line and paragraph breaks.
- Use a clear, formal register suitable for a notarized document.
- If a value is only a place name, translate only country names and common words (e.g. "México" -> "Mexico").
- Reply with ONLY a JSON object with exactly the same keys as the input, each value a string. No commentary, no code fences.`;

async function callClaude(system, payload) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 8000,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`La traducción automática falló (${resp.status}). ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = (data.content || []).map((c) => c.text || '').join('').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('La traducción automática devolvió un formato inválido.'); }
  for (const key of Object.keys(payload)) {
    if (typeof out[key] !== 'string' || !out[key].trim()) {
      throw new Error(`La traducción automática no devolvió el campo "${key}".`);
    }
  }
  return out;
}

/**
 * `fields`: { clave: 'texto en español' }
 * Devuelve { mode: 'real'|'demo', en: {clave: inglés}, back: {clave: español de regreso} }
 */
async function translateFields(fields) {
  const keys = Object.keys(fields || {});
  if (!keys.length) return { mode: 'none', en: {}, back: {} };
  if (!process.env.ANTHROPIC_API_KEY) {
    return { mode: 'demo', en: { ...fields }, back: { ...fields } };
  }
  const en = await callClaude(
    `You translate Spanish text written by a person into English, for a document that person will sign before a U.S. notary public.\n${RULES}`,
    fields,
  );
  const back = await callClaude(
    `You translate English text into plain, simple Latin American Spanish so the signer (who does not read English) can check the meaning.\n${RULES}`,
    en,
  );
  return { mode: 'real', en, back };
}

module.exports = { translateFields };
