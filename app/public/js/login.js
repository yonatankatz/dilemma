'use strict';
// Admin login form -> POST /api/login, which sets the session cookie, then go to ?next=.
(() => {
  const form = document.getElementById('form');
  const err = document.getElementById('err');
  const btn = form.querySelector('button');
  const next = new URLSearchParams(location.search).get('next') || '/admin';
  const MESSAGES = {
    bad_credentials: 'שם משתמש או סיסמה שגויים',
    too_many_attempts: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות',
    not_configured: 'לא הוגדרה סיסמה בשרת',
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    err.textContent = '';
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          user: form.user.value.trim(),
          password: form.password.value,
          remember: form.remember.checked,
          next,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return location.replace(data.next || '/admin');
      err.textContent = MESSAGES[data.error] || 'משהו השתבש, נסו שוב';
      form.classList.remove('shake');
      void form.offsetWidth;
      form.classList.add('shake');
      form.password.select();
    } catch {
      err.textContent = 'בעיית חיבור, נסו שוב';
    } finally {
      btn.disabled = false;
    }
  });
})();
