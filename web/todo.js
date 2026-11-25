// Moved out of todo.html (25 Nov 2026) so the CSP can block inline scripts.
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    const api = b => fetch('/api/manage/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
    function item(t) {
      return `<div class="todo ${t.done ? 'done' : ''}" data-id="${t.id}">
        <label class="tick"><input type="checkbox" ${t.done ? 'checked' : ''} data-act="done"></label>
        <div class="tbody"><div class="ttitle">${esc(t.title)}</div>
          ${t.detail ? `<div class="tdetail">${esc(t.detail)}</div>` : ''}
          ${t.owner === 'Michael' && !t.done ? `<textarea rows="1" placeholder="Your answer (optional)…" data-act="answer">${esc(t.answer || '')}</textarea>` : (t.answer ? `<div class="tdetail"><b>Answer:</b> ${esc(t.answer)}</div>` : '')}
          <div class="tmeta">${t.owner} · added ${new Date(t.created).toLocaleDateString('en-GB')}${t.doneAt ? ' · done ' + new Date(t.doneAt).toLocaleDateString('en-GB') : ''}
            <button class="linkbtn" data-act="delete">delete</button></div></div></div>`;
    }
    function render(list) {
      const open = list.filter(t => !t.done);
      document.getElementById('tMichael').innerHTML = open.filter(t => t.owner === 'Michael').map(item).join('') || '<p class="muted">Nothing – all caught up.</p>';
      document.getElementById('tClaude').innerHTML = open.filter(t => t.owner === 'Claude').map(item).join('') || '<p class="muted">Nothing queued.</p>';
      document.getElementById('tDone').innerHTML = list.filter(t => t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).map(item).join('') || '<p class="muted">Nothing yet.</p>';
    }
    fetch('/api/manage/todos').then(r => r.json()).then(j => render(j.todos));
    document.addEventListener('change', async e => {
      const el = e.target, id = el.closest('[data-id]')?.dataset.id; if (!id) return;
      if (el.dataset.act === 'done') render((await api({ action: 'update', id, done: el.checked })).todos);
      if (el.dataset.act === 'answer') render((await api({ action: 'update', id, answer: el.value })).todos);
    });
    document.addEventListener('click', async e => {
      const el = e.target.closest('[data-act="delete"]'); if (!el) return;
      if (!confirm('Delete this item?')) return;
      render((await api({ action: 'delete', id: el.closest('[data-id]').dataset.id })).todos);
    });
    document.getElementById('tadd').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target;
      render((await api({ action: 'add', title: f.title.value, owner: f.owner.value })).todos); f.reset();
    });
  
