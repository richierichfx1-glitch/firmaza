// Firmaza — lógica del flujo del firmante (sin frameworks, JS nativo)
const API = '';
let session = null;
let step = 0;
let uploadedFile = null;

const $ = (sel) => document.querySelector(sel);
const panels = document.querySelectorAll('.step-panel');
const segs = document.querySelectorAll('.progress .seg');

// session.signerName y session.document.originalName son texto que el
// propio firmante (o quien haya escrito el formulario) controla — al
// interpolarlos sin escapar en innerHTML, un nombre o nombre de archivo con
// HTML/JS se ejecutaría en la propia página del firmante (self-XSS, pero
// self-XSS sigue siendo XSS real si, por ejemplo, alguien comparte una
// sesión con datos ya manipulados).
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function showStep(n) {
  step = n;
  panels.forEach((p) => (p.style.display = Number(p.dataset.step) === n ? '' : 'none'));
  segs.forEach((s) => s.classList.toggle('done', Number(s.dataset.step) <= n));
}

async function api(pathSuffix, method = 'GET', body) {
  const res = await fetch(`/api/sessions/${session.id}${pathSuffix}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Error de red');
  return res.json();
}

async function ensureSession() {
  const resumeId = getResumeSessionIdFromHash();
  if (resumeId && (await tryResumeSession(resumeId))) return;

  const res = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  if (!res.ok) {
    // Antes, si esta petición fallaba (servidor caído, 500, etc.), el
    // código seguía como si `data.session` existiera: session quedaba
    // `undefined` y cualquier acceso posterior a session.id tronaba con un
    // TypeError sin manejar — la página se quedaba en el spinner de carga
    // para siempre, sin ningún mensaje. Mejor avisar y dejar reintentar.
    const pill = $('#sessionPill');
    if (pill) { pill.textContent = 'No se pudo conectar. Recarga la página.'; pill.classList.remove('live'); }
    throw new Error('No se pudo crear la sesión');
  }
  const data = await res.json();
  session = data.session;
  markSessionPillLive();
  // Si el cliente tiene sesión iniciada (cuenta con núcleo guardado), el
  // servidor ya prellenó signerName/email al crear la sesión — reflejarlo
  // también en el formulario para que no tenga que volver a escribirlos.
  if (session.signerName) $('#signerName').value = session.signerName;
  if (session.email) $('#signerEmail').value = session.email;
}

// Square regresa al firmante a /app#/pagar-exito/<id> después de un pago
// real (ver `redirectUrl` en server.js). Sin esto, ensureSession() de
// arriba siempre creaba una sesión nueva y el firmante perdía su documento
// y sus datos ya capturados — quedaba "atorado" justo después de pagar.
function getResumeSessionIdFromHash() {
  const m = location.hash.match(/^#\/pagar-exito\/([^/?]+)/);
  return m ? m[1] : null;
}

// Antes mostrábamos aquí el ID interno de la sesión (ej. "Sesión a4f24c") —
// no le sirve de nada al firmante y en una prueba real se veía como un
// error o texto de depuración. En su lugar mostramos un estado simple que
// confirma que la sesión quedó activa y protegida.
function markSessionPillLive() {
  const pill = $('#sessionPill');
  pill.textContent = 'Sesión segura';
  pill.classList.add('live');
}

async function tryResumeSession(id) {
  try {
    const res = await fetch(`/api/sessions/${id}`);
    if (!res.ok) return false;
    const data = await res.json();
    session = data.session;
    markSessionPillLive();
    // Limpiamos el hash para que un refresh no vuelva a disparar todo esto.
    history.replaceState(null, '', location.pathname + location.search);
    await resumeAfterPayment();
    return true;
  } catch {
    return false;
  }
}

// Confirma el pago (si hacía falta) y continúa el flujo exactamente donde
// se quedó la sesión, sin repetir pasos ya hechos ni volver a llamar
// /notarize si ya se había enviado a Proof.com (eso crearía una
// transacción duplicada si el firmante recarga la página de éxito).
async function resumeAfterPayment() {
  if (session.status !== 'pagado_demo' && session.payment?.mode !== 'demo') {
    // El servidor verifica el pago contra la propia API de Square antes de
    // marcarlo como pagado (ver /confirm-payment en server.js), así que
    // justo después del redirect puede tardar un instante en reflejarse.
    // Reintentamos unas cuantas veces con una pausa corta antes de avisarle
    // al firmante que algo salió mal.
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { session: updated } = await api('/confirm-payment', 'POST');
        session = updated;
        break;
      } catch (e) {
        if (attempt === maxAttempts) {
          $('#paymentNote').textContent =
            'Todavía no confirmamos tu pago con Square. Si ya pagaste, espera un momento y recarga esta página; si el problema sigue, contáctanos.';
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  $('#paymentNote').textContent = 'Pago procesado de forma segura con Square.';
  routeToCurrentStatus();
}

function routeToCurrentStatus() {
  switch (session.status) {
    case 'notarizacion_completada':
      renderProofSummary();
      showStep(5);
      maybeShowAccountCta();
      return;
    case 'firmado':
      renderSummary();
      showStep(5);
      maybeShowAccountCta();
      return;
    case 'enviado_a_notario_proof':
      showStep(3);
      showProofHandoff();
      return;
    case 'notarizacion_rechazada':
      showStep(3);
      $('#callStatus').textContent = 'La notarización no se pudo completar. Contáctanos para más información.';
      return;
    case 'en_sesion_con_notario':
      showStep(3);
      startCall();
      return;
    default:
      // pagado_demo / pagado_square / cualquier estado antes de iniciar la
      // notarización: seguimos el flujo normal desde el paso de pago.
      startNotarization();
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// --- Paso 0: subir documento, o pedirle a Firmaza que lo prepare -------------
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
dropzone.addEventListener('click', () => fileInput.click());
['dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

function handleFile(file) {
  uploadedFile = file;
  $('#dropzoneText').textContent = `✅ ${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
}

// --- Selector de modo: subir / que Firmaza lo prepare / referido -------------
let docMode = 'upload';
let prepareMode = 'template';
let templates = [];
let selectedTemplateId = null;

function setDocMode(mode) {
  docMode = mode;
  clearErrors();
  document.querySelectorAll('.mode-tabs')[0].querySelectorAll('.mode-tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#modeUpload').style.display = mode === 'upload' ? '' : 'none';
  $('#modePrepare').style.display = mode === 'prepare' ? '' : 'none';
  $('#modeReferral').style.display = mode === 'referral' ? '' : 'none';
  $('#toStep1').style.display = mode === 'referral' ? 'none' : '';
}

document.querySelectorAll('.mode-tab[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => setDocMode(btn.dataset.mode));
});

$('#referralGotIt').addEventListener('click', () => setDocMode('upload'));

function setPrepareMode(mode) {
  prepareMode = mode;
  clearErrors();
  $('#modePrepare').querySelectorAll('.mode-tab[data-prepare-mode]').forEach((b) => b.classList.toggle('active', b.dataset.prepareMode === mode));
  $('#prepareTemplate').style.display = mode === 'template' ? '' : 'none';
  $('#prepareCustom').style.display = mode === 'custom' ? '' : 'none';
}
document.querySelectorAll('.mode-tab[data-prepare-mode]').forEach((btn) => {
  btn.addEventListener('click', () => setPrepareMode(btn.dataset.prepareMode));
});

async function loadTemplates() {
  try {
    const res = await fetch('/api/document-templates');
    const data = await res.json();
    templates = data.templates || [];
    renderTemplateList();
  } catch {
    $('#templateList').innerHTML = '<p class="help">No se pudieron cargar las plantillas. Intenta de nuevo más tarde.</p>';
  }
}

function renderTemplateList() {
  $('#templateList').innerHTML = templates.map((t) => `
    <div class="template-card${t.id === selectedTemplateId ? ' active' : ''}" data-tid="${t.id}">
      <div class="t-name">${t.name}</div>
      <div class="t-desc">${t.description}</div>
    </div>
  `).join('');
  $('#templateList').querySelectorAll('.template-card').forEach((card) => {
    card.addEventListener('click', () => {
      selectedTemplateId = card.dataset.tid;
      clearErrors();
      renderTemplateList();
      renderTemplateFields();
    });
  });
}

function renderTemplateFields() {
  const t = templates.find((x) => x.id === selectedTemplateId);
  const container = $('#templateFields');
  if (!t) { container.innerHTML = ''; return; }
  // Aviso informativo de la plantilla (p. ej. apostilla en el permiso de viaje).
  const notice = t.notice ? `<div class="template-notice">ℹ️ ${escapeHtml(t.notice)}</div>` : '';
  container.innerHTML = notice + t.fields.map((f) => {
    const req = f.required ? '' : ' <span class="hint" style="display:inline">(opcional)</span>';
    const ph = f.placeholder ? ` placeholder="${f.placeholder.replace(/"/g, '&quot;')}"` : '';
    let inner;
    if (f.type === 'textarea') {
      inner = `<textarea rows="4" data-fkey="${f.key}"${ph}></textarea>`;
    } else if (f.type === 'select') {
      inner = `<select data-fkey="${f.key}"><option value="">Elige una opción</option>${
        (f.options || []).map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('')}</select>`;
    } else {
      inner = `<input type="${f.type === 'date' ? 'date' : 'text'}" data-fkey="${f.key}"${ph}>`;
    }
    const reqLabel = f.requiredIf ? '' : req; // condicionales: obligatorios cuando se muestran
    return `<div class="field" data-field-wrap="${f.key}"><label>${f.label}${reqLabel}</label>${inner}<span class="field-error" data-err-for="${f.key}"></span></div>`;
  }).join('');
  container.querySelectorAll('select[data-fkey]').forEach((el) => el.addEventListener('change', applyConditionalFields));
  applyConditionalFields();
}

// Campos que solo aplican según otra respuesta (`showIf` en la plantilla),
// p. ej. los datos del segundo firmante del permiso de viaje.
function fieldApplies(f, values) {
  return !f.showIf || Object.entries(f.showIf).every(([k, want]) => (values[k] || '') === want);
}
function currentTemplateValues() {
  const values = {};
  $('#templateFields').querySelectorAll('[data-fkey]').forEach((el) => { values[el.dataset.fkey] = el.value.trim(); });
  return values;
}
function applyConditionalFields() {
  const t = templates.find((x) => x.id === selectedTemplateId);
  if (!t) return;
  const values = currentTemplateValues();
  for (const f of t.fields) {
    const wrap = document.querySelector(`[data-field-wrap="${f.key}"]`);
    if (wrap) wrap.style.display = fieldApplies(f, values) ? '' : 'none';
  }
}

// --- Validación inline: nada de alert(), resalta el campo exacto y explica
// qué falta justo debajo de él (o en un banner cuando no hay un campo único
// al cual apuntar, como "elige una plantilla"). --------------------------------
function clearErrors() {
  $('#formError').style.display = 'none';
  $('#formError').textContent = '';
  document.querySelectorAll('.field.has-error').forEach((el) => el.classList.remove('has-error'));
  document.querySelectorAll('.field-error').forEach((el) => { el.style.display = 'none'; el.textContent = ''; });
  $('#dropzone').classList.remove('has-error');
  $('#templateList').classList.remove('has-error');
  $('#errTemplate').classList.remove('show');
}

function markFieldError(wrapSelector, errSelector, msg) {
  const wrap = wrapSelector ? $(wrapSelector) : null;
  const err = errSelector ? $(errSelector) : null;
  if (wrap) wrap.classList.add('has-error');
  if (err) { err.textContent = msg; err.style.display = 'block'; }
  return wrap || err;
}

function showFormError(msg) {
  $('#formError').textContent = msg;
  $('#formError').style.display = 'block';
}

function scrollToFirstError() {
  const el = document.querySelector('.field.has-error, .dropzone.has-error, .template-list.has-error');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Generar + traducir el documento puede tardar unos segundos: evitar doble
// clic y avisar qué está pasando.
function setPreparingState() {
  const btn = $('#toStep1');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparando y traduciendo tu documento…';
  return () => { btn.disabled = false; btn.textContent = original; };
}

$('#toStep1').addEventListener('click', async () => {
  clearErrors();
  const name = $('#signerName').value.trim();
  const email = $('#signerEmail').value.trim();
  let hasError = false;
  if (!name) { markFieldError('#fieldSignerName', '#errSignerName', 'Escribe tu nombre completo.'); hasError = true; }
  if (!email) { markFieldError('#fieldSignerEmail', '#errSignerEmail', 'Escribe tu correo electrónico.'); hasError = true; }
  if (hasError) { scrollToFirstError(); return; }
  session.signerName = name;
  session.email = email;

  if (docMode === 'upload') {
    if (!uploadedFile) {
      $('#dropzone').classList.add('has-error');
      markFieldError(null, '#errDropzone', 'Sube tu documento para continuar.');
      scrollToFirstError();
      return;
    }
    const base64 = await fileToBase64(uploadedFile);
    try {
      await api('/upload', 'POST', { filename: uploadedFile.name, base64, signerName: name, email });
    } catch (e) { showFormError('No se pudo subir tu documento: ' + e.message); return; }
    showStep(1);
    loadIdvMode();
  } else if (docMode === 'prepare' && prepareMode === 'template') {
    if (!selectedTemplateId) {
      $('#templateList').classList.add('has-error');
      markFieldError(null, '#errTemplate', 'Elige una plantilla para continuar.');
      scrollToFirstError();
      return;
    }
    const t = templates.find((x) => x.id === selectedTemplateId);
    const values = currentTemplateValues();
    // Los campos que no aplican (ocultos) no se mandan.
    for (const f of t.fields) if (!fieldApplies(f, values)) values[f.key] = '';
    let missingCount = 0;
    for (const f of t.fields) {
      const condRequired = f.requiredIf && Object.entries(f.requiredIf).every(([k, want]) => values[k] === want);
      if ((f.required || condRequired) && !values[f.key]) {
        markFieldError(`[data-field-wrap="${f.key}"]`, `[data-err-for="${f.key}"]`, 'Este campo es obligatorio.');
        missingCount++;
      }
    }
    if (missingCount) {
      showFormError(missingCount === 1 ? 'Falta completar un campo.' : `Faltan ${missingCount} campos por completar.`);
      scrollToFirstError();
      return;
    }
    const releaseBtn = setPreparingState();
    try {
      const { session: updated } = await api('/prepare-document', 'POST', { mode: 'template', templateId: selectedTemplateId, values, signerName: name, email });
      session = updated;
    } catch (e) { showFormError('No se pudo generar el documento: ' + e.message); return; }
    finally { releaseBtn(); }
    showDocPreview();
  } else if (docMode === 'prepare' && prepareMode === 'custom') {
    const titulo = $('#customTitulo').value.trim();
    const cuerpo = $('#customCuerpo').value.trim();
    const lugar = $('#customLugar').value.trim();
    if (!cuerpo) {
      markFieldError('#fieldCustomCuerpo', '#errCustomCuerpo', 'Escribe el texto de tu carta.');
      scrollToFirstError();
      return;
    }
    const releaseBtn = setPreparingState();
    try {
      const { session: updated } = await api('/prepare-document', 'POST', { mode: 'custom', titulo, cuerpo, lugar, signerName: name, email });
      session = updated;
    } catch (e) { showFormError('No se pudo generar el documento: ' + e.message); return; }
    finally { releaseBtn(); }
    showDocPreview();
  } else {
    return; // modo referido: no hay nada que subir todavía
  }
});

// --- Vista previa del documento que Firmaza generó (plantilla o carta) -------
// El cliente ve exactamente el PDF que se va a usar para la notarización
// antes de seguir — puede editarlo si algo quedó mal, en vez de descubrirlo
// hasta la videollamada con el notario.
function showDocPreview() {
  $('#docChooser').style.display = 'none';
  $('#docPreview').style.display = '';
  const d = session.document;
  // Inglés por defecto (o bilingüe para el permiso de viaje) — ver
  // "IDIOMAS" en lib/documentTemplates.js.
  langKeep = d.language || (d.versions && d.versions.bi ? 'bi' : 'en');
  showLangVersion(langKeep);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Idioma del documento ---------------------------------------------------
// El cliente llena todo en español. El documento sale en inglés por defecto;
// en la vista previa puede verlo en español y elegir con cuál versión se
// queda. Si se queda con la de inglés, revisa la traducción (lo que escribió
// / cómo quedó en inglés / traducción de regreso al español) y la aprueba.
// El permiso de viaje para menores sale siempre bilingüe, sin selector.
let langViewing = null; // versión que se está viendo
let langKeep = null;    // versión con la que se queda

function showLangVersion(lang) {
  const d = session.document;
  langViewing = lang;
  $('#docPreviewFrame').src = `/uploads/${d.versions ? d.versions[lang] : d.storedAs}`;
  renderLangBar();
}

function renderLangBar() {
  const d = session.document;
  const bar = $('#langBar');
  $('#langBarError').style.display = 'none';
  if (!d.versions) { bar.innerHTML = ''; return; }
  if (d.versions.bi) {
    bar.innerHTML = '<div class="lb-info">🌎 Este permiso de viaje sale <b>en inglés y español al mismo tiempo</b>, para que lo entiendan las autoridades de los dos países.</div>';
    return;
  }
  const demo = d.translationMode === 'demo'
    ? '<div class="lb-warn">⚠️ Modo de prueba: la traducción automática no está activa (falta ANTHROPIC_API_KEY en el servidor), así que tu texto aparece en español dentro de la versión en inglés.</div>'
    : '';
  const review = (d.review || []).length && langKeep === 'en' ? `
    <div class="lb-review">
      <b>Revisa la traducción</b><br>
      <span class="help" style="margin:0">Lee la "traducción de regreso": si dice lo mismo que tú escribiste, la versión en inglés es correcta.</span>
      ${d.review.map((r) => `
        <div style="margin-top:10px;font-weight:600">${escapeHtml(r.label)}</div>
        <div class="lb-grid">
          <div><b>Lo que escribiste</b>${escapeHtml(r.original)}</div>
          <div><b>Así quedó en inglés</b>${escapeHtml(r.en)}</div>
          <div><b>Traducción de regreso</b>${escapeHtml(r.back)}</div>
        </div>`).join('')}
      <label class="lb-ok"><input type="checkbox" id="langApprove"${d.translationApproved ? ' checked' : ''}>
        <span>Leí la traducción de regreso y dice lo que yo quiero decir. Si tengo dudas, puedo pedirle al notario que me la explique antes de firmar.</span></label>
    </div>` : '';
  bar.innerHTML = `
    <div class="lb-row">
      <span>Ver documento en:</span>
      <span class="lb-seg">
        <button type="button" data-lang-view="en" class="${langViewing === 'en' ? 'on' : ''}">English</button>
        <button type="button" data-lang-view="es" class="${langViewing === 'es' ? 'on' : ''}">Español</button>
      </span>
    </div>
    <div class="lb-info">Tu documento está <b>en inglés</b>, que es lo que normalmente piden en EE.UU. Puedes verlo en español para entender qué dice, y elegir con cuál versión te quedas.</div>
    ${demo}
    <div><b>¿Qué versión quieres notarizar?</b></div>
    <div class="lb-keep">
      <label class="${langKeep === 'en' ? 'on' : ''}"><input type="radio" name="langKeep" value="en" ${langKeep === 'en' ? 'checked' : ''}> Inglés (recomendado)</label>
      <label class="${langKeep === 'es' ? 'on' : ''}"><input type="radio" name="langKeep" value="es" ${langKeep === 'es' ? 'checked' : ''}> Español</label>
    </div>
    ${review}`;
  bar.querySelectorAll('[data-lang-view]').forEach((b) => b.addEventListener('click', () => showLangVersion(b.dataset.langView)));
  bar.querySelectorAll('input[name=langKeep]').forEach((r) => r.addEventListener('change', () => {
    langKeep = r.value;
    showLangVersion(langKeep);
  }));
}

// Guarda en el servidor la versión elegida. Devuelve false si falta algo.
async function saveDocumentLanguage() {
  const d = session.document;
  if (!d || !d.versions) return true;
  const approveEl = $('#langApprove');
  const approved = !!(approveEl && approveEl.checked);
  const showErr = (msg) => { $('#langBarError').textContent = msg; $('#langBarError').style.display = 'block'; };
  if (langKeep === 'en' && (d.review || []).length && !approved) {
    showErr('Marca la casilla para confirmar que revisaste la traducción.');
    if (approveEl) approveEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }
  try {
    const { session: updated } = await api('/document-language', 'POST', { lang: langKeep, approved });
    session = updated;
    return true;
  } catch (e) {
    showErr('No se pudo guardar el idioma del documento: ' + e.message);
    return false;
  }
}

$('#docPreviewEdit').addEventListener('click', () => {
  $('#docPreview').style.display = 'none';
  $('#docChooser').style.display = '';
});

$('#docPreviewConfirm').addEventListener('click', async () => {
  if (!(await saveDocumentLanguage())) return;
  showStep(1);
  loadIdvMode();
});

const templatesReady = loadTemplates();

// --- Reutilizar un documento anterior como base de uno nuevo (Fase 2 de
// cuentas de cliente) -----------------------------------------------------
// Desde /cuenta, "Usar como base" manda aquí con ?reusar=<idSesionAnterior>.
// Solo aplica a documentos que Firmaza preparó (plantilla o carta dictada),
// que son los que tienen datos estructurados guardados para prellenar — ver
// GET /api/cuenta/documentos/:id/reusar en server.js.
async function applyReuseIfRequested() {
  const reuseId = new URLSearchParams(location.search).get('reusar');
  if (!reuseId) return;
  try {
    const res = await fetch(`/api/cuenta/documentos/${reuseId}/reusar`);
    if (!res.ok) return; // no es tuyo, no existe, o no es reutilizable — empieza en blanco sin avisar error
    const data = await res.json();
    const inputs = data.inputs || {};

    setDocMode('prepare');
    if (data.mode === 'template' && data.templateId) {
      await templatesReady;
      selectedTemplateId = data.templateId;
      setPrepareMode('template');
      clearErrors();
      renderTemplateList();
      renderTemplateFields();
      $('#templateFields').querySelectorAll('[data-fkey]').forEach((el) => {
        if (inputs[el.dataset.fkey] != null) el.value = inputs[el.dataset.fkey];
        applyConditionalFields();
      });
    } else if (data.mode === 'custom') {
      setPrepareMode('custom');
      $('#customTitulo').value = inputs.titulo || '';
      $('#customCuerpo').value = inputs.cuerpo || '';
      $('#customLugar').value = inputs.lugar || '';
    } else {
      return;
    }
    $('#reuseNotice').style.display = '';
  } catch { /* si falla, simplemente se empieza el documento en blanco */ }
}

// --- Paso 1: identidad --------------------------------------------------------
// Este paso recoge tus datos básicos de identificación para preparar la
// sesión (y para que el servidor guarde los últimos 4 dígitos de tu
// identificación, no el número completo — ver /api/sessions/:id/verify en
// server.js). NO es la verificación formal: esa ocurre en vivo, por video,
// cuando te conectas con el notario, quien compara tu identificación con tu
// rostro y puede hacer preguntas de verificación. Antes este texto decía que
// la sesión quedaba en "modo de prueba" y no debía usarse para
// notarizaciones reales — eso confundía a firmantes reales pagando de
// verdad, porque esa frase se refería solo a este paso interno, no a la
// notarización completa (que si usa Proof.com de verdad cuando está
// configurado).
async function loadIdvMode() {
  $('#idvNote').textContent =
    'La verificación formal de tu identidad ocurre en video, en vivo, con el notario que te atienda: comparará tu identificación con tu rostro y puede hacerte preguntas de verificación. Este paso solo prepara esa sesión.';
}

// Informa si el pago va a ser un cargo real con Square o una simulación —
// independiente del modo de verificación de identidad (son dos cosas
// distintas; antes este mensaje se decidía mirando el modo de identidad por
// error, así que un firmante pagando de verdad con Square podía ver "no se
// realizará ningún cargo real" justo antes de que sí se le cobrara).
let paymentMode = null;
async function loadPaymentMode() {
  try {
    const res = await fetch('/api/payment-mode');
    paymentMode = await res.json();
  } catch {
    // Si no pudimos confirmar el modo, no arriesgamos decir "no hay cargo
    // real" por error — asumimos que sí podría haberlo.
    paymentMode = { demo: false };
  }
}
const paymentModeReady = loadPaymentMode();

$('#toStep2').addEventListener('click', async () => {
  const fullName = session.signerName;
  const idType = $('#idType').value;
  const idNumber = $('#idNumber').value.trim();
  const dob = $('#dob').value;
  if (!idNumber || !dob) return alert('Completa tus datos de identificación.');
  const { session: updated } = await api('/verify', 'POST', { fullName, idType, idNumber, dob });
  session = updated;
  await paymentModeReady;
  $('#paymentNote').textContent = paymentMode?.demo
    ? 'Pago en modo de prueba (no se realizará ningún cargo real).'
    : 'Pago procesado de forma segura con Square.';
  showStep(2);
});

// --- Paso 2: pago --------------------------------------------------------------
// El servidor decide el monto y la descripción del cargo (ver PRICE_CATALOG
// en server.js) — ya no se mandan desde aquí, un cliente no debe poder
// decidir cuánto paga.
$('#toStep3').addEventListener('click', async () => {
  const btn = $('#toStep3');
  // Sin esto, un doble clic (o un clic mientras la petición anterior seguía
  // en vuelo) podía disparar dos llamadas a /checkout casi simultáneas y
  // crear dos órdenes de pago distintas en Square para la misma sesión —
  // justo el escenario que /confirm-payment ahora tiene que tolerar, pero
  // es mejor no provocarlo desde aquí.
  if (btn.disabled) return;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Procesando…';
  try {
    const data = await api('/checkout', 'POST', {});
    if (data.demo) {
      session = data.session;
      startNotarization();
    } else if (data.url) {
      window.location.href = data.url; // Square Checkout real
      return; // dejamos el botón deshabilitado — estamos navegando fuera de la página
    }
  } catch (e) {
    alert('No se pudo iniciar el pago: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// --- Paso 3: arranca la notarización — Proof.com si está configurado, si no,
// el video WebRTC propio como demo -------------------------------------------
async function startNotarization() {
  showStep(3);
  let result;
  try {
    result = await api('/notarize', 'POST');
  } catch (e) {
    $('#callStatus').textContent = 'No se pudo iniciar la notarización: ' + e.message;
    return;
  }
  session = result.session;
  if (result.demo) {
    startCall();
  } else {
    showProofHandoff();
  }
}

function showProofHandoff() {
  document.querySelector('.video-wrap').style.display = 'none';
  $('#toStep4').style.display = 'none';
  $('#callStatus').classList.remove('live');
  $('#callStatus').textContent =
    `Te enviamos un correo a ${session.email} (y SMS si dejaste teléfono) para conectarte por video con un notario y completar tu notarización. Puedes dejar esta pestaña abierta — se actualizará sola.`;
  pollProofStatus();
}

async function pollProofStatus() {
  try {
    const { session: updated } = await api('/proof-status', 'GET');
    session = updated;
    if (session.status === 'notarizacion_completada') {
      renderProofSummary();
      showStep(5);
      maybeShowAccountCta();
      return;
    }
    if (session.status === 'notarizacion_rechazada') {
      $('#callStatus').textContent = 'La notarización no se pudo completar. Contáctanos para más información.';
      return;
    }
  } catch (e) { /* seguimos intentando en el siguiente ciclo */ }
  setTimeout(pollProofStatus, 5000);
}

function documentLabel() {
  const d = session.document;
  if (!d) return '—';
  const name = escapeHtml(d.originalName);
  return d.preparedByFirmaza ? `${name} (preparado con Firmaza)` : name;
}

function renderProofSummary() {
  $('#summaryBox').innerHTML = `
    <div class="summary-row"><span>Firmante</span><strong>${escapeHtml(session.signerName)}</strong></div>
    <div class="summary-row"><span>Documento</span><strong>${documentLabel()}</strong></div>
    <div class="summary-row"><span>Notarización</span><strong>Completada con Proof.com</strong></div>
  `;
}

// --- Paso 3: video WebRTC real (con señalización propia por polling) ---------
let pc, localStream, roomId, pollTimer, myId;

async function startCall() {
  myId = 'firmante-' + Math.random().toString(36).slice(2, 8);
  roomId = session.id;
  $('#callStatus').textContent = 'Solicitando cámara y micrófono…';
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    $('#localVideo').srcObject = localStream;
  } catch (e) {
    $('#callStatus').textContent = 'No se pudo acceder a la cámara/micrófono.';
    return;
  }

  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.ontrack = (e) => { $('#remoteVideo').srcObject = e.streams[0]; $('#callStatus').textContent = 'Notario conectado'; $('#callStatus').classList.add('live'); };
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ type: 'ice', payload: e.candidate }); };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal({ type: 'offer', payload: offer });
  $('#callStatus').textContent = 'Esperando a que un notario tome la sesión…';
  pollSignals();
}

async function sendSignal(msg) {
  await fetch(`/api/rtc/${roomId}/signal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: myId, ...msg }),
  });
}

let lastSince = 0;
async function pollSignals() {
  clearTimeout(pollTimer);
  try {
    const res = await fetch(`/api/rtc/${roomId}/signal?since=${lastSince}&from=${myId}`);
    const data = await res.json();
    lastSince = data.now;
    for (const m of data.messages) {
      if (m.type === 'answer' && pc.signalingState !== 'stable') {
        await pc.setRemoteDescription(new RTCSessionDescription(m.payload));
      } else if (m.type === 'ice') {
        try { await pc.addIceCandidate(m.payload); } catch {}
      }
    }
  } catch {}
  pollTimer = setTimeout(pollSignals, 1500);
}

$('#toStep4').addEventListener('click', () => {
  clearTimeout(pollTimer);
  showStep(4);
});

// --- Paso 4: firma electrónica (canvas real) ---------------------------------
const canvas = $('#padCanvas');
const ctx = canvas.getContext('2d');
let drawing = false;
ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.strokeStyle = '#0f3d3e';

function pos(e) {
  const r = canvas.getBoundingClientRect();
  const p = e.touches ? e.touches[0] : e;
  return { x: p.clientX - r.left, y: p.clientY - r.top };
}
canvas.addEventListener('pointerdown', (e) => { drawing = true; const { x, y } = pos(e); ctx.beginPath(); ctx.moveTo(x, y); });
canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const { x, y } = pos(e); ctx.lineTo(x, y); ctx.stroke(); });
window.addEventListener('pointerup', () => (drawing = false));
$('#clearPad').addEventListener('click', () => ctx.clearRect(0, 0, canvas.width, canvas.height));

$('#finishBtn').addEventListener('click', async () => {
  const blank = document.createElement('canvas');
  blank.width = canvas.width; blank.height = canvas.height;
  if (canvas.toDataURL() === blank.toDataURL()) return alert('Dibuja tu firma antes de continuar.');
  const png = canvas.toDataURL('image/png');
  const { session: updated } = await api('/sign', 'POST', { signaturePng: png });
  session = updated;
  renderSummary();
  showStep(5);
  maybeShowAccountCta();
});

// --- CTA para crear cuenta justo después de notarizar (Fase 2 de cuentas de
// cliente) — solo aparece si el firmante todavía no tiene una sesión de
// cliente iniciada, para que este documento y los futuros queden guardados
// bajo su correo sin repetir el flujo de captura de datos cada vez. --------
async function maybeShowAccountCta() {
  const cta = $('#accountCta');
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.authenticated) { cta.style.display = 'none'; return; }
  } catch {
    return; // si falla la consulta, no mostramos el CTA en vez de arriesgar un error visible
  }
  $('#accountCtaEmail').textContent = session.email || '';
  $('#accountCtaForm').style.display = '';
  $('#accountCtaSent').style.display = 'none';
  const err = $('#accountCtaError');
  err.style.display = 'none';
  err.textContent = '';
  const btn = $('#accountCtaBtn');
  btn.disabled = false;
  btn.textContent = 'Crear mi cuenta gratis';
  cta.style.display = '';
}

$('#accountCtaBtn').addEventListener('click', async () => {
  const btn = $('#accountCtaBtn');
  const err = $('#accountCtaError');
  err.style.display = 'none';
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const res = await fetch('/api/auth/request-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: session.email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo enviar el enlace');
    $('#accountCtaForm').style.display = 'none';
    $('#accountCtaSent').style.display = '';
    if (data.demo && data.devLink) {
      $('#accountCtaSent').innerHTML =
        '<div class="help" style="font-weight:700;color:var(--ink)">📬 Revisa tu correo para confirmar tu cuenta.</div>' +
        `<div style="margin-top:8px"><a href="${data.devLink}" class="referral-pill" style="display:inline-flex">Entrar ahora →</a></div>`;
    }
  } catch (e) {
    err.textContent = e.message;
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Crear mi cuenta gratis';
  }
});

function renderSummary() {
  $('#summaryBox').innerHTML = `
    <div class="summary-row"><span>Firmante</span><strong>${escapeHtml(session.signerName)}</strong></div>
    <div class="summary-row"><span>Documento</span><strong>${documentLabel()}</strong></div>
    <div class="summary-row"><span>Firmado el</span><strong>${escapeHtml(new Date(session.signature.signedAt).toLocaleString('es-MX'))}</strong></div>
    <div class="summary-row"><span>Folio de auditoría</span><strong style="font-family:monospace">${escapeHtml(session.signature.auditHash.slice(0, 16))}…</strong></div>
  `;
}

// --- Modo inicial vía querystring (ej. ?modo=upload) --------------------------
// Los botones "Notarizar un documento" en /cuenta mandan aquí con
// ?modo=upload|prepare|referral para saltar directo al modo elegido, en vez
// de mostrar siempre "Ya lo tengo listo" (el modo por defecto del HTML).
function applyModeFromQuery() {
  const params = new URLSearchParams(location.search);
  if (params.get('reusar')) return; // applyReuseIfRequested ya deja el modo correcto
  const modo = params.get('modo');
  if (modo === 'upload' || modo === 'prepare' || modo === 'referral') setDocMode(modo);
}
applyModeFromQuery();

// --- init ----------------------------------------------------------------------
ensureSession().then(() => {
  // Si veníamos de #/pagar-exito/... ensureSession ya encaminó la sesión a
  // donde debía (resumeAfterPayment/routeToCurrentStatus) — no hay que
  // aplicar una reutilización encima de eso.
  if (!getResumeSessionIdFromHash()) applyReuseIfRequested();
}).catch((e) => {
  console.error('No se pudo iniciar la sesión:', e.message);
});
showStep(0);
