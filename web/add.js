const $ = id => document.getElementById(id);
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const ord = n => n + (['th','st','nd','rd'][(n % 100 - 20) % 10] || ['th','st','nd','rd'][n % 100] || 'th');
const safe = s => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const STATUS = { none: ['NotPosted', false], orange: ['Drafted', false], green: ['Posted', true], red: ['DoNotPost', false] };

fetch('/api/manage/bands').then(r => r.json()).then(j => { $('bandlist').innerHTML = j.bands.map(b => `<option value="${esc(b)}">`).join(''); });

const f = $('addf');
f.writeUp.addEventListener('input', () => { $('wcount').textContent = f.writeUp.value.length + ' characters'; });
f.date.addEventListener('change', () => {
  if (!f.writeUp.value && f.date.value) f.writeUp.value = `On this day in ${f.date.value.slice(0, 4)}, `;
});
f.addEventListener('change', e => {
  if (e.target.type !== 'file') return;
  $('previews').innerHTML = ['Cover', 'CD1', 'CD2'].map(k => f[k].files[0]
    ? `<figure><img src="${URL.createObjectURL(f[k].files[0])}" alt=""><figcaption>${k}</figcaption></figure>` : '').join('');
});

f.addEventListener('submit', async e => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  const st = $('astatus'), btn = f.querySelector('button[type=submit]');
  if (!v.band.trim() || !v.title.trim() || !v.date) { st.textContent = 'Band, title and date are needed.'; return; }
  btn.disabled = true;
  try {
    const [y, m, d] = v.date.split('-').map(Number);
    const folder = `${String(m).padStart(2, '0')} - ${MONTHS[m - 1]}/${ord(d)}`;
    const stem = `${safe(v.band.trim())} - ${safe(v.title.trim())}`;
    const images = [];
    for (const kind of ['Cover', 'CD1', 'CD2']) {
      const file = f[kind].files[0];
      if (!file) continue;
      st.textContent = `Uploading ${kind}…`;
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace('jpeg', 'jpg');
      const path = `${folder}/${stem}${kind === 'Cover' ? '' : ' ' + kind}.${ext}`;
      const r = await fetch('/api/manage/upload?path=' + encodeURIComponent(path), { method: 'POST', body: file });
      const j = await r.json();
      if (!j.ok) throw new Error(`${kind}: ${j.error}`);
      images.push({ kind, path });
    }
    st.textContent = 'Saving…';
    const [status, onSonos] = STATUS[v.colour];
    const rel = { band: v.band.trim(), artistDisplay: v.artistDisplay.trim() || null, title: v.title.trim(), type: v.type, date: v.date,
      chart: v.chart ? +v.chart : null, chartNote: v.chartNote.trim() || null, label: v.label.trim() || null,
      writeUp: v.writeUp.trim() || null, tagNotes: v.tagNotes.trim() || null, status, onSonos, images };
    const r = await fetch('/api/manage/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rel) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Save failed');
    const saved = (j.saved || [])[0] || {};
    await fetch('/api/manage/site-additions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...rel, colour: v.colour, releaseId: saved.ReleaseId || null }) });
    st.innerHTML = `Saved. <a href="/?date=${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}">See it on ${ord(d)} ${MONTHS[m - 1]}</a>`;
    f.reset(); $('previews').innerHTML = ''; $('wcount').textContent = '';
    loadPending();
  } catch (err) {
    st.textContent = 'Not saved: ' + err.message;
  }
  btn.disabled = false;
});

async function loadPending() {
  const { additions } = await (await fetch('/api/manage/site-additions')).json();
  $('pending').innerHTML = additions.length
    ? '<ul>' + additions.map(a => `<li>${esc(a.date)} – <b>${esc(a.band)}</b> – ${esc(a.title)} <span class="muted">(${esc(a.type)}, ${esc(a.colour)}${a.images && a.images.length ? ', ' + a.images.length + ' image(s)' : ''})</span></li>`).join('') + '</ul><p>Ask Claude to “copy the site additions into the spreadsheet” and they’ll be added to the spreadsheet and folders, then cleared from here.</p>'
    : 'Nothing waiting – everything added here is already in the spreadsheet.';
}
loadPending();
