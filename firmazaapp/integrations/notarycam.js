/**
 * Punto de integración con NotaryCam (licencia "white-label" de plataforma RON)
 * — SIN CONFIRMAR AÚN.
 * =============================================================================
 * IMPORTANTE — léelo antes de usar en producción:
 *
 * A diferencia de BlueNotary, NotaryCam SÍ publica documentación técnica de
 * API (https://apidocs.notarycam.com/) y ofrece explícitamente un modelo de
 * "Software Licensing": usas TU PROPIA red de notarios (los que ya tienes
 * con RON activo) sobre la infraestructura de video/cumplimiento de
 * NotaryCam, con tu marca. Pero el acceso a esa licencia NO es autoservicio:
 * hay que pasar por su equipo de ventas empresariales, negociar precio y
 * firmar un acuerdo comercial antes de recibir credenciales de API reales
 * para producción.
 *
 * Esa parte NO se puede automatizar desde aquí: requiere que Ricardo (el
 * dueño del negocio) llene el formulario de contacto y tenga la conversación
 * comercial directamente con NotaryCam. Ver:
 *   docs/contacto-notarycam.md
 * para el mensaje ya preparado (qué llenar en su formulario + preguntas
 * técnicas de seguimiento).
 *
 * Este archivo es el "molde" listo para llenar en cuanto tengas credenciales
 * reales. Mientras tanto, `createRonSession` regresa null y server.js usa el
 * flujo de video propio (WebRTC + tu cola de notarios en
 * data/notaries.json) como demo funcional — igual que con BlueNotary.
 *
 * Qué confirmar con NotaryCam antes de escribir la llamada real a su API:
 *   1. Confirmar por escrito que la licencia "Software Licensing" permite
 *      usar notarios que TÚ ya tienes comisionados y activos en RON (no solo
 *      los de la red propia de NotaryCam) — este es el punto no-negociable.
 *   2. Pedir acceso a su documentación completa de API v4
 *      (https://apidocs.notarycam.com/docs/api-v4/) con credenciales de
 *      sandbox/pruebas antes de firmar cualquier contrato anual.
 *   3. Endpoint(s) para crear una sesión de notarización: qué datos recibe
 *      (firmante, documento, notario asignado) y qué regresa (URL de sesión,
 *      ID de transacción).
 *   4. Webhooks: cómo notifican que la sesión terminó y qué trae esa
 *      notificación (documento sellado, journal entry, grabación de
 *      audio/video, por cuánto tiempo la retienen).
 *   5. Modelo de precio real: ¿por transacción, por notario/asiento, o
 *      suscripción mensual mínima? Pedir el desglose completo, no solo
 *      "contactar ventas."
 *   6. Estados donde tu licencia cubre operar (RON tiene reglas por estado;
 *      confirmar que tus notarios ya comisionados están cubiertos).
 */

async function createRonSession({ sessionId, signerName, documentUrl }) {
  const apiKey = process.env.NOTARYCAM_API_KEY;
  const baseUrl = process.env.NOTARYCAM_BASE_URL; // te lo da su equipo al firmar el acuerdo de licencia
  if (!apiKey || !baseUrl) return null;

  // --- Reemplaza esto con la llamada real una vez que tengas su documentación y credenciales. ---
  throw new Error(
    'Integración con NotaryCam aún no configurada: falta el acuerdo de licencia y las credenciales ' +
    'reales de su API. Contacta a su equipo de ventas empresariales para obtenerlas (ver docs/contacto-notarycam.md).'
  );
}

module.exports = { createRonSession };
