// Nombres de firmantes: separar/validar/unir nombre, segundo nombre y apellidos.
// Proof.com acepta first_name, middle_name y last_name por separado, y bloquea
// el nombre en su pantalla de verificación, así que tiene que llegar bien partido.

const MAX_NAME_PART_LENGTH = 30; // límite de Proof por campo

// Partículas que van pegadas a la palabra siguiente ("de la Torre", "van Gogh").
const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'das', 'do', 'dos', 'di', 'van', 'von', 'san', 'santa']);

function clean(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
}

// Agrupa las partículas con la palabra que sigue: ["Juan","de","la","Torre"] → ["Juan","de la Torre"].
function nameBlocks(full) {
  const words = clean(full).split(' ').filter(Boolean);
  const blocks = [];
  let pending = [];
  for (const w of words) {
    pending.push(w);
    if (!PARTICLES.has(w.toLowerCase())) {
      blocks.push(pending.join(' '));
      pending = [];
    }
  }
  if (pending.length) blocks.push(pending.join(' ')); // partículas al final, sin palabra siguiente
  return blocks;
}

function splitFullName(full) {
  const blocks = nameBlocks(full);
  if (!blocks.length) return { first: '', middle: '', last: '' };
  if (blocks.length === 1) return { first: blocks[0], middle: '', last: '' };
  if (blocks.length >= 4) {
    return {
      first: blocks[0],
      middle: blocks.slice(1, -2).join(' '),
      last: blocks.slice(-2).join(' '),
    };
  }
  return { first: blocks[0], middle: '', last: blocks.slice(1).join(' ') };
}

function normalizeNameParts(parts) {
  const p = parts && typeof parts === 'object' ? parts : {};
  const out = { first: clean(p.first), middle: clean(p.middle), last: clean(p.last) };
  if (!out.first && !out.last) return null;
  return out;
}

// Devuelve un mensaje de error en español, o null si todo está bien.
function validateNameParts(parts) {
  const p = normalizeNameParts(parts);
  if (!p || !p.first) return 'Escribe tu nombre.';
  if (!p.last) return 'Escribe tus apellidos.';
  const labels = { first: 'El nombre', middle: 'El segundo nombre', last: 'Los apellidos' };
  for (const k of ['first', 'middle', 'last']) {
    if (p[k].length > MAX_NAME_PART_LENGTH) {
      return `${labels[k]} no puede tener más de ${MAX_NAME_PART_LENGTH} caracteres.`;
    }
  }
  return null;
}

function joinNameParts(parts) {
  const p = normalizeNameParts(parts);
  if (!p) return '';
  return [p.first, p.middle, p.last].filter(Boolean).join(' ');
}

function toProofName(parts) {
  const p = normalizeNameParts(parts);
  if (!p) return {};
  const out = {};
  if (p.first) out.first_name = p.first;
  if (p.middle) out.middle_name = p.middle;
  if (p.last) out.last_name = p.last;
  return out;
}

module.exports = {
  MAX_NAME_PART_LENGTH,
  splitFullName,
  normalizeNameParts,
  validateNameParts,
  joinNameParts,
  toProofName,
};
