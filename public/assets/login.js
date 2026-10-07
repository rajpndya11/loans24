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
};

let phone = '';
let timer;

function showErr(el, msg) {
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
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
    const { ok, data } = await post('/api/auth/otp', { phone: digits });
    if (!ok) {
      const msg = MESSAGES[data.error] || 'Could not send the code. Please try again.';
      if (!$('otpForm').classList.contains('hidden')) showErr($('otpErr'), msg); else showErr($('phoneErr'), msg);
      if (data.retryAfter) startResendTimer(data.retryAfter);
      return;
    }
    phone = digits;
    $('sentTo').textContent = `+91 ${data.phone}`;
    $('devNotice').classList.toggle('hidden', !data.devCode);
    $('devNotice').textContent = data.devCode ? `Demo mode (no SMS configured): your code is ${data.devCode}` : '';
    $('phoneForm').classList.add('hidden');
    $('otpForm').classList.remove('hidden');
    $('otp').value = '';
    $('otp').focus();
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
    const { ok, data } = await post('/api/auth/verify', { phone, code });
    if (ok) { location.replace(next); return; }
    let msg = MESSAGES[data.error] || 'Something went wrong. Please try again.';
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
