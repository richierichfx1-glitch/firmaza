/**
 * Generador mínimo de PDF — sin dependencias externas.
 * =============================================================================
 * Proof.com solo acepta documentos en PDF o DOCX (ver
 * https://dev.proof.com/docs/documents-overview). Este proyecto está escrito
 * deliberadamente sin `node_modules` (ver README), y este sandbox tampoco
 * tiene salida a registry.npmjs.org, así que no se puede instalar `pdfkit` ni
 * similares. En vez de eso, este archivo arma un PDF válido a mano: es un
 * formato de texto bien documentado (objetos indirectos + tabla xref +
 * trailer), y para texto simple con las 14 fuentes base (Helvetica/Bold) no
 * hace falta ninguna librería — los lectores de PDF ya las traen integradas.
 *
 * Soporta: texto con salto de línea automático (usando las métricas reales
 * de Helvetica), negritas, párrafos, y paginación automática cuando el
 * contenido no cabe en una página carta (Letter, 612x792pt).
 *
 * No soporta (a propósito, no hace falta para esto): imágenes, tablas,
 * fuentes personalizadas, compresión de streams. Si más adelante se necesita
 * algo más avanzado, este es el punto para cambiar a una librería real (ya
 * con `node_modules`, por ejemplo si el hosting de producción sí tiene
 * acceso a npm).
 */

const PAGE_WIDTH = 612;   // 8.5in a 72pt/in (carta / Letter)
const PAGE_HEIGHT = 792;  // 11in
const MARGIN = 64;

// Anchos de caracter de Helvetica (unidades por 1000em, WinAnsiEncoding).
// Son datos numéricos de métrica de fuente estándar (Adobe Core 14),
// idénticos en cualquier lector de PDF — no son contenido creativo de nadie.
const HELVETICA_WIDTHS = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556,
  64: 1015,
  65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778, 72: 722,
  73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778, 80: 667,
  81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944, 88: 667,
  89: 667, 90: 611,
  91: 278, 92: 278, 93: 278, 94: 469, 95: 556, 96: 333,
  97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556,
  104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833, 110: 556,
  111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278, 117: 556,
  118: 500, 119: 722, 120: 500, 121: 500, 122: 500,
  123: 334, 124: 260, 125: 334, 126: 584,
  // Latin-1 / WinAnsi — acentos y signos usados en español.
  161: 333, // ¡
  191: 556, // ¿
  193: 667, 201: 667, 205: 278, 211: 778, 218: 722, 209: 722, 220: 722, // Á É Í Ó Ú Ñ Ü
  225: 556, 233: 556, 237: 222, 243: 556, 250: 556, 241: 556, 252: 556, // á é í ó ú ñ ü
  150: 600, // en dash (–)
  151: 1000, // em dash (—)
  145: 191, 146: 191, // comillas simples curvas
  147: 333, 148: 333, // comillas dobles curvas
};
const DEFAULT_WIDTH = 556;

function charWidth(code) {
  return HELVETICA_WIDTHS[code] !== undefined ? HELVETICA_WIDTHS[code] : DEFAULT_WIDTH;
}

// WinAnsiEncoding (lo que declaramos en la fuente) usa Windows-1252, donde
// la raya (—), el guion medio (–) y las comillas curvas NO están en los
// mismos códigos que Unicode. Sin este mapeo, esos caracteres se corrompen
// o desaparecen al convertir a latin1. Se aplica antes de todo lo demás.
const UNICODE_TO_WINANSI = {
  '—': String.fromCharCode(151), // —
  '–': String.fromCharCode(150), // –
  '‘': String.fromCharCode(145), '’': String.fromCharCode(146), // ' '
  '“': String.fromCharCode(147), '”': String.fromCharCode(148), // " "
  '…': '...', // …
};
function sanitizeForWinAnsi(text) {
  return String(text || '').replace(/[—–‘’“”…]/g, (ch) => UNICODE_TO_WINANSI[ch]);
}

function textWidthPt(text, sizePt) {
  let units = 0;
  for (let i = 0; i < text.length; i++) units += charWidth(text.charCodeAt(i));
  return (units / 1000) * sizePt;
}

// Convierte texto a Latin-1 (compatible con WinAnsiEncoding para español) y
// escapa los caracteres especiales de las cadenas PDF: ( ) \
function pdfEscape(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

// Parte `text` en líneas que quepan en `maxWidth` puntos, respetando saltos
// de línea explícitos (\n) que ya traiga el texto.
function wrapText(text, sizePt, maxWidth) {
  const lines = [];
  for (const paragraph of String(text || '').split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidthPt(candidate, sizePt) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * `blocks`: array de { text, size?, bold?, spaceBefore?, spaceAfter?, align? }
 * `align` soporta 'left' (por defecto) y 'center'.
 * Devuelve un Buffer con el PDF completo.
 */
function renderPdf(blocks) {
  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  const lineHeightFactor = 1.32;

  // 1) Aplanar bloques a líneas individuales con su fuente/tamaño.
  const lines = []; // { text, size, bold, align, lineHeight, spaceBefore }
  for (const block of blocks) {
    const size = block.size || 11;
    const bold = !!block.bold;
    const wrapped = wrapText(sanitizeForWinAnsi(block.text), size, maxWidth);
    wrapped.forEach((text, idx) => {
      lines.push({
        text,
        size,
        bold,
        align: block.align || 'left',
        lineHeight: size * lineHeightFactor,
        spaceBefore: idx === 0 ? (block.spaceBefore || 0) : 0,
      });
    });
    if (block.spaceAfter) lines[lines.length - 1].extraAfter = block.spaceAfter;
  }

  // 2) Paginar: cortar en páginas cuando no quepa la siguiente línea.
  const pages = [[]];
  let y = PAGE_HEIGHT - MARGIN;
  for (const line of lines) {
    const need = line.lineHeight + line.spaceBefore;
    if (y - need < MARGIN) {
      pages.push([]);
      y = PAGE_HEIGHT - MARGIN;
    }
    y -= line.spaceBefore;
    pages[pages.length - 1].push({ ...line, y });
    y -= line.lineHeight;
    if (line.extraAfter) y -= line.extraAfter;
  }

  // 3) Construir el stream de contenido de cada página.
  const pageStreams = pages.map((pageLines) => {
    let ops = [];
    let currentFont = null;
    let currentSize = null;
    for (const line of pageLines) {
      if (!line.text) continue;
      const font = line.bold ? 'F2' : 'F1';
      const x = line.align === 'center'
        ? MARGIN + (maxWidth - textWidthPt(line.text, line.size)) / 2
        : MARGIN;
      if (font !== currentFont || line.size !== currentSize) {
        ops.push(`/${font} ${line.size} Tf`);
        currentFont = font; currentSize = line.size;
      }
      ops.push(`1 0 0 1 ${x.toFixed(2)} ${line.y.toFixed(2)} Tm`);
      ops.push(`(${pdfEscape(line.text)}) Tj`);
    }
    return `BT\n${ops.join('\n')}\nET`;
  });

  // 4) Ensamblar objetos PDF (xref + trailer).
  const objects = [];
  const catalogIdx = objects.push('') - 1;
  const pagesIdx = objects.push('') - 1;
  const fontRegularIdx = objects.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  ) - 1;
  const fontBoldIdx = objects.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  ) - 1;

  const pageObjIdxs = [];
  const contentObjIdxs = [];
  for (const stream of pageStreams) {
    const contentBytes = Buffer.from(stream, 'latin1');
    const contentIdx = objects.push(
      `<< /Length ${contentBytes.length} >>\nstream\n${stream}\nendstream`
    ) - 1;
    contentObjIdxs.push(contentIdx);
    const pageIdx = objects.push('') - 1; // se completa abajo, ya con el número de objeto de Pages
    pageObjIdxs.push(pageIdx);
  }
  pageObjIdxs.forEach((pageIdx, i) => {
    objects[pageIdx] =
      `<< /Type /Page /Parent ${pagesIdx + 1} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${fontRegularIdx + 1} 0 R /F2 ${fontBoldIdx + 1} 0 R >> >> ` +
      `/Contents ${contentObjIdxs[i] + 1} 0 R >>`;
  });

  objects[catalogIdx] = `<< /Type /Catalog /Pages ${pagesIdx + 1} 0 R >>`;
  objects[pagesIdx] =
    `<< /Type /Pages /Kids [${pageObjIdxs.map((i) => `${i + 1} 0 R`).join(' ')}] /Count ${pageObjIdxs.length} >>`;

  // 5) Serializar con tabla xref correcta.
  const chunks = ['%PDF-1.4\n'];
  const offsets = [0]; // el objeto 0 es especial (free list head)
  let pos = Buffer.byteLength(chunks[0], 'latin1');
  objects.forEach((body, i) => {
    offsets.push(pos);
    const objStr = `${i + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(objStr);
    pos += Buffer.byteLength(objStr, 'latin1');
  });
  const xrefStart = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  chunks.push(xref);
  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogIdx + 1} 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF`
  );

  return Buffer.from(chunks.join(''), 'latin1');
}

module.exports = { renderPdf, wrapText, textWidthPt };
