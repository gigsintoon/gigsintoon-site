// Contact form (moved out of contact.html, 25 Nov 2026)
    document.getElementById('cform').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, st = document.getElementById('cstatus'), btn = f.querySelector('button');
      const body = Object.fromEntries(new FormData(f));
      if ((body.message || '').trim().length < 5) { st.textContent = 'Please write a message.'; return; }
      btn.disabled = true; st.textContent = 'Sending…';
      try {
        const r = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) { f.reset(); st.textContent = 'Thanks – your message has been sent.'; }
        else st.textContent = j.error || 'Sorry, that didn’t send. Please try again.';
      } catch { st.textContent = 'Sorry, that didn’t send. Please try again.'; }
      btn.disabled = false;
    });
  
