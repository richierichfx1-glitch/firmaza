/**
 * Punto de integración con BlueNotary (proveedor de RON) — SIN CONFIRMAR AÚN.
 * =============================================================================
 * IMPORTANTE — léelo antes de usar en producción:
 *
 * BlueNotary no publica una API pública de autoservicio con documentación
 * técnica abierta (endpoints, autenticación, webhooks). Su integración es
 * comercial: hay que contactar a su equipo de partnerships/ventas
 * (https://bluenotary.us o https://bluenotaryonline.com/for-businesses),
 * firmar un acuerdo comercial y ellos entregan credenciales + documentación
 * técnica específica para tu cuenta. Esa parte NO se puede automatizar desde
 * aquí: requiere que Ricardo (el dueño del negocio) haga el contacto y firme
 * el acuerdo directamente con BlueNotary.
 *
 * Este archivo es el "molde" listo para llenar en cuanto tengas esas
 * credenciales y su documentación real. Mientras tanto, `createRonSession`
 * regresa null y server.js usa el flujo de video propio (WebRTC + tu cola de
 * notarios en data/notaries.json) como demo funcional.
 *
 * Qué necesitas pedirle a BlueNotary para completar esto:
 *   1. Si el flujo es "redirect" (mandas al firmante a una URL de ellos) o
 *      "embed" (insertas un iframe/SDK de ellos en tu propia página).
 *   2. El endpoint para crear una sesión de notarización y qué datos recibe
 *      (nombre del firmante, documento, etc.).
 *   3. Cómo te notifican que la notarización terminó (webhook) y qué trae
 *      esa notificación (documento certificado, sello, journal entry).
 *   4. Si ellos aportan la red de notarios o si conectan con notarios que tú
 *      ya tienes activos (RON) — con tu equipo de notarios ya certificados,
 *      vale la pena preguntarles explícitamente si soportan "traer tu propia
 *      red de notarios" o si su plataforma exige usar la de ellos.
 */

async function createRonSession({ sessionId, signerName, documentUrl }) {
  const apiKey = process.env.BLUENOTARY_API_KEY;
  const baseUrl = process.env.BLUENOTARY_BASE_URL; // te lo da su equipo al firmar el acuerdo
  if (!apiKey || !baseUrl) return null;

  // --- Reemplaza esto con la llamada real una vez que tengas su documentación. ---
  throw new Error(
    'Integración con BlueNotary aún no configurada: falta la documentación técnica real de su API. ' +
    'Contacta a su equipo comercial para obtenerla.'
  );
}

module.exports = { createRonSession };
