// Firmaza — panel de cuenta del cliente (login sin contraseña + núcleo + historial)
const $ = (sel) => document.querySelector(sel);

const STATUS_LABELS = {
  iniciada: 'Iniciada',
  documento_subido: 'Documento listo',
  identidad_verificada: 'Identidad verificada',
  pagado_demo: 'Pagado',
  pagado_square: 'Pagado',
  enviado_a_notario_proof: 'Con el notario',
  en_sesion_con_notario: 'En sesión con notario',
  en_reunion_con_notario: 'En reunión con notario',
  firmado: 'Firmado',
  notarizacion_completada: 'Notarizado ✓',
  notarizacion_rechazada: 'Rechazado',
};

function showFieldError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}
function clearFieldError(el) {
  el.textContent = '';
  el.style.display = 'none';
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* respuesta vacía */ }
  if (!res.ok) throw new Error(data.error || 'Error de red');
  return data;
}

// ---------------------------------------------------------------------------
// Login por enlace mágico
// ---------------------------------------------------------------------------
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#loginError');
  clearFieldError(errEl);
  const email = $('#loginEmail').value.trim();
  const btn = $('#loginSubmit');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const data = await api('/api/auth/request-link', 'POST', { email });
    $('#loginForm').style.display = 'none';
    $('#loginSent').style.display = '';
    $('#loginSentEmail').textContent = `Le mandamos un enlace de acceso a ${email}. Ábrelo desde este mismo dispositivo.`;
    if (data.demo && data.devLink) {
      $('#loginDemo').style.display = '';
      const link = $('#loginDevLink');
      link.href = data.devLink;
      link.textContent = 'Entrar ahora →';
    }
  } catch (err) {
    showFieldError(errEl, err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enviarme el enlace';
  }
});

// ---------------------------------------------------------------------------
// Núcleo (datos base reutilizables)
// ---------------------------------------------------------------------------
let familiares = [];

function renderFamiliares() {
  const wrap = $('#familiaresList');
  wrap.innerHTML = familiares
    .map(
      (f, i) => `
      <div class="familiar-row" data-i="${i}">
        <input type="text" placeholder="Nombre" value="${escapeAttr(f.nombre)}" data-f="nombre">
        <input type="text" placeholder="Parentesco (ej. hijo, cónyuge)" value="${escapeAttr(f.parentesco)}" data-f="parentesco">
        <input type="date" value="${escapeAttr(f.fechaNacimiento)}" data-f="fechaNacimiento">
        <button type="button" class="familiar-remove" data-i="${i}" aria-label="Quitar familiar">✕</button>
      </div>`
    )
    .join('');
}
// Se usa tanto dentro de atributos (value="...") como como contenido de
// texto (doc-title de abajo) — antes solo escapaba comillas dobles, lo
// cual bastaba para el caso de atributos pero no para contenido de texto:
// un título de documento con "<img src=x onerror=...>" se insertaba tal
// cual vía innerHTML y se ejecutaba como HTML/JS. Escapar los cinco
// caracteres especiales es seguro en ambos contextos.
function escapeAttr(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

$('#familiaresList').addEventListener('input', (e) => {
  const row = e.target.closest('.familiar-row');
  if (!row) return;
  const i = Number(row.dataset.i);
  const field = e.target.dataset.f;
  if (field) familiares[i][field] = e.target.value;
});
$('#familiaresList').addEventListener('click', (e) => {
  const btn = e.target.closest('.familiar-remove');
  if (!btn) return;
  familiares.splice(Number(btn.dataset.i), 1);
  renderFamiliares();
});
$('#addFamiliar').addEventListener('click', () => {
  familiares.push({ nombre: '', parentesco: '', fechaNacimiento: '' });
  renderFamiliares();
});

$('#nucleoSave').addEventListener('click', async () => {
  const errEl = $('#nucleoError');
  clearFieldError(errEl);
  const btn = $('#nucleoSave');
  btn.disabled = true;
  try {
    await api('/api/cuenta/nucleo', 'PUT', {
      nombreCompleto: $('#nucleoNombre').value.trim(),
      telefono: $('#nucleoTelefono').value.trim(),
      direccion: $('#nucleoDireccion').value.trim(),
      ciudad: $('#nucleoCiudad').value.trim(),
      estado: $('#nucleoEstado').value.trim(),
      codigoPostal: $('#nucleoCodigoPostal').value.trim(),
      familiares,
      notas: $('#nucleoNotas').value.trim(),
    });
    const saved = $('#nucleoSaved');
    saved.style.display = '';
    setTimeout(() => { saved.style.display = 'none'; }, 2200);
  } catch (err) {
    showFieldError(errEl, err.message);
  } finally {
    btn.disabled = false;
  }
});

function fillNucleo(nucleo) {
  $('#nucleoNombre').value = nucleo.nombreCompleto || '';
  $('#nucleoTelefono').value = nucleo.telefono || '';
  $('#nucleoDireccion').value = nucleo.direccion || '';
  $('#nucleoCiudad').value = nucleo.ciudad || '';
  $('#nucleoEstado').value = nucleo.estado || '';
  $('#nucleoCodigoPostal').value = nucleo.codigoPostal || '';
  $('#nucleoNotas').value = nucleo.notas || '';
  familiares = Array.isArray(nucleo.familiares) ? nucleo.familiares.map((f) => ({ ...f })) : [];
  renderFamiliares();
}

// ---------------------------------------------------------------------------
// Historial de documentos
// ---------------------------------------------------------------------------
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('es-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}

async function loadDocumentos() {
  try {
    const { documentos } = await api('/api/cuenta/documentos');
    const wrap = $('#docsList');
    if (!documentos.length) {
      $('#docsEmpty').style.display = '';
      wrap.innerHTML = '';
      return;
    }
    $('#docsEmpty').style.display = 'none';
    wrap.innerHTML = documentos
      .map((d) => {
        const label = STATUS_LABELS[d.status] || d.status;
        const live = d.status === 'notarizacion_completada';
        const link = d.archivo ? `<a href="/uploads/${d.archivo}" target="_blank" rel="noopener" class="btn btn-outline">Ver documento</a>` : '';
        // Solo los documentos que Firmaza preparó (plantilla o carta dictada)
        // guardan los datos que el cliente escribió, así que solo esos se
        // pueden reutilizar como base de un documento nuevo.
        const reuse = d.preparedByFirmaza
          ? `<a href="/app?reusar=${d.id}" class="btn btn-primary">Usar como base ↻</a>`
          : '';
        return `
        <div class="doc-row">
          <div>
            <div class="doc-title">${escapeAttr(d.titulo)}</div>
            <div class="help" style="margin:2px 0 0">${fmtDate(d.createdAt)}</div>
          </div>
          <div class="doc-row-actions">
            <span class="status-pill${live ? ' live' : ''}">${label}</span>
            ${link}
            ${reuse}
          </div>
        </div>`;
      })
      .join('');
  } catch (err) {
    $('#docsList').innerHTML = `<p class="field-error" style="display:block">${err.message}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Cerrar sesión
// ---------------------------------------------------------------------------
$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', 'POST');
  window.location.reload();
});

// ---------------------------------------------------------------------------
// Arranque: ¿ya hay sesión de cliente?
// ---------------------------------------------------------------------------
(async function init() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('error') === 'enlace_invalido') {
    showFieldError($('#loginError'), 'Ese enlace ya no es válido — pide uno nuevo.');
  }
  try {
    const me = await api('/api/auth/me');
    if (me.authenticated) {
      $('#loginView').style.display = 'none';
      $('#dashView').style.display = '';
      $('#logoutBtn').style.display = '';
      $('#dashEmail').textContent = me.email;
      fillNucleo(me.nucleo || {});
      loadDocumentos();
    }
  } catch {
    // si /api/auth/me falla, dejamos ver el formulario de login normalmente
  }
})();
