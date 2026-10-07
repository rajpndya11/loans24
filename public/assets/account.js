const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS = {
  created: ['Not started', 'go'],
  consented: ['In progress', 'go'],
  processing: ['Under review', 'wait'],
  review: ['Under review', 'wait'],
  accepted: ['Verified ✓', 'ok'],
  agent_visit: ['Agent visit requested', 'wait'],
  rejected: ['Not approved — we will contact you', 'bad'],
  expired: ['Link expired', ''],
};
const PLACE = { salaried: '🏠 Home', business: '🏪 Shop / office', wfh: '💻 Home office', lowdigital: '🏠 Home' };

let user = null;
let formData = null;

async function api(path, { method = 'GET', json } = {}) {
  const res = await fetch(path, {
    method,
    headers: json ? { 'content-type': 'application/json' } : {},
    body: json ? JSON.stringify(json) : undefined,
  });
  if (res.status === 401) { location.replace(`/login?next=${encodeURIComponent('/account/')}`); throw new Error('LOGIN'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'ERROR'); e.data = data; throw e; }
  return data;
}

function show(view) {
  for (const v of ['listView', 'formView', 'confirmView']) $(v).classList.toggle('hidden', v !== view);
  window.scrollTo(0, 0);
}

async function loadList() {
  show('listView');
  const list = $('list');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const rows = await api('/api/me/verifications');
    if (!rows.length) {
      list.innerHTML = `<div class="card empty"><div class="pin" aria-hidden="true">🏠</div>
        <h3>No verifications yet</h3><p class="muted">Verify your address in about 2 minutes, right from your phone.</p>
        <button class="btn btn-primary" data-go="form" type="button">Verify an address</button></div>`;
      return;
    }
    list.innerHTML = rows.map((r) => {
      const [label, cls] = STATUS[r.status] || [r.status, ''];
      return `<div class="card vcard">
        <div>
          <span class="badge ${cls}">${esc(label)}</span>
          <div class="addr">${esc(r.businessName ? `${r.businessName} — ` : '')}${esc(r.address)}</div>
          <div class="small muted">${PLACE[r.placeType] || ''} · started ${new Date(r.createdAt).toLocaleDateString()}</div>
        </div>
        ${r.canContinue ? `<button class="btn btn-primary btn-sm" data-continue="${esc(r.id)}" type="button">Continue</button>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    if (e.message !== 'LOGIN') list.innerHTML = '<div class="notice bad">Could not load your verifications. Please refresh.</div>';
  }
}

function readForm() {
  const f = new FormData($('vForm'));
  return {
    placeType: f.get('placeType'),
    fullName: f.get('fullName'),
    businessName: f.get('businessName'),
    line1: f.get('line1'),
    area: f.get('area'),
    city: f.get('city'),
    pincode: f.get('pincode'),
    lang: f.get('lang'),
    assist: $('assist').checked,
    loanRef: f.get('loanRef'),
  };
}

function showErrors(errors = {}) {
  document.querySelectorAll('[data-err]').forEach((el) => {
    const msg = errors[el.dataset.err];
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
    const input = document.getElementById(el.dataset.err);
    if (input) input.classList.toggle('invalid', Boolean(msg));
  });
  const first = Object.keys(errors)[0];
  if (first) document.getElementById(first)?.focus();
}

function clientValidate(f) {
  const e = {};
  if (!f.fullName || f.fullName.trim().length < 2) e.fullName = 'Please enter your full name';
  if (f.placeType === 'shop' && !f.businessName?.trim()) e.businessName = 'Please enter your shop or business name';
  if (!f.line1 || f.line1.trim().length < 3) e.line1 = 'Please enter your house / flat / shop number and building';
  if (!f.area || f.area.trim().length < 2) e.area = 'Please enter your area or locality';
  if (!f.city || f.city.trim().length < 2) e.city = 'Please enter your city';
  if (!/^[1-9]\d{5}$/.test(f.pincode || '')) e.pincode = 'Pincode must be 6 digits';
  return e;
}

async function checkAddress() {
  $('formErr').classList.add('hidden');
  const f = readForm();
  const errors = clientValidate(f);
  showErrors(errors);
  if (Object.keys(errors).length) return;

  $('checkBtn').disabled = true;
  $('checkBtn').textContent = 'Finding your address…';
  try {
    const r = await api('/api/me/address-check', { method: 'POST', json: f });
    formData = f;
    if (r.found) {
      $('confirmTitle').textContent = r.precision === 'exact' ? 'We found your address' : 'We found your area';
      $('confirmLabel').textContent = r.label;
    } else {
      $('confirmTitle').textContent = 'Please confirm your address';
      $('confirmLabel').textContent = `${[f.line1, f.area, f.city, f.pincode].join(', ')} — we couldn't pinpoint it on the map, but that's OK. You can continue and our team will check it.`;
    }
    show('confirmView');
  } catch (e) {
    if (e.data?.errors) showErrors(e.data.errors);
    else if (e.message !== 'LOGIN') { $('formErr').textContent = 'Something went wrong. Please try again.'; $('formErr').classList.remove('hidden'); }
  } finally {
    $('checkBtn').disabled = false;
    $('checkBtn').textContent = 'Continue';
  }
}

async function start() {
  $('startBtn').disabled = true;
  $('startErr').classList.add('hidden');
  try {
    const r = await api('/api/me/verifications', { method: 'POST', json: formData });
    location.href = r.link;
  } catch (e) {
    if (e.message === 'LOGIN') return;
    $('startErr').textContent = e.data?.errors ? Object.values(e.data.errors)[0] : 'Could not start. Please try again.';
    $('startErr').classList.remove('hidden');
    $('startBtn').disabled = false;
  }
}

async function continueVerification(id, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/api/me/verifications/${encodeURIComponent(id)}/continue`, { method: 'POST' });
    location.href = r.link;
  } catch (e) {
    if (e.message !== 'LOGIN') { btn.disabled = false; loadList(); }
  }
}

/* Events */
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { go.dataset.go === 'form' ? show('formView') : loadList(); return; }
  const c = e.target.closest('[data-continue]');
  if (c) continueVerification(c.dataset.continue, c);
});
$('newBtn').addEventListener('click', () => show('formView'));
$('vForm').addEventListener('submit', (e) => { e.preventDefault(); checkAddress(); });
$('startBtn').addEventListener('click', start);
$('pincode').addEventListener('input', () => { $('pincode').value = $('pincode').value.replace(/\D/g, '').slice(0, 6); });
document.querySelectorAll('input[name="placeType"]').forEach((r) => r.addEventListener('change', () => {
  $('bizField').classList.toggle('hidden', readForm().placeType !== 'shop');
}));
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.replace('/');
});

/* Boot */
try {
  ({ user } = await api('/api/me'));
  $('who').textContent = user.name ? `Hi, ${user.name.split(' ')[0]}` : `+91 ${user.phone}`;
  if (user.name) $('fullName').value = user.name;
  loadList();
} catch { /* redirected to login */ }
