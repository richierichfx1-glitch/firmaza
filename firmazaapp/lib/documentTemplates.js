/**
 * Plantillas de documentos que Firmaza puede preparar a pedido del cliente.
 * =============================================================================
 * IMPORTANTE — por qué están diseñadas así (leer antes de tocar este archivo):
 *
 * Un notario SIN licencia de abogado que redacta o decide el contenido de un
 * documento legal para un cliente comete "ejercicio no autorizado de la
 * abogacía" (unauthorized practice of law), que en la mayoría de los estados
 * de EE.UU. tiene sanciones penales — no es solo una falta administrativa.
 * Esto aplica exactamente a los documentos que se ofrecen aquí (poderes,
 * cartas de viaje, declaraciones).
 *
 * Por eso, cada plantilla sigue el mismo modelo que usan los servicios de
 * "self-help document preparation" (ej. LegalZoom): Firmaza JAMÁS decide qué
 * plantilla usar, qué cláusulas incluir, ni redacta el contenido sustantivo.
 * El cliente escribe con sus propias palabras cada campo de contenido (el
 * alcance de una autorización, el texto de una declaración jurada, etc.);
 * Firmaza únicamente lo acomoda en un formato de documento. No hay opinión
 * ni criterio legal de Firmaza en ningún punto del proceso.
 *
 * Estas plantillas son de uso general, NO fueron redactadas ni revisadas por
 * un abogado con licencia para Missouri ni ningún otro estado. Antes de
 * usarlas en producción con clientes reales, Ricardo debería pedirle a un
 * abogado que las revise — el aviso legal que se imprime en cada documento
 * generado (ver `LEGAL_DISCLAIMER` abajo) es una mitigación, no un sustituto
 * de esa revisión.
 *
 * "Carta poder simple" se limita a trámites puntuales a propósito — NO es un
 * Power of Attorney legal amplio (financiero, médico, inmobiliario). Missouri
 * tiene su propio formulario estatutario para eso (RSMo cap. 404) y requiere
 * asesoría de un abogado.
 */

const LEGAL_DISCLAIMER =
  'AVISO LEGAL: Firmaza no es un despacho de abogados y no brinda asesoría ' +
  'legal. Este documento fue generado con el formato que tú elegiste y el ' +
  'texto que tú mismo escribiste — Firmaza no seleccionó ni redactó su ' +
  'contenido legal. Es tu responsabilidad asegurarte de que este documento ' +
  'cumple lo que necesitas. Si tienes dudas legales sobre qué documento usar ' +
  'o qué debe decir, consulta a un abogado con licencia antes de firmarlo.';

const TEMPLATES = [
  {
    id: 'carta_poder_simple',
    name: 'Carta poder simple (autorización específica)',
    description:
      'Para autorizar a alguien a hacer un trámite puntual en tu nombre (recoger un paquete, un trámite escolar, etc). No es un Poder Notarial (Power of Attorney) legal amplio — para poderes financieros, médicos o inmobiliarios consulta a un abogado.',
    fields: [
      { key: 'poderdanteNombre', label: 'Tu nombre completo (quien autoriza)', type: 'text', required: true, placeholder: 'Ej. María López García' },
      { key: 'poderdanteId', label: 'Tu identificación (tipo y número)', type: 'text', required: true, placeholder: 'Ej. Licencia de conducir #A1234567' },
      { key: 'apoderadoNombre', label: 'Nombre completo de la persona autorizada', type: 'text', required: true, placeholder: 'Ej. Juan Carlos Pérez' },
      { key: 'apoderadoId', label: 'Identificación de la persona autorizada (si la sabes)', type: 'text', required: false, placeholder: 'Ej. Pasaporte 123456789' },
      { key: 'alcance', label: 'Describe con tus propias palabras, exactamente, para qué la autorizas', type: 'textarea', required: true, placeholder: 'Ej. Recoger mi paquete certificado en la oficina de USPS de 123 Main St en mi nombre, durante el mes de octubre de 2026.' },
      { key: 'fechaInicio', label: 'Válida desde', type: 'date', required: true },
      { key: 'fechaFin', label: 'Válida hasta (opcional)', type: 'date', required: false },
      { key: 'lugar', label: 'Ciudad y estado donde se firma', type: 'text', required: true, placeholder: 'Ej. Kansas City, Missouri' },
    ],
    render(v) {
      return [
        { text: 'CARTA PODER SIMPLE', size: 16, bold: true, align: 'center', spaceAfter: 4 },
        { text: '(Autorización específica — no es un Poder Notarial legal amplio)', size: 9, align: 'center', spaceAfter: 22 },
        { text: `Yo, ${v.poderdanteNombre}, identificado con ${v.poderdanteId}, por medio de la presente autorizo a ${v.apoderadoNombre}${v.apoderadoId ? ` (identificado con ${v.apoderadoId})` : ''} para lo siguiente:`, spaceAfter: 12 },
        { text: v.alcance, spaceAfter: 16 },
        { text: `Esta autorización es válida a partir del ${v.fechaInicio}${v.fechaFin ? ` y hasta el ${v.fechaFin}` : ', hasta que yo la revoque por escrito'}.`, spaceAfter: 28 },
        { text: `Firmado en ${v.lugar}, el _____ de _______________ de ________.`, spaceAfter: 40 },
        { text: '_______________________________', spaceAfter: 2 },
        { text: `${v.poderdanteNombre} — Firma de quien autoriza`, size: 9, spaceAfter: 40 },
        { text: LEGAL_DISCLAIMER, size: 8, spaceBefore: 20 },
      ];
    },
  },
  {
    id: 'consentimiento_viaje_menor',
    name: 'Carta de consentimiento de viaje para menores',
    description: 'Para cuando un menor viaja sin uno o ambos padres/tutores.',
    fields: [
      { key: 'menorNombre', label: 'Nombre completo del menor', type: 'text', required: true, placeholder: 'Ej. Sofía Ramírez López' },
      { key: 'menorNacimiento', label: 'Fecha de nacimiento del menor', type: 'date', required: true },
      { key: 'padreNombre', label: 'Tu nombre completo (padre/madre/tutor que firma)', type: 'text', required: true, placeholder: 'Ej. Ricardo Vivas Barrios' },
      { key: 'padreId', label: 'Tu identificación (tipo y número)', type: 'text', required: true, placeholder: 'Ej. Pasaporte 123456789' },
      { key: 'padreAusenteNombre', label: 'Nombre del otro padre/tutor (si no viaja ni firma esta carta)', type: 'text', required: false, placeholder: 'Ej. Ana Ramírez Torres' },
      { key: 'acompananteNombre', label: 'Nombre del adulto que acompaña al menor (si aplica)', type: 'text', required: false, placeholder: 'Ej. Ana Lucía Vivas' },
      { key: 'destino', label: 'Destino del viaje', type: 'text', required: true, placeholder: 'Ej. Ciudad de México, México' },
      { key: 'fechaSalida', label: 'Fecha de salida', type: 'date', required: true },
      { key: 'fechaRegreso', label: 'Fecha de regreso', type: 'date', required: true },
      { key: 'lugar', label: 'Ciudad y estado donde se firma', type: 'text', required: true, placeholder: 'Ej. Kansas City, Missouri' },
    ],
    render(v) {
      const lines = [
        { text: 'CARTA DE CONSENTIMIENTO DE VIAJE PARA MENORES', size: 16, bold: true, align: 'center', spaceAfter: 24 },
        { text: `Yo, ${v.padreNombre}, identificado con ${v.padreId}, en calidad de padre/madre/tutor legal del menor ${v.menorNombre}, nacido el ${v.menorNacimiento}, autorizo por medio de la presente a que viaje a ${v.destino}, del ${v.fechaSalida} al ${v.fechaRegreso}.`, spaceAfter: 12 },
      ];
      if (v.acompananteNombre) {
        lines.push({ text: `El menor viajará acompañado de ${v.acompananteNombre}.`, spaceAfter: 12 });
      }
      if (v.padreAusenteNombre) {
        lines.push({ text: `El otro padre/tutor del menor, ${v.padreAusenteNombre}, no viaja ni firma esta carta.`, spaceAfter: 12 });
      }
      lines.push(
        { text: 'Declaro que esta autorización es voluntaria y que la información aquí proporcionada es verdadera.', spaceAfter: 28 },
        { text: `Firmado en ${v.lugar}, el _____ de _______________ de ________.`, spaceAfter: 40 },
        { text: '_______________________________', spaceAfter: 2 },
        { text: `${v.padreNombre} — Firma`, size: 9, spaceAfter: 40 },
        { text: LEGAL_DISCLAIMER, size: 8, spaceBefore: 20 },
      );
      return lines;
    },
  },
  {
    id: 'declaracion_jurada_generica',
    name: 'Declaración jurada genérica',
    description: 'Para declarar bajo juramento hechos que tú describes con tus propias palabras.',
    fields: [
      { key: 'declaranteNombre', label: 'Tu nombre completo', type: 'text', required: true, placeholder: 'Ej. Ricardo Vivas Barrios' },
      { key: 'declaranteId', label: 'Tu identificación (tipo y número)', type: 'text', required: true, placeholder: 'Ej. ID estatal #12345678' },
      { key: 'declaracion', label: 'Escribe exactamente lo que quieres declarar bajo juramento', type: 'textarea', required: true, placeholder: 'Ej. Declaro que resido en Kansas City, Missouri desde enero de 2020.' },
      { key: 'lugar', label: 'Ciudad y estado donde se firma', type: 'text', required: true, placeholder: 'Ej. Kansas City, Missouri' },
    ],
    render(v) {
      return [
        { text: 'DECLARACIÓN JURADA', size: 16, bold: true, align: 'center', spaceAfter: 24 },
        { text: `Yo, ${v.declaranteNombre}, identificado con ${v.declaranteId}, declaro bajo juramento y bajo pena de perjurio lo siguiente:`, spaceAfter: 14 },
        { text: v.declaracion, spaceAfter: 28 },
        { text: `Firmado en ${v.lugar}, el _____ de _______________ de ________.`, spaceAfter: 40 },
        { text: '_______________________________', spaceAfter: 2 },
        { text: `${v.declaranteNombre} — Firma del declarante`, size: 9, spaceAfter: 40 },
        { text: LEGAL_DISCLAIMER, size: 8, spaceBefore: 20 },
      ];
    },
  },
];

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

function listTemplates() {
  return TEMPLATES.map(({ id, name, description, fields }) => ({ id, name, description, fields }));
}

/** Devuelve la lista de campos requeridos que faltan ({key, label}), o un
 * arreglo vacío si todo está completo. Se usa tanto en el servidor (defensa
 * final) como en el navegador (para resaltar los campos exactos en rojo en
 * vez de un alert() genérico). */
function validateValues(template, values) {
  const missing = [];
  for (const f of template.fields) {
    if (f.required && !String(values?.[f.key] || '').trim()) {
      missing.push({ key: f.key, label: f.label });
    }
  }
  return missing;
}

/** Para la categoría "carta simple": el cliente escribe TODO el texto, Firmaza
 * solo le da formato de documento — cero redacción o criterio de Firmaza. */
function renderCustomLetter({ titulo, cuerpo, autor, lugar }) {
  return [
    { text: (titulo || 'CARTA').toUpperCase(), size: 16, bold: true, align: 'center', spaceAfter: 24 },
    { text: cuerpo, spaceAfter: 28 },
    { text: `Firmado en ${lugar || '_______________'}, el _____ de _______________ de ________.`, spaceAfter: 40 },
    { text: '_______________________________', spaceAfter: 2 },
    { text: `${autor || ''} — Firma`, size: 9, spaceAfter: 40 },
    { text: LEGAL_DISCLAIMER, size: 8, spaceBefore: 20 },
  ];
}

module.exports = { listTemplates, getTemplate, validateValues, renderCustomLetter, LEGAL_DISCLAIMER };
