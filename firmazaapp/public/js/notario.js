// Firmaza — panel del notario: toma sesiones de la cola y responde la videollamada
const $ = (s) => document.querySelector(s);
let notaries = [];
let activeSession = null;
let pc, localStream, roomId, pollTimer, myId, lastSince = 0;
let queuePollTimer = null;

// El nombre del firmante y el nombre del documento vienen de datos que
// cualquier persona puede escribir al crear una sesión (no son texto
// nuestro) — sin escapar, un nombre como `<img src=x onerror=...>` se
// ejecutaría como HTML/JS dentro del panel del notario. Esto es lo mismo
// que un ataque de XSS almacenado contra cualquiera que abra /notario.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function loadNotaries() {
  const res = await fetch('/api/notaries');
  const data = await res.json();
  notaries = data.notaries;
  $('#notarySelect').innerHTML = notaries
    .map((n) => `<option value="${n.id}">${n.name} — ${n.statesCommissioned.join(', ')}</option>`)
    .join('') || '<option>No hay notarios configurados en data/notaries.json</option>';
}

async function loadQueue() {
  const res = await fetch('/api/queue');
  if (res.status === 401) {
    // La sesión de notario expiró o se cerró en otra pestaña — de vuelta al login.
    showLogin();
    return;
  }
  const data = await res.json();
  const body = $('#queueBody');
  if (!data.queue.length) {
    body.innerHTML = '<tr><td colspan="5">No hay firmantes en espera.</td></tr>';
    return;
  }
  body.innerHTML = data.queue.map((s) => `
    <tr>
      <td>${escapeHtml(s.signerName || 'Sin nombre')}</td>
      <td>${escapeHtml(s.document?.originalName || '—')}</td>
      <td>${escapeHtml(s.status)}</td>
      <td>${escapeHtml(new Date(s.createdAt).toLocaleTimeString('es-MX'))}</td>
      <td><button class="btn btn-primary" data-id="${escapeHtml(s.id)}">Tomar sesión</button></td>
    </tr>`).join('');
  body.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => claimSession(btn.dataset.id));
  });
}

async function claimSession(id) {
  const notaryId = $('#notarySelect').value;
  const res = await fetch(`/api/sessions/${id}/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notaryId }),
  });
  if (res.status === 401) { showLogin(); return; }
  const data = await res.json();
  activeSession = data.session;
  $('#callCard').style.display = '';
  await joinCall(activeSession.roomId || activeSession.id);
}

async function joinCall(room) {
  roomId = room;
  myId = 'notario-' + Math.random().toString(36).slice(2, 8);
  // getUserMedia rechaza la promesa si el notario le niega permiso a la
  // cámara/micrófono, o si no hay dispositivo disponible — sin este
  // try/catch eso quedaba como una excepción sin manejar y el panel se
  // quedaba a medias (tarjeta de llamada visible, sin video ni forma clara
  // de saber qué pasó).
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    alert('No se pudo acceder a la cámara/micrófono. Revisa los permisos del navegador e inténtalo de nuevo.');
    endCall();
    return;
  }
  $('#localVideo').srcObject = localStream;

  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.ontrack = (e) => { $('#remoteVideo').srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ type: 'ice', payload: e.candidate }); };

  pollSignals();
}

// Libera la cámara/micrófono y cierra la conexión — antes, cerrar sesión
// (o simplemente terminar la llamada) dejaba el stream de video y el
// RTCPeerConnection abiertos indefinidamente: la luz de la cámara seguía
// encendida y el polling de señalización (pollTimer, cada 1.5s) seguía
// corriendo en segundo plano después de salir del panel de notario.
function endCall() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (pc) {
    pc.close();
    pc = null;
  }
  const localVideo = $('#localVideo');
  const remoteVideo = $('#remoteVideo');
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  const callCard = $('#callCard');
  if (callCard) callCard.style.display = 'none';
  activeSession = null;
  roomId = null;
}

async function sendSignal(msg) {
  await fetch(`/api/rtc/${roomId}/signal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: myId, ...msg }),
  });
}

async function pollSignals() {
  clearTimeout(pollTimer);
  if (!roomId) return; // la llamada ya terminó (endCall) — no seguir sondeando
  try {
    const res = await fetch(`/api/rtc/${roomId}/signal?since=${lastSince}&from=${myId}`);
    const data = await res.json();
    lastSince = data.now;
    for (const m of data.messages) {
      if (m.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(m.payload));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal({ type: 'answer', payload: answer });
      } else if (m.type === 'ice') {
        try { await pc.addIceCandidate(m.payload); } catch {}
      }
    }
  } catch {}
  if (roomId) pollTimer = setTimeout(pollSignals, 1500);
}

function showLogin() {
  clearInterval(queuePollTimer);
  queuePollTimer = null;
  endCall();
  $('#loginCard').style.display = '';
  $('#queueWrap').style.display = 'none';
  $('#notaryCode').value = '';
}

function showQueue() {
  $('#loginCard').style.display = 'none';
  $('#queueWrap').style.display = '';
  loadNotaries();
  loadQueue();
  if (!queuePollTimer) queuePollTimer = setInterval(loadQueue, 4000);
}

async function checkAuth() {
  const res = await fetch('/api/notary/me');
  const data = await res.json();
  if (data.authenticated) showQueue();
  else showLogin();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#notaryCode').value;
  $('#loginError').style.display = 'none';
  const res = await fetch('/api/notary/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (res.ok) showQueue();
  else $('#loginError').style.display = '';
});

$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/notary/logout', { method: 'POST' });
  showLogin();
});

checkAuth();
