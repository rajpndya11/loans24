const $ = (id) => document.getElementById(id);
const next = (() => {
  const n = new URLSearchParams(location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/account/';
})();

const MESSAGES = {
  INVALID_PHONE: 'Please enter a valid 10-digit Indian mobile number.',
  WAIT: 'Please wait a few seconds before asking for another code.',
  TOO_MANY_REQUESTS: 'Too many codes requested. Please try again in an hour.',
  OTP_INVALID: 'That code is not correct.',
  OTP_EXPIRED: 'This code has expired. Please request a new one.',
  TOO_MANY_ATTEMPTS: 'Too many wrong attempts. Please request a new code.',
  DATABASE_UNAVAILABLE: 'The site cannot reach its database. (Site owner: check DATABASE_URL in Vercel.)',
};

let phone = '';
let timer;

function showErr(el, msg) {
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

function errorText(status, data) {
  if (data?.error === 'SETUP_INCOMPLETE') {
    return `The site isn't fully set up yet. Site owner, please add in Vercel → Settings → Environment Variables: ${data.problems.join('; ')}. Then redeploy.`;
  }
  if (MESSAGES[data?.error]) return MESSAGES[data.error];
  return `Something went wrong (server error ${status}). Please try again.`;
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/* Demo mode: the same browser keeps the same random demo number, so its verifications stay in "My account". */
function demoNumber() {
  try {
    const saved = localStorage.getItem('l24_demo_phone');
    if (saved && /^[6-9]\d{9}$/.test(saved)) return saved;
  } catch { /* storage blocked */ }
  const n = String(6 + Math.floor(Math.random() * 4)) + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  try { localStorage.setItem('l24_demo_phone', n); } catch { /* storage blocked */ }
  return n;
}

function startResendTimer(seconds = 30) {
  clearInterval(timer);
  let left = seconds;
  $('resendBtn').disabled = true;
  $('resendTimer').textContent = `in ${left}s`;
  timer = setInterval(() => {
    left--;
    $('resendTimer').textContent = left > 0 ? `in ${left}s` : '';
    if (left <= 0) { clearInterval(timer); $('resendBtn').disabled = false; }
  }, 1000);
}

async function sendCode() {
  showErr($('phoneErr'), '');
  const digits = $('phone').value.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  if (!/^[6-9]\d{9}$/.test(digits)) return showErr($('phoneErr'), MESSAGES.INVALID_PHONE);
  $('sendBtn').disabled = true;
  try {
    const { ok, status, data } = await post('/api/auth/otp', { phone: digits });
    if (!ok) {
      const msg = errorText(status, data);
      if (!$('otpForm').classList.contains('hidden')) showErr($('otpErr'), msg); else showErr($('phoneErr'), msg);
      if (data.retryAfter) startResendTimer(data.retryAfter);
      return;
    }
    phone = digits;
    $('sentTo').textContent = `+91 ${data.phone}`;
    $('devNotice').classList.toggle('hidden', !data.devCode);
    $('devCode').textContent = data.devCode || '';
    $('phoneForm').classList.add('hidden');
    $('otpForm').classList.remove('hidden');
    $('otp').value = data.devCode || '';
    (data.devCode ? $('verifyBtn') : $('otp')).focus();
    startResendTimer();
  } catch {
    showErr($('phoneErr'), 'No internet connection. Please try again.');
  } finally {
    $('sendBtn').disabled = false;
  }
}

async function verify() {
  showErr($('otpErr'), '');
  const code = $('otp').value.trim();
  if (!/^\d{6}$/.test(code)) return showErr($('otpErr'), 'Please enter the 6-digit code.');
  $('verifyBtn').disabled = true;
  try {
    const { ok, status, data } = await post('/api/auth/verify', { phone, code });
    if (ok) { location.replace(next); return; }
    let msg = errorText(status, data);
    if (data.attemptsLeft != null) msg += ` ${data.attemptsLeft} attempt(s) left.`;
    showErr($('otpErr'), msg);
  } catch {
    showErr($('otpErr'), 'No internet connection. Please try again.');
  } finally {
    $('verifyBtn').disabled = false;
  }
}

$('phoneForm').addEventListener('submit', (e) => { e.preventDefault(); sendCode(); });
$('otpForm').addEventListener('submit', (e) => { e.preventDefault(); verify(); });
$('otp').addEventListener('input', () => {
  $('otp').value = $('otp').value.replace(/\D/g, '').slice(0, 6);
  if ($('otp').value.length === 6) verify();
});
$('resendBtn').addEventListener('click', sendCode);
$('changeBtn').addEventListener('click', () => {
  clearInterval(timer);
  $('otpForm').classList.add('hidden');
  $('phoneForm').classList.remove('hidden');
  $('phone').focus();
});

// Already logged in? Skip straight to the account.
fetch('/api/me').then((r) => { if (r.ok) location.replace(next); }).catch(() => {});

// Demo mode: pre-fill a random demo number and explain that no SMS is sent.
fetch('/api/auth/config')
  .then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { if (data.error === 'SETUP_INCOMPLETE') showErr($('phoneErr'), errorText(r.status, data)); return; }
    if (!data.demo) return;
    $('demoBanner').classList.remove('hidden');
    $('loginIntro').textContent = 'Log in to verify your address.';
    $('phone').value = demoNumber().replace(/(\d{5})(\d{5})/, '$1 $2');
    $('sendBtn').textContent = 'Get login code';
  })
  .catch(() => {});
