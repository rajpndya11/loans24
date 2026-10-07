// Home page: if already logged in, point the buttons at the account page.
try {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (res.ok) {
    const nav = document.getElementById('navCta');
    const hero = document.getElementById('heroCta');
    nav.textContent = 'My account';
    nav.href = '/account/';
    hero.textContent = 'Go to my account';
    hero.href = '/account/';
  }
} catch { /* offline: keep Login */ }
