import { LANGS, tr, personaTitle, personaNote } from './i18n.js';

const PAN_SECONDS = 6;
const token = new URLSearchParams(location.hash.slice(1)).get('t');

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const st = {
  screen: 'loading', // loading | link | intro | perm | capture | checking | retake | accepted | review | agent | closed
  linkError: null,
  session: null,
  lang: 'en',
  consentChecked: false,
  busy: false,
  toast: null, // { kind: 'ok'|'bad', key }
  hints: [],
  stream: null,
  fix: null,
  gpsError: false,
  watchId: null,
  recording: 0,
  ces: null,
  autoVoice: false,
  lastSpoken: null,
};

// Persistent video element so re-renders don't restart the camera preview.
const video = document.createElement('video');
video.setAttribute('playsinline', '');
video.muted = true;
video.autoplay = true;

/* ---------------- API ---------------- */
async function api(path, { method = 'GET', json, body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (json) headers['content-type'] = 'application/json';
  const res = await fetch(`/api/v${path}`, { method, headers, body: json ? JSON.stringify(json) : body });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      // Retry only network failures / 5xx, never validation errors.
      const retryable = !err.status || err.status >= 500;
      if (!retryable || i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

/* ---------------- Devices ---------------- */
async function startDevices() {
  try {
    st.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch {
    st.screen = 'perm';
    return render();
  }
  video.srcObject = st.stream;
  startGps();
  st.screen = 'capture';
  render();
}

function startGps() {
  if (!('geolocation' in navigator)) { st.gpsError = true; return; }
  if (st.watchId != null) return;
  st.watchId = navigator.geolocation.watchPosition(
    (p) => {
      st.fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
      st.gpsError = false;
      updateGpsTag();
    },
    (err) => {
      st.gpsError = true;
      if (err.code === err.PERMISSION_DENIED && st.screen === 'capture') { stopDevices(); st.screen = 'perm'; render(); }
      else updateGpsTag();
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
  );
}

function stopDevices() {
  st.stream?.getTracks().forEach((t) => t.stop());
  st.stream = null;
  video.srcObject = null;
  if (st.watchId != null) navigator.geolocation.clearWatch(st.watchId);
  st.watchId = null;
}

function gpsTag() {
  if (st.fix) {
    return st.fix.accuracy <= 100
      ? { cls: 'ok', text: tr('gps_ok', st.lang) }
      : { cls: '', text: tr('gps_weak', st.lang) };
  }
  if (st.gpsError) return { cls: 'bad', text: tr('gps_off', st.lang) };
  return { cls: '', text: tr('gps_waiting', st.lang) };
}
function updateGpsTag() {
  const el = $('#gpsTag');
  if (!el) return;
  const g = gpsTag();
  el.className = `cam-tag ${g.cls}`;
  el.textContent = g.text;
}

/* ---------------- Capture ---------------- */
function grabFrame() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return Promise.resolve(null);
  const scale = Math.min(1, 1600 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
}

function uploadCapture(kind, blob, filename) {
  return withRetry(() => {
    const fd = new FormData();
    fd.append('kind', kind);
    if (st.fix) {
      fd.append('lat', st.fix.lat);
      fd.append('lng', st.fix.lng);
      fd.append('accuracy', st.fix.accuracy);
    }
    fd.append('clientTs', new Date().toISOString());
    fd.append('file', blob, filename);
    return api('/captures', { method: 'POST', body: fd });
  });
}

async function capturePhoto() {
  const blob = await grabFrame();
  if (!blob) { st.toast = { kind: 'bad', key: 'error_generic' }; return render(); }
  st.busy = true; st.toast = null; render();
  try {
    const r = await uploadCapture('photo', blob, 'photo.jpg');
    st.session.progress = r.progress;
    st.toast = r.ok ? { kind: 'ok', key: 'shot_ok' } : { kind: 'bad', key: `hint_${r.hint}` };
  } catch {
    st.toast = { kind: 'bad', key: 'upload_failed' };
  } finally {
    st.busy = false;
    render();
    if (st.toast) speak(tr(st.toast.key, st.lang), true);
  }
}

function pickRecorderMime() {
  const options = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  return options.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
}

async function recordPan() {
  if (!('MediaRecorder' in window)) { st.toast = { kind: 'bad', key: 'no_recorder' }; return render(); }
  const mime = pickRecorderMime();
  let rec;
  try {
    rec = new MediaRecorder(st.stream, mime ? { mimeType: mime, videoBitsPerSecond: 1_000_000 } : {});
  } catch {
    st.toast = { kind: 'bad', key: 'no_recorder' };
    return render();
  }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(500);
  st.toast = null;
  st.recording = PAN_SECONDS;
  render();
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      st.recording--;
      render();
      if (st.recording <= 0) { clearInterval(iv); resolve(); }
    }, 1000);
  });
  rec.stop();
  await stopped;

  const type = (rec.mimeType || mime || 'video/webm');
  const blob = new Blob(chunks, { type });
  st.busy = true; render();
  try {
    const r = await uploadCapture('pan', blob, type.includes('mp4') ? 'pan.mp4' : 'pan.webm');
    st.session.progress = r.progress;
    st.toast = { kind: 'ok', key: 'pan_done' };
  } catch {
    st.toast = { kind: 'bad', key: 'upload_failed' };
  } finally {
    st.busy = false;
    render();
  }
}

/* ---------------- Flow actions ---------------- */
async function agreeAndStart() {
  st.busy = true; render();
  try {
    if (st.session.status === 'created') st.session = await api('/consent', { method: 'POST', json: { accepted: true, lang: st.lang } });
    await startDevices();
  } catch {
    st.toast = { kind: 'bad', key: 'error_generic' };
  } finally {
    st.busy = false;
    render();
  }
}

async function submit() {
  st.screen = 'checking'; st.toast = null; render();
  try {
    const r = await withRetry(() => api('/submit', { method: 'POST' }), 2);
    st.session = r.session;
    if (r.decision === 'retake') { st.hints = r.hints; st.screen = 'retake'; }
    else { st.screen = r.decision === 'accepted' ? 'accepted' : 'review'; stopDevices(); }
  } catch {
    st.screen = 'capture';
    st.toast = { kind: 'bad', key: 'error_generic' };
  }
  render();
}

async function requestAgent() {
  if (!window.confirm(tr('confirm_agent', st.lang))) return;
  try {
    st.session = await api('/fallback', { method: 'POST', json: { reason: st.screen } });
    stopDevices();
    st.screen = 'agent';
  } catch {
    st.toast = { kind: 'bad', key: 'error_generic' };
  }
  render();
}

async function sendCes(n) {
  st.ces = n;
  render();
  try { await api('/feedback', { method: 'POST', json: { ces: n } }); } catch { /* non-critical */ }
}

/* ---------------- Voice ---------------- */
function speak(text, force = false) {
  if (!('speechSynthesis' in window) || !text) return;
  if (!force && !st.autoVoice) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const meta = LANGS.find((l) => l.code === st.lang);
  u.lang = meta.voice;
  const voices = speechSynthesis.getVoices();
  const match = voices.find((v) => v.lang === u.lang) || voices.find((v) => v.lang?.startsWith(st.lang));
  if (match) u.voice = match;
  u.rate = 0.95;
  const btn = $('#listenBtn');
  u.onstart = () => btn.classList.add('speaking');
  u.onend = u.onerror = () => btn.classList.remove('speaking');
  speechSynthesis.speak(u);
}

function narration() {
  const l = st.lang, s = st.session;
  switch (st.screen) {
    case 'intro': return `${tr('s1_lede', l)} ${notes(s)}`;
    case 'perm': return tr('perm_denied_body', l);
    case 'capture': return tr('s2_hint_default', l);
    case 'checking': return tr('checking', l);
    case 'retake': return st.hints.map(hintText).join(' ');
    case 'accepted': return tr('s5_sub', l);
    case 'review': return tr('review_sub', l);
    case 'agent': return tr('agent_sub', l);
    default: return '';
  }
}

/* ---------------- Rendering ---------------- */
const STEP = { intro: 1, perm: 1, capture: 2, checking: 2, retake: 2, accepted: 3, review: 3, agent: 3, closed: 3 };
const STEP_TITLE = { 1: 'step_intro', 2: 'step_capture', 3: 'step_done' };

function notes(s) {
  const n = personaNote(s.persona, st.lang);
  return s.assist && s.persona !== 'lowdigital' ? `${n} ${personaNote('lowdigital', st.lang)}` : n;
}

function hintText(code) {
  return tr(code.startsWith('NAME_') ? 'hint_NAME' : `hint_${code}`, st.lang);
}

function screenHtml() {
  const l = st.lang, s = st.session;
  const toast = st.toast ? `<div class="toast ${st.toast.kind}" role="status">${esc(tr(st.toast.key, l))}</div>` : '';
  switch (st.screen) {
    case 'loading':
      return `<div class="spinner"></div><p class="lede center">${tr('loading', l)}</p>`;

    case 'link':
      return `<div class="big-icon bad">!</div><h2 class="result-title center">${tr('link_title', l)}</h2>
        <p class="lede center">${tr(st.linkError === 'LINK_EXPIRED' ? 'link_expired' : 'link_invalid', l)}</p>`;

    case 'intro':
      return `${toast}<div class="badge">${esc(personaTitle(s.persona, l))}</div>
        <p class="greet">${esc(tr('hi_name', l, { name: s.firstName }))}</p>
        <div class="addr"><small>${tr('verifying_addr', l)}</small>${esc(s.address)}</div>
        <p class="lede">${tr('s1_lede', l)}</p>
        <p class="lede">${notes(s)}</p>
        <div class="perm-row"><div class="perm-icon" aria-hidden="true">📷</div><div class="perm-text"><b>${tr('perm_cam', l)}</b><span>${tr('perm_cam_sub', l)}</span></div></div>
        <div class="perm-row"><div class="perm-icon" aria-hidden="true">📍</div><div class="perm-text"><b>${tr('perm_loc', l)}</b><span>${tr('perm_loc_sub', l)}</span></div></div>
        ${s.status === 'created' ? `<label class="consent"><input type="checkbox" id="consentBox" ${st.consentChecked ? 'checked' : ''}>
          <span>${esc(tr('consent_text', l, { days: s.retentionDays }))} <a class="link" href="/privacy" target="_blank" rel="noopener">${tr('privacy_link', l)}</a></span></label>` : ''}
        <button class="link-btn" data-action="agent" type="button">${tr('need_agent', l)}</button>`;

    case 'perm':
      return `<div class="big-icon bad" aria-hidden="true">📷</div><h2 class="result-title center">${tr('perm_denied_title', l)}</h2>
        <p class="lede center">${tr('perm_denied_body', l)}</p>
        <button class="link-btn" data-action="agent" type="button">${tr('need_agent', l)}</button>`;

    case 'capture': {
      const p = s.progress;
      const g = gpsTag();
      const dots = Array.from({ length: s.photosRequired }, (_, i) => `<span class="${i < p.photosOk ? 'done' : ''}"></span>`).join('');
      return `${toast}<div class="cam-box" id="camBox">
          <div class="frame-guide"></div>
          <div class="cam-tag ${g.cls}" id="gpsTag">${esc(g.text)}</div>
          ${st.recording ? `<div class="rec">● ${st.recording}s</div>` : ''}
          <div class="cam-hint">${st.recording ? esc(tr('pan_recording', l, { s: st.recording })) : tr('s2_hint_default', l)}</div>
        </div>
        <div class="dots">${dots}&nbsp;${tr('photos_count', l, { n: Math.min(p.photosOk, s.photosRequired), t: s.photosRequired })}</div>
        <button class="link-btn" data-action="agent" type="button">${tr('need_agent', l)}</button>`;
    }

    case 'checking':
      return `<div class="spinner"></div><p class="lede center">${tr('checking', l)}</p>`;

    case 'retake':
      return `<div class="big-icon wait" aria-hidden="true">↻</div><h2 class="result-title center">${tr('retake_title', l)}</h2>
        <p class="lede center">${tr('retake_sub', l, { n: s.attempt, t: s.maxRetakes + 1 })}</p>
        <ul class="hint-list">${[...new Set(st.hints.map(hintText))].map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`;

    case 'accepted':
    case 'review':
    case 'agent':
    case 'closed': {
      const cfg = {
        accepted: ['ok', '✓', 's5_title', 's5_sub'],
        review: ['ok', '✓', 'review_title', 'review_sub'],
        agent: ['wait', '📅', 'agent_title', 'agent_sub'],
        closed: ['ok', '✓', 'closed_title', 'closed_sub'],
      }[st.screen];
      const ces = st.screen === 'closed' ? '' : `<div class="ces center"><p class="lede">${st.ces ? tr('ces_thanks', l) : tr('ces_q', l)}</p>
        <div class="chips">${[1, 2, 3, 4, 5].map((n) => `<button class="chip ${st.ces === n ? 'active' : ''}" data-action="ces" data-n="${n}" type="button">${n}</button>`).join('')}</div></div>`;
      return `<div class="big-icon ${cfg[0]}" aria-hidden="true">${cfg[1]}</div>
        <h2 class="result-title center">${tr(cfg[2], l)}</h2><p class="lede center">${tr(cfg[3], l)}</p>${ces}
        <p class="center"><a class="link" href="/account/">${tr('my_account', l)}</a></p>`;
    }
    default: return '';
  }
}

function footerHtml() {
  const l = st.lang, s = st.session;
  const dis = st.busy || st.recording ? 'disabled' : '';
  switch (st.screen) {
    case 'intro': {
      const ok = s.status !== 'created' || st.consentChecked;
      return `<button class="btn btn-primary" data-action="start" type="button" ${ok && !st.busy ? '' : 'disabled'}>${tr('agree_start', l)}</button>`;
    }
    case 'perm':
      return `<button class="btn btn-primary" data-action="start" type="button">${tr('try_again', l)}</button>`;
    case 'capture': {
      const p = s.progress;
      const photosDone = p.photosOk >= s.photosRequired;
      const ready = photosDone && (!s.panRequired || p.panDone);
      if (ready) return `<button class="btn btn-primary" data-action="submit" type="button" ${dis}>${tr('submit_btn', l)}</button>`;
      const photoBtn = `<button class="btn ${photosDone ? 'btn-secondary' : 'btn-primary'}" data-action="photo" type="button" ${dis || (photosDone ? 'disabled' : '')}>
          ${st.busy ? tr('uploading', l) : tr('capture_btn', l)}</button>`;
      const panBtn = s.panRequired
        ? `<button class="btn ${photosDone ? 'btn-primary' : 'btn-secondary'}" data-action="pan" type="button" ${dis || (p.panDone ? 'disabled' : '')}>${p.panDone ? '✓ ' : ''}${tr('pan_btn', l)}</button>`
        : '';
      return photoBtn + panBtn;
    }
    case 'retake':
      return `<button class="btn btn-primary" data-action="retake" type="button">${tr('retake_btn', l)}</button>`;
    default:
      return '';
  }
}

function render() {
  const l = st.lang;
  document.documentElement.lang = l;
  const step = STEP[st.screen];
  $('#stepLabel').textContent = step ? tr('step_of', l, { n: step, t: 3 }) : '';
  $('#stepTitle').textContent = step ? tr(STEP_TITLE[step], l) : 'Loans24';
  $('#progressFill').style.width = `${((step || 0) / 3) * 100}%`;
  $('#listenLabel').textContent = tr('listen', l);
  $('#langSelect').value = l;

  $('#screenBody').innerHTML = screenHtml();
  $('#footer').innerHTML = footerHtml();

  const box = $('#camBox');
  if (box && st.stream) {
    box.prepend(video);
    video.play().catch(() => {});
  }

  if (st.lastSpoken !== st.screen) {
    st.lastSpoken = st.screen;
    speak(narration());
  }
}

/* ---------------- Events ---------------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  if (a === 'start') st.screen === 'perm' ? startDevices() : agreeAndStart();
  else if (a === 'photo') capturePhoto();
  else if (a === 'pan') recordPan();
  else if (a === 'submit') submit();
  else if (a === 'retake') { st.toast = null; st.stream ? (st.screen = 'capture', render()) : startDevices(); }
  else if (a === 'agent') requestAgent();
  else if (a === 'ces') sendCes(Number(el.dataset.n));
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'consentBox') {
    st.consentChecked = e.target.checked;
    $('#footer').innerHTML = footerHtml();
  }
});

const langSelect = $('#langSelect');
LANGS.forEach((x) => langSelect.add(new Option(x.native, x.code)));
langSelect.addEventListener('change', () => {
  st.lang = langSelect.value;
  st.lastSpoken = null;
  render();
});
$('#listenBtn').addEventListener('click', () => speak(narration(), true));

// Some browsers only populate voices asynchronously.
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {};

window.addEventListener('pagehide', stopDevices);

/* ---------------- Boot ---------------- */
async function boot() {
  if (!token) { st.screen = 'link'; return render(); }
  try {
    st.session = await withRetry(() => api('/session'));
  } catch (err) {
    st.screen = 'link';
    st.linkError = err.message;
    return render();
  }
  const s = st.session;
  st.lang = s.lang;
  st.autoVoice = s.assist;
  document.body.classList.toggle('large', s.assist);

  const byStatus = {
    created: 'intro', consented: 'intro', processing: 'review', review: 'review',
    accepted: 'accepted', agent_visit: 'agent', rejected: 'closed',
  };
  st.screen = byStatus[s.status] || 'closed';
  render();
}
boot();
