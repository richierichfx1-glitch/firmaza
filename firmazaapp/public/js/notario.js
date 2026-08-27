// Firmaza — panel del notario: toma sesiones de la cola y responde la videollamada
const $ = (s) => document.querySelector(s);
let notaries = [];
let activeSession = null;
let pc, localStream, roomId, pollTimer, myId, lastSince = 0;

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
  const data = await res.json();
  const body = $('#queueBody');
  if (!data.queue.length) {
    body.innerHTML = '<tr><td colspan="5">No hay firmantes en espera.</td></tr>';
    return;
  }
  body.innerHTML = data.queue.map((s) => `
    <tr>
      <td>${s.signerName || 'Sin nombre'}</td>
      <td>${s.document?.originalName || '—'}</td>
      <td>${s.status}</td>
      <td>${new Date(s.createdAt).toLocaleTimeString('es-MX')}</td>
      <td><button class="btn btn-primary" data-id="${s.id}">Tomar sesión</button></td>
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
  const data = await res.json();
  activeSession = data.session;
  $('#callCard').style.display = '';
  await joinCall(activeSession.roomId || activeSession.id);
}

async function joinCall(room) {
  roomId = room;
  myId = 'notario-' + Math.random().toString(36).slice(2, 8);
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  $('#localVideo').srcObject = localStream;

  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.ontrack = (e) => { $('#remoteVideo').srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ type: 'ice', payload: e.candidate }); };

  pollSignals();
}

async function sendSignal(msg) {
  await fetch(`/api/rtc/${roomId}/signal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: myId, ...msg }),
  });
}

async function pollSignals() {
  clearTimeout(pollTimer);
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
  pollTimer = setTimeout(pollSignals, 1500);
}

loadNotaries();
loadQueue();
setInterval(loadQueue, 4000);
