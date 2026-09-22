/**
 * Capa de persistencia real — Postgres (Render Postgres).
 * =============================================================================
 * Reemplaza el almacenamiento anterior (archivos JSON en `data/`), que vivía
 * en el disco del propio contenedor de Render. Sin un disco persistente
 * adjunto, ese disco se reinicia desde cero en cada deploy y en cada
 * reinicio del servicio — así que cualquier cuenta de cliente, sesión de
 * notarización, documento o firma se perdía por completo. Esta capa guarda
 * todo eso en una base de datos Postgres real, que sobrevive deploys,
 * reinicios y crecimiento del proyecto.
 *
 * Requiere la variable de entorno DATABASE_URL (Render la genera sola al
 * crear un Postgres y enlazarlo a este servicio).
 *
 * Todas las funciones son asíncronas (devuelven Promesas) porque ahora cada
 * lectura/escritura es una consulta de red a la base de datos, a diferencia
 * de leer/escribir un archivo local.
 */
const { Pool } = require('pg');

let pool = null;
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('Falta DATABASE_URL — configúrala en las variables de entorno de Render (o en tu .env local) apuntando a tu base de datos Postgres.');
    }
    pool = new Pool({
      connectionString,
      // Render exige TLS para las conexiones externas a su Postgres; con la
      // URL interna (misma región) también funciona sin problema.
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

// `client`, cuando se pasa, es un cliente de conexión ya sacado del pool
// (dentro de una transacción — ver withSessionLock más abajo). Cuando se
// omite, cada llamada toma cualquier conexión libre del pool, como antes.
async function query(text, params, client) {
  return (client || getPool()).query(text, params);
}

// ---------------------------------------------------------------------------
// Creación de tablas — se corre una vez al arrancar el servidor (ver
// server.js). Usa "IF NOT EXISTS" en todo, así que es seguro llamarla en
// cada arranque sin duplicar ni borrar nada.
// ---------------------------------------------------------------------------
async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      signer_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'es',
      status TEXT NOT NULL DEFAULT 'iniciada',
      document JSONB,
      identity JSONB,
      payment JSONB,
      signature JSONB,
      notary_id TEXT,
      room_id TEXT,
      proof JSONB,
      history JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE IF NOT EXISTS clients (
      email TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      nucleo JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS magic_links (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS login_sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      client_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      content_type TEXT,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions ((lower(email)));
    CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links ((lower(email)));
    -- owner_token: ver setSessionOwnerToken()/getSessionOwnerToken() más abajo.
    -- ALTER ... IF NOT EXISTS (en vez de agregarla a la CREATE TABLE de arriba)
    -- porque esa CREATE TABLE tiene IF NOT EXISTS: en una base ya existente no
    -- se vuelve a ejecutar, así que la única forma de que las sesiones que ya
    -- existen (creadas por un despliegue anterior) reciban la columna nueva es
    -- con un ALTER TABLE explícito.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_token TEXT;
  `);
}

// ---------------------------------------------------------------------------
// Sesiones de notarización
// ---------------------------------------------------------------------------
function rowToSession(r) {
  if (!r) return null;
  return {
    id: r.id,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    signerName: r.signer_name || '',
    email: r.email || '',
    language: r.language || 'es',
    status: r.status,
    document: r.document || null,
    identity: r.identity || null,
    payment: r.payment || null,
    signature: r.signature || null,
    notaryId: r.notary_id || null,
    roomId: r.room_id || null,
    proof: r.proof || null,
    history: r.history || [],
  };
}

async function getSession(id, client) {
  const { rows } = await query('SELECT * FROM sessions WHERE id = $1', [id], client);
  return rowToSession(rows[0]);
}

// El token de "dueño" de una sesión (ver verifySessionOwnership() en
// server.js) se mantiene TOTALMENTE aparte del objeto de sesión que
// getSession()/rowToSession() devuelven, a propósito: ese objeto es
// exactamente lo que server.js manda de vuelta al navegador en cada
// respuesta (`send(res, 200, { session: s })`) — si el token viviera ahí,
// bastaría con conocer el id de la sesión (que sí puede filtrarse por otros
// medios) para pedir el estado de la sesión y recibir de regalo el propio
// secreto que se supone protege las mutaciones. getSessionOwnerToken() es
// la única forma de leerlo, y solo server.js la usa, nunca para construir
// una respuesta.
async function getSessionOwnerToken(id, client) {
  const { rows } = await query('SELECT owner_token FROM sessions WHERE id = $1', [id], client);
  return rows[0]?.owner_token || null;
}

// Se llama una sola vez, justo después de crear una sesión nueva. El
// "WHERE owner_token IS NULL" no es solo defensivo: dejar el token fijo
// desde la creación (y nunca reescribible después) es lo que lo hace útil
// como prueba de "quién la creó" — si cualquier ruta pudiera reemplazarlo
// más adelante, alguien que ya hubiera perdido el control de la sesión
// podría, en teoría, "recuperarla" con un segundo POST.
async function setSessionOwnerToken(id, token, client) {
  await query('UPDATE sessions SET owner_token = $2 WHERE id = $1 AND owner_token IS NULL', [id, token], client);
}

async function getSessionsByEmail(email) {
  const { rows } = await query('SELECT * FROM sessions WHERE lower(email) = lower($1) ORDER BY created_at DESC', [email]);
  return rows.map(rowToSession);
}

async function getSessionsByStatuses(statuses) {
  const { rows } = await query('SELECT * FROM sessions WHERE status = ANY($1::text[]) ORDER BY created_at DESC', [statuses]);
  return rows.map(rowToSession);
}

async function getSessionByProofTransactionId(transactionId) {
  const { rows } = await query(`SELECT * FROM sessions WHERE proof->>'transactionId' = $1 LIMIT 1`, [transactionId]);
  return rowToSession(rows[0]);
}

// Crea o actualiza (upsert) una sesión completa. Se llama después de mutar
// el objeto de sesión en memoria, igual que antes se llamaba saveSessions().
//
// IMPORTANTE — esto reemplaza la fila COMPLETA con el snapshot en memoria
// que trae `s`. getSession()+mutar+saveSession() es un patrón de
// leer-modificar-guardar clásico: si dos peticiones hacen esa secuencia casi
// al mismo tiempo para la MISMA sesión (p. ej. un doble clic en "pagar", que
// crea dos órdenes de Square casi simultáneas), ambas leen el mismo estado
// inicial y la segunda en terminar de escribir pisa en silencio los cambios
// de la primera — se puede perder un orderId, una firma, un cambio de
// estado, etc. sin ningún error visible. Por eso casi ningún llamador debe
// usar esta función directamente: deben pasar por withSessionLock() (ver
// abajo), que serializa el ciclo completo leer-modificar-guardar por sesión.
async function saveSession(s, client) {
  await query(
    `INSERT INTO sessions (id, created_at, signer_name, email, language, status, document, identity, payment, signature, notary_id, room_id, proof, history)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       signer_name = EXCLUDED.signer_name,
       email = EXCLUDED.email,
       language = EXCLUDED.language,
       status = EXCLUDED.status,
       document = EXCLUDED.document,
       identity = EXCLUDED.identity,
       payment = EXCLUDED.payment,
       signature = EXCLUDED.signature,
       notary_id = EXCLUDED.notary_id,
       room_id = EXCLUDED.room_id,
       proof = EXCLUDED.proof,
       history = EXCLUDED.history`,
    [
      s.id,
      s.createdAt || new Date().toISOString(),
      s.signerName || '',
      s.email || '',
      s.language || 'es',
      s.status,
      s.document != null ? JSON.stringify(s.document) : null,
      s.identity != null ? JSON.stringify(s.identity) : null,
      s.payment != null ? JSON.stringify(s.payment) : null,
      s.signature != null ? JSON.stringify(s.signature) : null,
      s.notaryId || null,
      s.roomId || null,
      s.proof != null ? JSON.stringify(s.proof) : null,
      JSON.stringify(s.history || []),
    ],
    client
  );
  return s;
}

// Serializa el ciclo leer-modificar-guardar de UNA sesión, para que dos
// peticiones que mutan la misma sesión casi al mismo tiempo no se pisen. En
// vez de un bloqueo a nivel de fila (que exigiría reestructurar cada ruta
// para compartir una sola transacción de principio a fin, incluidas
// llamadas lentas a Square/Proof.com), usa un advisory lock de Postgres
// (pg_advisory_xact_lock) con una clave derivada del id de la sesión:
// - Solo bloquea a otra petición que intente lo mismo con el MISMO id de
//   sesión — peticiones sobre otras sesiones, y lecturas sueltas que no
//   pasan por aquí (como el GET simple de una sesión), no se ven afectadas.
// - El lock es "xact" (de transacción): se libera solo con COMMIT/ROLLBACK,
//   así que no hace falta liberarlo a mano ni arriesgarse a dejarlo colgado
//   si algo lanza una excepción a medio camino.
// - `fn` recibe getSession/saveSession ya atados a esa misma conexión y
//   transacción, para que la lectura de adentro vea el estado más reciente
//   ya confirmado (no una copia vieja de antes del lock) y la escritura
//   quede dentro de la misma transacción.
//
// Nota de costo: mientras `fn` esté corriendo (incluida cualquier llamada
// de red lenta a Square/Proof.com que haga), esta conexión queda apartada
// del pool y el lock sigue tomado — así que otra petición sobre la MISMA
// sesión espera hasta que termine. Para el volumen de tráfico de Firmaza
// esto es aceptable (es exactamente el caso — doble clic, reintentos — que
// se quiere serializar); si el tráfico creciera mucho valdría la pena medir
// el tamaño del pool de conexiones.
async function withSessionLock(id, fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
    const result = await fn({
      getSession: () => getSession(id, client),
      saveSession: (s) => saveSession(s, client),
    });
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Clientes (cuentas de firmante)
// ---------------------------------------------------------------------------
function defaultNucleo() {
  return { nombreCompleto: '', telefono: '', direccion: '', ciudad: '', estado: '', codigoPostal: '', familiares: [], notas: '' };
}
function rowToClient(r) {
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    nucleo: r.nucleo || defaultNucleo(),
  };
}

async function getClientByEmail(email) {
  const { rows } = await query('SELECT * FROM clients WHERE lower(email) = lower($1)', [email]);
  return rowToClient(rows[0]);
}

// Crea el cliente si no existe (usado al validar el enlace mágico por
// primera vez). Si ya existe, no toca nada — devuelve el cliente tal cual.
async function createClientIfMissing(email, id, createdAt) {
  await query(
    `INSERT INTO clients (email, id, created_at, nucleo)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (email) DO NOTHING`,
    [email, id, createdAt || new Date().toISOString(), JSON.stringify(defaultNucleo())]
  );
  return getClientByEmail(email);
}

async function updateClientNucleo(email, nucleo) {
  await query('UPDATE clients SET nucleo = $2::jsonb WHERE lower(email) = lower($1)', [email, JSON.stringify(nucleo)]);
  return getClientByEmail(email);
}

// ---------------------------------------------------------------------------
// Autenticación sin contraseña (enlace mágico)
// ---------------------------------------------------------------------------
async function createMagicLink(token, email, expiresAt) {
  await query(
    'INSERT INTO magic_links (token, email, created_at, expires_at, used) VALUES ($1,$2,now(),$3,false)',
    [token, email, expiresAt]
  );
  // Limpieza oportunista de enlaces viejos (ya usados o vencidos hace rato)
  // para que la tabla no crezca sin límite — no es crítico, así que si falla
  // no debe tumbar la petición principal.
  query("DELETE FROM magic_links WHERE used = true OR expires_at < now() - interval '1 day'").catch(() => {});
}

async function getMagicLink(token) {
  const { rows } = await query('SELECT * FROM magic_links WHERE token = $1', [token]);
  const r = rows[0];
  if (!r) return null;
  return {
    token: r.token,
    email: r.email,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    used: r.used,
  };
}

async function markMagicLinkUsed(token) {
  await query('UPDATE magic_links SET used = true WHERE token = $1', [token]);
}

async function countActiveMagicLinksForEmail(email) {
  const { rows } = await query(
    "SELECT count(*)::int AS n FROM magic_links WHERE lower(email) = lower($1) AND used = false AND expires_at > now()",
    [email]
  );
  return rows[0]?.n || 0;
}

async function createLoginSession(token, email, clientId, expiresAt) {
  await query(
    'INSERT INTO login_sessions (token, email, client_id, created_at, expires_at) VALUES ($1,$2,$3,now(),$4)',
    [token, email, clientId, expiresAt]
  );
  query("DELETE FROM login_sessions WHERE expires_at < now()").catch(() => {});
}

async function getLoginSession(token) {
  const { rows } = await query('SELECT * FROM login_sessions WHERE token = $1 AND expires_at > now()', [token]);
  const r = rows[0];
  if (!r) return null;
  return { token: r.token, email: r.email, clientId: r.client_id, expiresAt: r.expires_at };
}

async function deleteLoginSession(token) {
  await query('DELETE FROM login_sessions WHERE token = $1', [token]);
}

// ---------------------------------------------------------------------------
// Archivos (documentos subidos, PDFs generados, firmas) — antes vivían como
// archivos sueltos en data/uploads/; ahora se guardan como bytea en la
// propia base de datos, así que también sobreviven a los deploys.
// ---------------------------------------------------------------------------
async function saveFile(id, buffer, contentType) {
  await query(
    `INSERT INTO files (id, content_type, data) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data`,
    [id, contentType || 'application/octet-stream', buffer]
  );
}

async function getFile(id) {
  const { rows } = await query('SELECT content_type, data FROM files WHERE id = $1', [id]);
  const r = rows[0];
  if (!r) return null;
  return { contentType: r.content_type, data: r.data };
}

module.exports = {
  migrate,
  defaultNucleo,
  // sesiones
  getSession,
  getSessionsByEmail,
  getSessionsByStatuses,
  getSessionByProofTransactionId,
  saveSession,
  withSessionLock,
  getSessionOwnerToken,
  setSessionOwnerToken,
  // clientes
  getClientByEmail,
  createClientIfMissing,
  updateClientNucleo,
  // auth
  createMagicLink,
  getMagicLink,
  markMagicLinkUsed,
  countActiveMagicLinksForEmail,
  createLoginSession,
  getLoginSession,
  deleteLoginSession,
  // archivos
  saveFile,
  getFile,
};
