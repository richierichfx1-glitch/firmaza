// Firmaza — lógica del flujo del firmante (sin frameworks, JS nativo)
const API = '';
let session = null;
let step = 0;
let uploadedFile = null;

const $ = (sel) => document.querySelector(sel);
const panels = document.querySelectorAll('.step-panel');
const segs = document.querySelectorAll('.progress .seg');

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
  const res = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const data = await res.json();
  session = data.session;
  $('#sessionPill').textContent = `Sesión ${session.id.slice(0, 6)}`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// --- Paso 0: subir documento -------------------------------------------------
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

$('#toStep1').addEventListener('click', async () => {
  const name = $('#signerName').value.trim();
  const email = $('#signerEmail').value.trim();
  if (!name || !email) return alert('Completa tu nombre y correo.');
  if (!uploadedFile) return alert('Sube tu documento para continuar.');
  session.signerName = name;
  session.email = email;
  const base64 = await fileToBase64(uploadedFile);
  await api('/upload', 'POST', { filename: uploadedFile.name, base64 });
  showStep(1);
  loadIdvMode();
});

// --- Paso 1: identidad --------------------------------------------------------
async function loadIdvMode() {
  // Solo informativo: el backend decide si hay proveedor real configurado.
  $('#idvNote').textContent =
    'Modo de verificación: se determinará al enviar tus datos. Sin un proveedor de verificación (Persona, Stripe Identity, etc.) configurado, la sesión queda marcada como "modo de prueba" y no debe usarse para notarizaciones reales.';
}

$('#toStep2').addEventListener('click', async () => {
  const fullName = session.signerName;
  const idType = $('#idType').value;
  const idNumber = $('#idNumber').value.trim();
  const dob = $('#dob').value;
  if (!idNumber || !dob) return alert('Completa tus datos de identificación.');
  const { session: updated } = await api('/verify', 'POST', { fullName, idType, idNumber, dob });
  session = updated;
  $('#paymentNote').textContent = session.identity.result.mode === 'demo'
    ? 'Pago en modo de prueba (no se realizará ningún cargo real).'
    : 'Pago procesado de forma segura con Square.';
  showStep(2);
});

// --- Paso 2: pago --------------------------------------------------------------
$('#toStep3').addEventListener('click', async () => {
  const data = await api('/checkout', 'POST', { amount: 25, description: 'Primer sello notarial — Firmaza' });
  if (data.demo) {
    session = data.session;
    showStep(3);
    startCall();
  } else if (data.url) {
    window.location.href = data.url; // Stripe Checkout real
  }
});

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
});

function renderSummary() {
  $('#summaryBox').innerHTML = `
    <div class="summary-row"><span>Firmante</span><strong>${session.signerName}</strong></div>
    <div class="summary-row"><span>Documento</span><strong>${session.document?.originalName || '—'}</strong></div>
    <div class="summary-row"><span>Firmado el</span><strong>${new Date(session.signature.signedAt).toLocaleString('es-MX')}</strong></div>
    <div class="summary-row"><span>Folio de auditoría</span><strong style="font-family:monospace">${session.signature.auditHash.slice(0, 16)}…</strong></div>
  `;
}

// --- init ----------------------------------------------------------------------
ensureSession();
showStep(0);
