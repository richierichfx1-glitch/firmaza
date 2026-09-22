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

/*
 * IDIOMAS (inglés / español / bilingüe)
 * -----------------------------------------------------------------------------
 * El cliente siempre llena el formulario en español. Cada plantilla se puede
 * renderizar en:
 *   - 'en'  inglés (POR DEFECTO — es lo que normalmente piden en EE.UU.), con
 *           líneas de referencia en español en gris debajo del texto fijo,
 *           para que el firmante entienda lo que firma.
 *   - 'es'  español.
 *   - 'bi'  bilingüe inglés + español, párrafo por párrafo. El permiso de
 *           viaje para menores SIEMPRE sale así (ver ALWAYS_BILINGUAL), porque
 *           se usa para viajar a países hispanohablantes y lo tienen que
 *           entender las autoridades de los dos países.
 *
 * El texto fijo de cada plantilla está traducido aquí a mano. El texto libre
 * que escribe el cliente se traduce con lib/translate.js y llega en `tr`
 * ({ clave: 'texto en inglés' }). Los tipos de identificación comunes se
 * traducen aquí mismo sin llamar a la API (translateIdLocal).
 */

const LEGAL_DISCLAIMER =
  'AVISO LEGAL: Firmaza no es un despacho de abogados y no brinda asesoría ' +
  'legal. Este documento fue generado con el formato que tú elegiste y el ' +
  'texto que tú mismo escribiste — Firmaza no seleccionó ni redactó su ' +
  'contenido legal. Es tu responsabilidad asegurarte de que este documento ' +
  'cumple lo que necesitas. Si tienes dudas legales sobre qué documento usar ' +
  'o qué debe decir, consulta a un abogado con licencia antes de firmarlo.';

const LEGAL_DISCLAIMER_EN =
  'LEGAL NOTICE: Firmaza is not a law firm and does not provide legal advice. ' +
  'This document was generated using the format chosen by the signer and the ' +
  'text the signer wrote. Firmaza did not select or draft its legal content. ' +
  'The signer wrote in Spanish; the signer\'s text was automatically ' +
  'translated into English, and the signer reviewed and approved the ' +
  'translation before signing.';

const TRANSLATION_NOTE_ES =
  'Tu texto fue traducido automáticamente al inglés; tú revisaste y aprobaste ' +
  'la traducción antes de firmar.';

const ALWAYS_BILINGUAL = new Set(['consentimiento_viaje_menor']);

// Campos con texto libre del cliente que hay que traducir al inglés, por
// plantilla ('carta_propia' = modo "Escribir mi propia carta"). Nombres,
// fechas y "Ciudad y estado donde se firma" (lugares de EE.UU.) NO se traducen.
const TRANSLATABLE = {
  carta_poder_simple: ['poderdanteId', 'apoderadoId', 'alcance'],
  consentimiento_viaje_menor: ['padreId', 'destino'],
  declaracion_jurada_generica: ['declaranteId', 'declaracion'],
  carta_propia: ['titulo', 'cuerpo'],
};

// Campos que el cliente debe revisar (con traducción de regreso) antes de
// quedarse con la versión en inglés.
const REVIEW_FIELDS = {
  carta_poder_simple: [['alcance', 'Para qué autorizas']],
  consentimiento_viaje_menor: [['destino', 'Destino del viaje']],
  declaracion_jurada_generica: [['declaracion', 'Lo que declaras bajo juramento']],
  carta_propia: [['titulo', 'Título de la carta'], ['cuerpo', 'Texto de tu carta']],
};

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** 'YYYY-MM-DD' → "October 1, 2026" (en) / "1 de octubre de 2026" (es). */
function formatDate(value, lang) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(value || '');
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  if (mo < 0 || mo > 11) return String(value);
  return lang === 'en' ? `${MONTHS_EN[mo]} ${d}, ${y}` : `${d} de ${MONTHS_ES[mo]} de ${y}`;
}

// Tipos de identificación comunes → inglés, sin llamar a la API. El número
// se deja exactamente igual.
const ID_TYPES = [
  [/^pasaporte mexicano\s*/i, 'Mexican Passport '],
  [/^pasaporte (estadounidense|americano)\s*/i, 'U.S. Passport '],
  [/^pasaporte\s*/i, 'Passport '],
  [/^licencia de (conducir|manejo)\s*/i, 'Driver License '],
  [/^(id|identificaci[oó]n) estatal\s*/i, 'State ID '],
  [/^matr[ií]cula consular\s*/i, 'Consular ID (Matrícula Consular) '],
  [/^(tarjeta de residente|green card|tarjeta de residencia permanente)\s*/i, 'Permanent Resident Card '],
  [/^(ine|credencial (para|de) votar|credencial de elector)\s*/i, 'Mexican Voter ID (INE) '],
];
function translateIdLocal(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // "Licencia de conducir de Missouri #123" → "Missouri Driver License #123"
  const st = t.match(/^(licencia de (?:conducir|manejo)|(?:id|identificaci[oó]n) estatal) de ([A-Za-zÁÉÍÓÚáéíóúñÑ .]+?)\s*(#.*|n[uú]m.*|\d.*)?$/i);
  if (st) {
    const kind = /licencia/i.test(st[1]) ? 'Driver License' : 'State ID';
    return `${st[2].trim()} ${kind}${st[3] ? ' ' + st[3].replace(/^n[uú]m(ero)?\.?\s*/i, '#') : ''}`;
  }
  for (const [re, en] of ID_TYPES) {
    if (re.test(t)) return t.replace(re, en).replace(/\s+/g, ' ').trim();
  }
  return null;
}

/** Qué campos de `values` hay que mandar a lib/translate.js. */
function fieldsToTranslate(templateId, values) {
  const out = {};
  for (const key of TRANSLATABLE[templateId] || []) {
    const val = String(values?.[key] || '').trim();
    if (!val) continue;
    if (/Id$/.test(key) && translateIdLocal(val)) continue; // ya resuelto aquí
    out[key] = val;
  }
  return out;
}

/** Arma el texto en inglés de cada campo: traducción de la API, o
 * diccionario local de IDs, o (si no hay nada) el original. */
function englishValues(values, tr) {
  const out = {};
  for (const [k, v] of Object.entries(values || {})) {
    out[k] = (tr && tr[k]) || (/Id$/.test(k) && translateIdLocal(v)) || v;
  }
  return out;
}

// Piezas comunes -------------------------------------------------------------
const GRAY = 0.42;
const es = (text, extra = {}) => ({ text, size: 9, gray: GRAY, spaceAfter: 12, ...extra }); // línea de referencia en español
const SIGN_DATE_EN = (lugar) => `Signed in ${lugar}, on the _____ day of _______________, ________.`;
const SIGN_DATE_ES = (lugar) => `Firmado en ${lugar}, el _____ de _______________ de ________.`;

function disclaimerBlocks(lang) {
  if (lang === 'es') return [{ text: LEGAL_DISCLAIMER, size: 8, spaceBefore: 20 }];
  return [
    { text: LEGAL_DISCLAIMER_EN, size: 8, spaceBefore: 20, spaceAfter: 6 },
    { text: `${LEGAL_DISCLAIMER} ${TRANSLATION_NOTE_ES}`, size: 8, gray: GRAY },
  ];
}

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
    render(v, { lang = 'es', tr = {} } = {}) {
      if (lang === 'es') {
        return [
          { text: 'CARTA PODER SIMPLE', size: 16, bold: true, align: 'center', spaceAfter: 4 },
          { text: '(Autorización específica — no es un Poder Notarial legal amplio)', size: 9, align: 'center', spaceAfter: 22 },
          { text: `Yo, ${v.poderdanteNombre}, identificado con ${v.poderdanteId}, por medio de la presente autorizo a ${v.apoderadoNombre}${v.apoderadoId ? ` (identificado con ${v.apoderadoId})` : ''} para lo siguiente:`, spaceAfter: 12 },
          { text: v.alcance, spaceAfter: 16 },
          { text: `Esta autorización es válida a partir del ${formatDate(v.fechaInicio, 'es')}${v.fechaFin ? ` y hasta el ${formatDate(v.fechaFin, 'es')}` : ', hasta que yo la revoque por escrito'}.`, spaceAfter: 28 },
          { text: SIGN_DATE_ES(v.lugar), spaceAfter: 40 },
          { text: '_______________________________', spaceAfter: 2 },
          { text: `${v.poderdanteNombre} — Firma de quien autoriza`, size: 9, spaceAfter: 40 },
          ...disclaimerBlocks('es'),
        ];
      }
      const e = englishValues(v, tr);
      return [
        { text: 'SPECIAL AUTHORIZATION LETTER', size: 16, bold: true, align: 'center', spaceAfter: 4 },
        { text: '(Limited, single-purpose authorization — not a general Power of Attorney)', size: 9, align: 'center', spaceAfter: 2 },
        { text: 'Carta poder simple — autorización específica', size: 9, gray: GRAY, align: 'center', spaceAfter: 22 },
        { text: `I, ${v.poderdanteNombre}, identified by ${e.poderdanteId}, hereby authorize ${v.apoderadoNombre}${v.apoderadoId ? ` (identified by ${e.apoderadoId})` : ''} to do the following on my behalf:`, spaceAfter: 4 },
        es(`Yo, ${v.poderdanteNombre}, autorizo a ${v.apoderadoNombre} para lo siguiente en mi nombre:`),
        { text: e.alcance, spaceAfter: 16 },
        { text: `This authorization is valid from ${formatDate(v.fechaInicio, 'en')}${v.fechaFin ? ` until ${formatDate(v.fechaFin, 'en')}` : ' until I revoke it in writing'}.`, spaceAfter: 4 },
        es(`Esta autorización es válida a partir del ${formatDate(v.fechaInicio, 'es')}${v.fechaFin ? ` y hasta el ${formatDate(v.fechaFin, 'es')}` : ', hasta que yo la revoque por escrito'}.`, { spaceAfter: 24 }),
        { text: SIGN_DATE_EN(v.lugar), spaceAfter: 40 },
        { text: '_______________________________', spaceAfter: 2 },
        { text: `${v.poderdanteNombre} — Signature of grantor / Firma de quien autoriza`, size: 9, spaceAfter: 40 },
        ...disclaimerBlocks('en'),
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
    // Siempre bilingüe (ver ALWAYS_BILINGUAL): cada párrafo en inglés y,
    // justo debajo, el mismo párrafo en español. El `lang` se ignora.
    render(v, { tr = {} } = {}) {
      const e = englishValues(v, tr);
      const pair = (en, esText, after = 14) => [
        { text: en, spaceAfter: 4 },
        { text: esText, spaceAfter: after, gray: 0.25 },
      ];
      const lines = [
        { text: 'MINOR TRAVEL CONSENT LETTER', size: 16, bold: true, align: 'center', spaceAfter: 2 },
        { text: 'CARTA DE CONSENTIMIENTO DE VIAJE PARA MENORES', size: 13, bold: true, align: 'center', gray: 0.25, spaceAfter: 6 },
        { text: '(English / Español — both versions have the same content / ambas versiones tienen el mismo contenido)', size: 8, align: 'center', gray: GRAY, spaceAfter: 22 },
        ...pair(
          `I, ${v.padreNombre}, identified by ${e.padreId}, as the parent/legal guardian of the minor ${v.menorNombre}, born on ${formatDate(v.menorNacimiento, 'en')}, hereby authorize the minor to travel to ${e.destino}, from ${formatDate(v.fechaSalida, 'en')} to ${formatDate(v.fechaRegreso, 'en')}.`,
          `Yo, ${v.padreNombre}, identificado con ${v.padreId}, en calidad de padre/madre/tutor legal del menor ${v.menorNombre}, nacido el ${formatDate(v.menorNacimiento, 'es')}, autorizo por medio de la presente a que viaje a ${v.destino}, del ${formatDate(v.fechaSalida, 'es')} al ${formatDate(v.fechaRegreso, 'es')}.`,
        ),
      ];
      if (v.acompananteNombre) {
        lines.push(...pair(
          `The minor will travel accompanied by ${v.acompananteNombre}.`,
          `El menor viajará acompañado de ${v.acompananteNombre}.`,
        ));
      }
      if (v.padreAusenteNombre) {
        lines.push(...pair(
          `The minor's other parent/guardian, ${v.padreAusenteNombre}, is not traveling and is not signing this letter.`,
          `El otro padre/tutor del menor, ${v.padreAusenteNombre}, no viaja ni firma esta carta.`,
        ));
      }
      lines.push(
        ...pair(
          'I declare that this authorization is given voluntarily and that the information provided herein is true.',
          'Declaro que esta autorización es voluntaria y que la información aquí proporcionada es verdadera.',
          24,
        ),
        { text: SIGN_DATE_EN(v.lugar), spaceAfter: 4 },
        { text: SIGN_DATE_ES(v.lugar), spaceAfter: 40, gray: 0.25 },
        { text: '_______________________________', spaceAfter: 2 },
        { text: `${v.padreNombre} — Signature / Firma`, size: 9, spaceAfter: 40 },
        { text: LEGAL_DISCLAIMER_EN, size: 8, spaceBefore: 20, spaceAfter: 6 },
        { text: `${LEGAL_DISCLAIMER} ${TRANSLATION_NOTE_ES}`, size: 8, gray: GRAY },
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
    render(v, { lang = 'es', tr = {} } = {}) {
      if (lang === 'es') {
        return [
          { text: 'DECLARACIÓN JURADA', size: 16, bold: true, align: 'center', spaceAfter: 24 },
          { text: `Yo, ${v.declaranteNombre}, identificado con ${v.declaranteId}, declaro bajo juramento y bajo pena de perjurio lo siguiente:`, spaceAfter: 14 },
          { text: v.declaracion, spaceAfter: 28 },
          { text: SIGN_DATE_ES(v.lugar), spaceAfter: 40 },
          { text: '_______________________________', spaceAfter: 2 },
          { text: `${v.declaranteNombre} — Firma del declarante`, size: 9, spaceAfter: 40 },
          ...disclaimerBlocks('es'),
        ];
      }
      const e = englishValues(v, tr);
      return [
        { text: 'AFFIDAVIT', size: 16, bold: true, align: 'center', spaceAfter: 2 },
        { text: 'Declaración jurada', size: 9, gray: GRAY, align: 'center', spaceAfter: 22 },
        { text: `I, ${v.declaranteNombre}, identified by ${e.declaranteId}, declare under oath and under penalty of perjury the following:`, spaceAfter: 4 },
        es(`Yo, ${v.declaranteNombre}, declaro bajo juramento y bajo pena de perjurio lo siguiente:`, { spaceAfter: 14 }),
        { text: e.declaracion, spaceAfter: 28 },
        { text: SIGN_DATE_EN(v.lugar), spaceAfter: 40 },
        { text: '_______________________________', spaceAfter: 2 },
        { text: `${v.declaranteNombre} — Signature of affiant / Firma del declarante`, size: 9, spaceAfter: 40 },
        ...disclaimerBlocks('en'),
      ];
    },
  },
];

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

function listTemplates() {
  return TEMPLATES.map(({ id, name, description, fields }) => ({
    id, name, description, fields,
    // Para que la vista previa sepa si hay selector de idioma o no.
    alwaysBilingual: ALWAYS_BILINGUAL.has(id),
  }));
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
 * solo le da formato de documento — cero redacción o criterio de Firmaza.
 * En inglés, `tr` trae { titulo, cuerpo } ya traducidos (lib/translate.js). */
function renderCustomLetter({ titulo, cuerpo, autor, lugar }, { lang = 'es', tr = {} } = {}) {
  if (lang === 'es') {
    return [
      { text: (titulo || 'CARTA').toUpperCase(), size: 16, bold: true, align: 'center', spaceAfter: 24 },
      { text: cuerpo, spaceAfter: 28 },
      { text: SIGN_DATE_ES(lugar || '_______________'), spaceAfter: 40 },
      { text: '_______________________________', spaceAfter: 2 },
      { text: `${autor || ''} — Firma`, size: 9, spaceAfter: 40 },
      ...disclaimerBlocks('es'),
    ];
  }
  return [
    { text: (tr.titulo || titulo || 'LETTER').toUpperCase(), size: 16, bold: true, align: 'center', spaceAfter: 2 },
    { text: titulo || 'Carta', size: 9, gray: GRAY, align: 'center', spaceAfter: 22 },
    { text: tr.cuerpo || cuerpo, spaceAfter: 28 },
    { text: SIGN_DATE_EN(lugar || '_______________'), spaceAfter: 40 },
    { text: '_______________________________', spaceAfter: 2 },
    { text: `${autor || ''} — Signature / Firma`, size: 9, spaceAfter: 40 },
    ...disclaimerBlocks('en'),
  ];
}

module.exports = {
  listTemplates, getTemplate, validateValues, renderCustomLetter, LEGAL_DISCLAIMER,
  // Idiomas
  ALWAYS_BILINGUAL, REVIEW_FIELDS, fieldsToTranslate, translateIdLocal, formatDate,
};
