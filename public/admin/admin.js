const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

let apiKey = '';
let reviewer = '';
let selected = null;
let blobUrls = [];

try {
  apiKey = sessionStorage.getItem('apiKey') || '';
  reviewer = sessionStorage.getItem('reviewer') || '';
} catch { /* storage unavailable */ }
$('#apiKey').value = apiKey;
$('#reviewer').value = reviewer;

async function api(path, { method = 'GET', json } = {}) {
  const res = await fetch(`/api/internal${path}`, {
    method,
    headers: { 'x-api-key': apiKey, ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ? `${data.error}${data.fields ? ': ' + data.fields.join(', ') : ''}` : `HTTP ${res.status}`);
  return data;
}

async function loadList() {
  const status = $('#statusFilter').value;
  const list = $('#sessionList');
  try {
    const rows = await api(`/sessions?limit=100${status ? `&status=${encodeURIComponent(status)}` : ''}`);
    if (!rows.length) { list.innerHTML = '<p class="muted">No sessions.</p>'; return; }
    list.innerHTML = rows.map((r) => `<button class="item ${r.id === selected ? 'active' : ''}" data-id="${esc(r.id)}" type="button">
        <span class="pill ${esc(r.status)}">${esc(r.status)}</span> ${r.score != null ? `<b>${r.score}</b>` : ''}
        <div>${esc(r.applicant_name)}</div>
        <small>Loan ${esc(r.loan_id)} · ${esc(r.persona)} · ${fmt(r.created_at)}</small></button>`).join('');
  } catch (e) {
    list.innerHTML = `<p class="muted">Could not load: ${esc(e.message)}</p>`;
  }
}

async function fetchBlobUrl(captureId) {
  const res = await fetch(`/api/internal/captures/${captureId}/file`, { headers: { 'x-api-key': apiKey } });
  if (!res.ok) return null;
  const url = URL.createObjectURL(await res.blob());
  blobUrls.push(url);
  return url;
}

const mapLink = (lat, lng, text = 'View on map') => (lat != null
  ? `<a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : '');

const REASON_TEXT = {
  GEO_OUTSIDE: 'Photos taken far from the declared address',
  GEO_NEAR: 'Photos taken a little away from the declared address',
  GEO_APPROX: 'Address only found at area level on the map',
  GEO_UNVERIFIED: 'Address could not be found on the map',
  GPS_MISSING: 'Phone did not share location',
  GPS_LOW_ACCURACY: 'Weak GPS signal',
  GPS_INCONSISTENT: 'Photos taken at different places',
  CLOCK_SKEW: 'Phone clock does not match server time',
  NAME_NOT_FOUND: 'Name not readable on nameplate / signboard',
  NAME_PARTIAL: 'Name only partly matches nameplate / signboard',
  NAME_NOT_CHECKED: 'Nameplate reading (OCR) is switched off',
  DUPLICATE_IMAGE: 'Same photo used on another application',
};

function distanceText(c) {
  if (c.lat == null) return 'No location from phone';
  const acc = c.accuracy_m != null ? ` (GPS accuracy ±${Math.round(c.accuracy_m)} m)` : '';
  if (c.distanceM == null) return `Location received${acc}`;
  const d = c.distanceM >= 1000 ? `${(c.distanceM / 1000).toFixed(1)} km` : `${c.distanceM} m`;
  return `📍 ${d} from declared address${acc}`;
}

async function loadDetail(id) {
  selected = id;
  blobUrls.forEach(URL.revokeObjectURL);
  blobUrls = [];
  const el = $('#detail');
  el.innerHTML = '<p class="muted">Loading…</p>';
  let d;
  try { d = await api(`/sessions/${id}`); } catch (e) { el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const s = d.session;

  const reasons = s.reasons.length
    ? `<table>${s.reasons.map((r) => `<tr><th>${esc(REASON_TEXT[r.code] || r.code)}</th><td>−${r.penalty}</td><td>${esc(r.detail)}</td></tr>`).join('')}</table>`
    : '<p class="muted">No deductions.</p>';

  el.innerHTML = `
    <h2>${esc(s.applicant_name)} <span class="pill ${esc(s.status)}">${esc(s.status)}</span></h2>
    <p class="muted">Loan ${esc(s.loan_id)} · ${esc(s.persona)} · language ${esc(s.lang)} · attempt ${s.attempt}</p>
    ${s.score != null ? `<div class="score">${s.score}<span class="muted">/100</span></div>` : ''}
    ${s.status === 'review' ? `
      <h3>Decision</h3>
      <div class="decide">
        <textarea id="note" rows="2" placeholder="Note (required to reject)"></textarea>
        <button class="primary" data-decide="accepted" type="button">Accept</button>
        <button data-decide="agent_visit" type="button">Send agent</button>
        <button class="danger" data-decide="rejected" type="button">Reject</button>
      </div>` : ''}
    <h3>Reason codes</h3>${reasons}
    <h3>Details</h3>
    <table>
      <tr><th>Declared address</th><td>${esc(s.address_text)}</td></tr>
      <tr><th>Business name</th><td>${esc(s.business_name || '—')}</td></tr>
      <tr><th>Found on map as</th><td>${s.declared_lat != null
        ? `${esc(s.geocode_label || 'Location provided by loan system')} ${s.geo_precision === 'area' ? '<span class="pill review">area only</span>' : ''} · ${mapLink(s.declared_lat, s.declared_lng)}`
        : '<span class="pill review">Not found on map</span>'}</td></tr>
      <tr><th>Consent</th><td>${fmt(s.consent_at)} (${esc(s.consent_version || '—')})</td></tr>
      <tr><th>Created / expires</th><td>${fmt(s.created_at)} / ${fmt(s.expires_at)}</td></tr>
      <tr><th>Submitted</th><td>${fmt(s.submitted_at)}</td></tr>
      <tr><th>Decided</th><td>${fmt(s.decided_at)} ${esc(s.decided_by || '')} ${s.review_note ? '— ' + esc(s.review_note) : ''}</td></tr>
      <tr><th>Customer effort (CES)</th><td>${s.ces ?? '—'}</td></tr>
    </table>
    <h3>Captures (${d.captures.length})</h3>
    <div class="media" id="media">${d.captures.map((c) => `
      <figure class="${c.quality_ok ? '' : 'fail'}">
        ${c.kind === 'photo' ? `<img data-cap="${esc(c.id)}" alt="Capture">` : `<video data-cap="${esc(c.id)}" controls preload="metadata"></video>`}
        <figcaption>${esc(c.kind)} · attempt ${c.attempt} · ${fmt(c.server_ts)}<br>
          ${esc(distanceText(c))} ${mapLink(c.lat, c.lng)}
          ${c.quality ? `<br>sharp ${c.quality.checks.sharpness.value} · light ${c.quality.checks.lighting.value} ${c.quality.ok ? '✓' : '✗ ' + esc(c.quality.hint)}` : ''}
        </figcaption>
      </figure>`).join('') || '<p class="muted">None.</p>'}</div>
    <h3>Audit trail</h3>
    <table>${d.events.map((e) => `<tr><th>${fmt(e.at)}</th><td><b>${esc(e.type)}</b> · ${esc(e.actor)}</td><td class="mono">${e.data ? esc(JSON.stringify(e.data)) : ''}</td></tr>`).join('')}</table>`;

  for (const m of el.querySelectorAll('[data-cap]')) {
    const url = await fetchBlobUrl(m.dataset.cap);
    if (url && selected === id) m.src = url;
  }
  loadList();
}

async function decide(decision) {
  const note = $('#note')?.value.trim();
  if (decision === 'rejected' && !note) { alert('A note is required to reject.'); return; }
  if (!confirm(`Confirm: ${decision}?`)) return;
  try {
    await api(`/sessions/${selected}/decision`, { method: 'POST', json: { decision, reviewer, note } });
    await loadDetail(selected);
  } catch (e) { alert(e.message); }
}

$('#authForm').addEventListener('submit', (e) => {
  e.preventDefault();
  apiKey = $('#apiKey').value.trim();
  reviewer = $('#reviewer').value.trim();
  try { sessionStorage.setItem('apiKey', apiKey); sessionStorage.setItem('reviewer', reviewer); } catch { /* ignore */ }
  loadList();
});
$('#statusFilter').addEventListener('change', loadList);
$('#refreshBtn').addEventListener('click', loadList);
$('#sessionList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (b) loadDetail(b.dataset.id);
});
$('#detail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-decide]');
  if (b) decide(b.dataset.decide);
});

$('#newBtn').addEventListener('click', () => { $('#newResult').textContent = ''; $('#newDialog').showModal(); });
$('#createBtn').addEventListener('click', async () => {
  const form = $('#newForm');
  if (!form.reportValidity()) return;
  const f = Object.fromEntries(new FormData(form));
  const body = { ...f, businessName: f.businessName || undefined, assist: f.assist === 'on' };
  $('#createBtn').disabled = true;
  try {
    const r = await api('/sessions', { method: 'POST', json: body });
    const where = r.location.found
      ? `Found on map: ${esc(r.location.label)}${r.location.precision === 'area' ? ' (area only)' : ''}`
      : 'Address not found on map — it will go to manual review.';
    $('#newResult').innerHTML = `${where}<br><br>Customer link (send via SMS/WhatsApp):<br><a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.link)}</a>`;
    loadList();
  } catch (e) { $('#newResult').textContent = e.message; } finally { $('#createBtn').disabled = false; }
});

if (apiKey) loadList();
