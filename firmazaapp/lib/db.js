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
    -- Programa de referidos (influencers). Ver "Referidos" más abajo y la
    -- nota junto a REFERRAL_DISCOUNT_CENTS en server.js.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS referral JSONB;
    -- Nombre del firmante separado (first/middle/last) para Proof.com.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS signer_name_parts JSONB;
    CREATE TABLE IF NOT EXISTS referral_codes (
      code TEXT PRIMARY KEY,               -- siempre en MAYÚSCULAS
      influencer_name TEXT NOT NULL,
      influencer_email TEXT NOT NULL DEFAULT '',
      payout_info TEXT NOT NULL DEFAULT '', -- p. ej. "Zelle 816-555-1234"
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS referral_payouts (
      code TEXT NOT NULL,
      month TEXT NOT NULL,                 -- 'YYYY-MM' del mes en que se ganó la comisión
      amount_cents INTEGER NOT NULL,
      referrals INTEGER NOT NULL,
      paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      note TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (code, month)
    );
    -- purpose: 'client' (cuenta de cliente) o 'admin' (página /admin/referidos).
    ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'client';
    CREATE INDEX IF NOT EXISTS idx_sessions_referral_code ON sessions ((referral->>'code'));
    -- Estadísticas del sitio (panel /admin/referidos → pestaña Resumen).
    -- Sin cookies ni datos personales: visitor es un hash diario de IP +
    -- navegador (cambia cada día, no se puede revertir a la IP).
    CREATE TABLE IF NOT EXISTS page_views (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      path TEXT NOT NULL,
      visitor TEXT NOT NULL,
      referrer_host TEXT NOT NULL DEFAULT '',
      ref_code TEXT,
      device TEXT NOT NULL DEFAULT '',
      load_ms INTEGER,
      ttfb_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_page_views_at ON page_views (at);
    CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at);
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
    referral: r.referral || null,
    signerNameParts: r.signer_name_parts || null,
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
    `INSERT INTO sessions (id, created_at, signer_name, email, language, status, document, identity, payment, signature, notary_id, room_id, proof, history, referral, signer_name_parts)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb)
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
       history = EXCLUDED.history,
       referral = EXCLUDED.referral,
       signer_name_parts = EXCLUDED.signer_name_parts`,
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
      s.referral != null ? JSON.stringify(s.referral) : null,
      s.signerNameParts != null ? JSON.stringify(s.signerNameParts) : null,
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
async function createMagicLink(token, email, expiresAt, purpose = 'client') {
  await query(
    'INSERT INTO magic_links (token, email, created_at, expires_at, used, purpose) VALUES ($1,$2,now(),$3,false,$4)',
    [token, email, expiresAt, purpose]
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
    purpose: r.purpose || 'client',
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

// ---------------------------------------------------------------------------
// Referidos (códigos de influencer)
// ---------------------------------------------------------------------------
function rowToReferralCode(r) {
  if (!r) return null;
  return {
    code: r.code,
    influencerName: r.influencer_name,
    influencerEmail: r.influencer_email || '',
    payoutInfo: r.payout_info || '',
    active: r.active,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

async function getReferralCode(code) {
  const { rows } = await query('SELECT * FROM referral_codes WHERE code = upper($1)', [code]);
  return rowToReferralCode(rows[0]);
}

async function listReferralCodes() {
  const { rows } = await query('SELECT * FROM referral_codes ORDER BY created_at DESC');
  return rows.map(rowToReferralCode);
}

async function createReferralCode({ code, influencerName, influencerEmail, payoutInfo }) {
  const { rows } = await query(
    `INSERT INTO referral_codes (code, influencer_name, influencer_email, payout_info)
     VALUES (upper($1),$2,$3,$4) ON CONFLICT (code) DO NOTHING RETURNING *`,
    [code, influencerName, influencerEmail || '', payoutInfo || '']
  );
  return rowToReferralCode(rows[0]);
}

async function updateReferralCode(code, { active, payoutInfo, influencerEmail, influencerName }) {
  const { rows } = await query(
    `UPDATE referral_codes SET
       active = COALESCE($2, active),
       payout_info = COALESCE($3, payout_info),
       influencer_email = COALESCE($4, influencer_email),
       influencer_name = COALESCE($5, influencer_name)
     WHERE code = upper($1) RETURNING *`,
    [code, active ?? null, payoutInfo ?? null, influencerEmail ?? null, influencerName ?? null]
  );
  return rowToReferralCode(rows[0]);
}

// ¿Este correo ya usó ALGÚN código de referido en una sesión pagada? (El
// descuento es solo para la primera notarización de cada cliente.) Se
// excluye la sesión actual para que recargar la página no cuente doble.
async function emailAlreadyUsedReferral(email, excludeSessionId) {
  const { rows } = await query(
    `SELECT 1 FROM sessions
     WHERE lower(email) = lower($1) AND id <> $2
       AND referral IS NOT NULL AND payment->>'paidAt' IS NOT NULL
     LIMIT 1`,
    [email, excludeSessionId || '']
  );
  return rows.length > 0;
}

// Sesiones que generaron comisión en un mes ('YYYY-MM', hora de Kansas
// City): pagadas con Square, notarización completada, sin reembolso.
async function getEarnedReferralSessions(month) {
  const { rows } = await query(
    `SELECT id, email, signer_name, referral, payment FROM sessions
     WHERE referral->>'earnedAt' IS NOT NULL
       AND to_char((referral->>'earnedAt')::timestamptz AT TIME ZONE 'America/Chicago', 'YYYY-MM') = $1
       AND payment->>'mode' = 'square'
       AND payment->'refund' IS NULL
     ORDER BY referral->>'earnedAt'`,
    [month]
  );
  return rows.map((r) => ({
    sessionId: r.id,
    email: r.email,
    signerName: r.signer_name,
    code: r.referral.code,
    commissionCents: r.referral.commissionCents,
    earnedAt: r.referral.earnedAt,
    paidAmount: r.payment?.amount ?? null,
  }));
}

async function getReferralPayouts(month) {
  const { rows } = await query('SELECT * FROM referral_payouts WHERE month = $1', [month]);
  return rows.map((r) => ({
    code: r.code, month: r.month, amountCents: r.amount_cents, referrals: r.referrals,
    paidAt: r.paid_at instanceof Date ? r.paid_at.toISOString() : r.paid_at, note: r.note,
  }));
}

async function markReferralPayoutPaid({ code, month, amountCents, referrals, note }) {
  const { rows } = await query(
    `INSERT INTO referral_payouts (code, month, amount_cents, referrals, note)
     VALUES (upper($1),$2,$3,$4,$5) ON CONFLICT (code, month) DO NOTHING RETURNING *`,
    [code, month, amountCents, referrals, note || '']
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Estadísticas (solo administrador)
// ---------------------------------------------------------------------------
const TZ = 'America/Chicago';

async function recordPageView({ path, visitor, referrerHost, refCode, device, loadMs, ttfbMs }) {
  await query(
    `INSERT INTO page_views (path, visitor, referrer_host, ref_code, device, load_ms, ttfb_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [path, visitor, referrerHost || '', refCode || null, device || '', loadMs ?? null, ttfbMs ?? null]
  );
  // Limpieza oportunista: se guardan ~13 meses de visitas.
  if (Math.random() < 0.01) query("DELETE FROM page_views WHERE at < now() - interval '400 days'").catch(() => {});
}

async function getSiteStats(days) {
  const since = `now() - ($1::int * interval '1 day')`;
  const [traffic, daily, pages, referrers, devices, perf, notarAll, notarRange, statuses, notarDaily, revenue] = await Promise.all([
    query(`SELECT count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM page_views WHERE at >= ${since}`, [days]),
    query(`SELECT to_char(at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day, count(*)::int AS views, count(DISTINCT visitor)::int AS visitors
           FROM page_views WHERE at >= ${since} GROUP BY 1 ORDER BY 1`, [days]),
    query(`SELECT path, count(*)::int AS views FROM page_views WHERE at >= ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [days]),
    query(`SELECT CASE WHEN referrer_host = '' THEN 'Directo / sin origen' ELSE referrer_host END AS source, count(*)::int AS views
           FROM page_views WHERE at >= ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [days]),
    query(`SELECT device, count(DISTINCT visitor)::int AS visitors FROM page_views WHERE at >= ${since} GROUP BY 1 ORDER BY 2 DESC`, [days]),
    query(`SELECT count(load_ms)::int AS samples,
                  round(avg(load_ms))::int AS avg_load,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY load_ms)::int AS p50_load,
                  percentile_cont(0.75) WITHIN GROUP (ORDER BY load_ms)::int AS p75_load,
                  round(avg(ttfb_ms))::int AS avg_ttfb
           FROM page_views WHERE at >= ${since} AND load_ms IS NOT NULL AND load_ms BETWEEN 0 AND 120000`, [days]),
    query(`SELECT count(*) FILTER (WHERE status = 'notarizacion_completada')::int AS completed,
                  count(*)::int AS sessions FROM sessions`),
    query(`SELECT count(*)::int AS sessions,
                  count(*) FILTER (WHERE payment->>'paidAt' IS NOT NULL)::int AS paid,
                  count(*) FILTER (WHERE status = 'notarizacion_completada')::int AS completed,
                  count(*) FILTER (WHERE status = 'notarizacion_rechazada')::int AS rejected,
                  count(*) FILTER (WHERE payment->'refund' IS NOT NULL)::int AS refunded
           FROM sessions WHERE created_at >= ${since}`, [days]),
    query(`SELECT status, count(*)::int AS n FROM sessions WHERE created_at >= ${since} GROUP BY 1 ORDER BY 2 DESC`, [days]),
    query(`SELECT to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day,
                  count(*)::int AS started,
                  count(*) FILTER (WHERE status = 'notarizacion_completada')::int AS completed
           FROM sessions WHERE created_at >= ${since} GROUP BY 1 ORDER BY 1`, [days]),
    query(`SELECT coalesce(sum((payment->>'amount')::numeric), 0)::float AS dollars
           FROM sessions WHERE created_at >= ${since} AND payment->>'mode' = 'square'
             AND payment->>'paidAt' IS NOT NULL AND payment->'refund' IS NULL`, [days]),
  ]);
  return {
    traffic: traffic.rows[0],
    daily: daily.rows,
    pages: pages.rows,
    referrers: referrers.rows,
    devices: devices.rows,
    performance: perf.rows[0],
    notarizations: {
      allTime: notarAll.rows[0],
      range: notarRange.rows[0],
      statuses: statuses.rows,
      daily: notarDaily.rows,
      revenueDollars: revenue.rows[0].dollars,
    },
  };
}

// Estadísticas de todos los tiempos por código de referido.
async function getReferralStats() {
  const [usage, visits, payouts] = await Promise.all([
    query(`SELECT referral->>'code' AS code,
                  count(*)::int AS applied,
                  count(*) FILTER (WHERE payment->>'paidAt' IS NOT NULL)::int AS paid,
                  count(*) FILTER (WHERE referral->>'earnedAt' IS NOT NULL AND payment->'refund' IS NULL)::int AS earned,
                  coalesce(sum((referral->>'commissionCents')::int) FILTER (WHERE referral->>'earnedAt' IS NOT NULL AND payment->'refund' IS NULL), 0)::int AS commission_cents
           FROM sessions WHERE referral IS NOT NULL GROUP BY 1`),
    query(`SELECT ref_code AS code, count(DISTINCT visitor)::int AS visitors FROM page_views WHERE ref_code IS NOT NULL GROUP BY 1`),
    query(`SELECT code, coalesce(sum(amount_cents), 0)::int AS paid_cents FROM referral_payouts GROUP BY 1`),
  ]);
  const out = {};
  const get = (c) => (out[c] ||= { applied: 0, paid: 0, earned: 0, commissionCents: 0, visitors: 0, paidOutCents: 0 });
  for (const r of usage.rows) Object.assign(get(r.code), { applied: r.applied, paid: r.paid, earned: r.earned, commissionCents: r.commission_cents });
  for (const r of visits.rows) get(r.code).visitors = r.visitors;
  for (const r of payouts.rows) get(r.code).paidOutCents = r.paid_cents;
  return out;
}

async function pingDb() {
  const t = Date.now();
  await query('SELECT 1');
  return Date.now() - t;
}

module.exports = {
  migrate,
  // estadísticas
  recordPageView,
  getSiteStats,
  getReferralStats,
  pingDb,
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
  // referidos
  getReferralCode,
  listReferralCodes,
  createReferralCode,
  updateReferralCode,
  emailAlreadyUsedReferral,
  getEarnedReferralSessions,
  getReferralPayouts,
  markReferralPayoutPaid,
};
