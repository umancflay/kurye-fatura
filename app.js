'use strict';

/* ---------- Durum ve saklama ---------- */

const STORE_KEY = 'kuryeFatura.v1'; // çevrimdışı önbellek; asıl kayıt Supabase'te
const CFG = window.KURYE_CONFIG || {};
const sb = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey)
  : null;

const uid = () => Math.random().toString(36).slice(2, 10);

function defaultState() {
  return {
    categories: [
      { id: 'tekli', name: 'İlk paket', price: 0 },
      { id: 'ciftli', name: 'Birleşen', price: 0 },
      { id: 'carsi', name: 'Çarşı', price: 0 },
      { id: 'finans', name: 'Finans', price: 0 },
      { id: 'yemek', name: 'Yemek', price: 0 },
      { id: 'haftasonu', name: 'Hafta sonu', price: 0 },
    ],
    expenses: [],
    people: [],
    records: {},
    company: '',
    footerNote: 'Lütfen bu tutara fatura kesiniz.',
    aiEngine: 'gemini',
    // Hafta sonu bonusu: hafta sonu başına teslimat sayısına göre (max boş = üstü)
    weekendTiers: [
      { min: 50, max: 70, amount: 600 },
      { min: 71, max: 80, amount: 700 },
      { min: 81, max: 90, amount: 850 },
      { min: 91, max: 110, amount: 1100 },
      { min: 111, max: '', amount: 1500 },
    ],
    updatedAt: 0,
  };
}

function cacheKey() { return STORE_KEY + ':' + (user?.id || 'anon'); }
function cacheLoad() {
  try { return JSON.parse(localStorage.getItem(cacheKey())) || {}; } catch { return {}; }
}
function cacheSave() {
  try { localStorage.setItem(cacheKey(), JSON.stringify(state)); } catch {}
}

let user = null;
let state = defaultState();

let pushTimer = null;
function save() {
  state.updatedAt = Date.now();
  cacheSave();
  clearTimeout(pushTimer);
  setSync('kaydediliyor…');
  pushTimer = setTimeout(pushCloud, 800);
}
window.addEventListener('beforeunload', e => {
  if (pushTimer) { pushCloud(); e.preventDefault(); }
});

/* ---------- Yardımcılar ---------- */

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(n || 0);
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; };
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const periodLabel = p => { const [y, m] = p.split('-'); return `${MONTHS[+m - 1]} ${y}`; };

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}

function setSync(text, title = '') {
  const el = $('#syncState');
  el.textContent = text;
  el.title = title;
}
const titleCase = name => name === name.toLocaleUpperCase('tr')
  ? name.toLocaleLowerCase('tr').replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('tr'))
  : name;
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toLocaleUpperCase('tr')).join('');

// Türkçe karakterleri sadeleştirip isim eşleştirme için normalize eder.
function norm(s) {
  return String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/[çc]/g, 'c').replace(/[şs]/g, 's').replace(/[ğg]/g, 'g')
    .replace(/[ıi̇i]/g, 'i').replace(/[öo]/g, 'o').replace(/[üu]/g, 'u')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function bigrams(s) {
  const out = [];
  s = s.replace(/ /g, '');
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Kelime sırası farklı olabilir: "Şahin Abdülhalim"
  if (a.split(' ').sort().join(' ') === b.split(' ').sort().join(' ')) return 0.98;
  const A = bigrams(a), B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const pool = [...B];
  let hit = 0;
  for (const g of A) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (A.length + B.length);
}
function matchPerson(name) {
  let best = null, score = 0;
  for (const p of state.people) {
    for (const cand of [p.name, ...(p.aliases || [])]) {
      const s = similarity(name, cand);
      if (s > score) { score = s; best = p; }
    }
  }
  return score >= 0.72 ? best : null;
}

function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '90' + d.slice(1);
  if (d.length === 10 && d.startsWith('5')) d = '90' + d;
  return d;
}

/* ---------- Hesaplama ---------- */

const currentPeriod = () => $('#period').value;
const personById = id => state.people.find(p => p.id === id);
const record = (pid, period = currentPeriod()) => state.records[period]?.[pid];

const WEEKEND = 'haftasonu';

// Ayın hafta sonu sayısı = o aydaki cumartesi sayısı
function weekendsIn(period) {
  const [y, m] = period.split('-').map(Number);
  let n = 0;
  for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) if (new Date(y, m - 1, d).getDay() === 6) n++;
  return n || 4;
}
function weekendTier(perWeekend) {
  const t = (state.weekendTiers || []).find(t => perWeekend >= num(t.min) && (t.max === '' || t.max == null || perWeekend <= num(t.max)));
  return t ? num(t.amount) : 0;
}
// Ekranda sadece aylık toplam var: hafta sonu başına ortalamaya göre barem bulunur, hafta sonu sayısıyla çarpılır
function weekendBonus(total, period = currentPeriod()) {
  const weekends = weekendsIn(period);
  const avg = Math.round(total / weekends);
  const per = weekendTier(avg);
  return { weekends, avg, per, amount: per * weekends };
}

function calc(person, rec) {
  const lines = state.categories.map(c => {
    const count = num(rec?.counts?.[c.id]);
    if (c.id === WEEKEND) {
      const b = weekendBonus(count);
      return {
        id: c.id, name: c.name + ' bonusu', count, price: b.per, amount: b.amount, bonus: true,
        note: `${b.weekends} hafta sonu × ort. ${b.avg} paket → ${b.per ? money(b.per) + ' / hafta sonu' : 'barem altı'}`,
      };
    }
    const custom = person.prices?.[c.id];
    const price = custom === '' || custom == null ? num(c.price) : num(custom);
    return { id: c.id, name: c.name, count, price, amount: count * price };
  });
  const gross = lines.reduce((s, l) => s + l.amount, 0);
  const expenses = state.expenses.map(e => {
    const o = person.expenses?.[e.id] || {};
    const enabled = o.enabled ?? e.enabled;
    const rate = o.rate === '' || o.rate == null ? num(e.rate) : num(o.rate);
    return { id: e.id, name: e.name, mode: e.mode, rate, enabled, amount: gross * rate / 100 };
  }).filter(e => e.enabled && e.rate);
  const net = expenses.reduce((s, e) => s + (e.mode === 'add' ? e.amount : -e.amount), gross);
  // Hafta sonu paketleri İlk/Birleşen içinde zaten sayılı, tekrar toplanmaz
  const packages = lines.filter(l => !l.bonus).reduce((s, l) => s + l.count, 0);
  return { lines, gross, expenses, net, packages };
}

/* ---------- Sekmeler ---------- */

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  render();
}

function shiftMonth(delta) {
  const [y, m] = currentPeriod().split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  $('#period').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  render();
}
$('#prevMonth').onclick = () => shiftMonth(-1);
$('#nextMonth').onclick = () => shiftMonth(1);
$('#period').onchange = render;
{
  const d = new Date();
  $('#period').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Eski kayıtlara sonradan eklenen varsayılanları bir kez uygular
function migrate() {
  if (!state.migratedGemini) {
    state.migratedGemini = true;
    if (state.aiEngine === 'claude' && !state.claudeKey) state.aiEngine = 'gemini';
    save();
  }
  if (!state.migratedHaftasonu) {
    state.migratedHaftasonu = true;
    if (!state.categories.some(c => c.id === 'haftasonu')) {
      state.categories.push({ id: 'haftasonu', name: 'Hafta sonu', price: 0 });
    }
    for (const c of state.categories) {
      if (c.id === 'tekli' && c.name === 'Tekli (İlk paket)') c.name = 'İlk paket';
      if (c.id === 'ciftli' && c.name === 'Çiftli (Birleşen)') c.name = 'Birleşen';
    }
    save();
  }
}

function render() {
  if (user) migrate();
  renderPeriod();
  renderPeople();
  renderSettings();
}

/* ---------- Dönem listesi ---------- */

function renderPeriod() {
  const q = norm($('#search').value);
  const recs = state.records[currentPeriod()] || {};
  let gross = 0, net = 0, pk = 0, sent = 0, count = 0;
  const withRec = [], without = [];
  for (const p of state.people) {
    if (q && !norm(p.name).includes(q)) continue;
    (recs[p.id] ? withRec : without).push(p);
  }
  for (const p of withRec) {
    const c = calc(p, recs[p.id]);
    gross += c.gross; net += c.net; pk += c.packages; count++;
    if (recs[p.id].sentAt) sent++;
  }
  $('#summary').innerHTML = `
    <div class="stat hero"><span>Kesilecek fatura toplamı · ${periodLabel(currentPeriod())}</span><b>${money(net)}</b></div>
    <div class="stat"><span>Brüt toplam</span><b>${money(gross)}</b></div>
    <div class="stat"><span>Toplam paket</span><b>${pk.toLocaleString('tr-TR')}</b></div>
    <div class="stat"><span>Gönderilen</span><b>${sent} / ${count}</b></div>`;

  const who = (p, sub) => `<div class="who"><span class="avatar">${esc(initials(p.name))}</span>
    <div style="min-width:0"><div class="name">${esc(p.name)}</div><div class="sub">${sub}</div></div></div>`;
  const card = p => {
    const rec = recs[p.id];
    if (!rec) {
      return `<div class="card pcard empty"><div class="head">${who(p, 'Bu dönem için veri yok')}
        <button class="secondary" data-act="edit" data-id="${p.id}">Elle gir</button></div></div>`;
    }
    const c = calc(p, rec);
    const chips = c.lines.filter(l => l.count).map(l => `<span class="chip">${esc(l.name)} <b>${l.count}</b></span>`).join('');
    const sentBadge = rec.sentAt
      ? `<span class="badge ok">✓ gönderildi ${new Date(rec.sentAt).toLocaleDateString('tr-TR')}</span>`
      : `<span class="badge">gönderilmedi</span>`;
    return `<div class="card pcard">
      <div class="head">${who(p, `Brüt ${money(c.gross)}${c.expenses.length ? ' · gider ' + money(c.gross - c.net) : ''}`)}<span class="total">${money(c.net)}</span></div>
      <div class="chips">${chips || '<span class="muted small">paket yok</span>'}</div>
      <div>${sentBadge}</div>
      <div class="actions">
        <button class="wa" data-act="send" data-id="${p.id}"><svg><use href="#i-wa"/></svg>WhatsApp</button>
        <button class="secondary" data-act="preview" data-id="${p.id}">Görsel</button>
        <button class="secondary" data-act="edit" data-id="${p.id}">Düzenle</button>
      </div></div>`;
  };
  $('#periodList').innerHTML =
    (withRec.map(card).join('') + without.map(card).join('')) ||
    `<div class="card muted">Kayıt yok.</div>`;
}
$('#search').oninput = renderPeriod;
$('#periodList').onclick = e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  if (act === 'edit') editRecord(id);
  if (act === 'preview') previewInvoice(id);
  if (act === 'send') sendWhatsApp(id);
};

function editRecord(pid) {
  const p = personById(pid);
  const rec = record(pid) || { counts: {} };
  openModal(`
    <h2>${esc(p.name)} — ${periodLabel(currentPeriod())}</h2>
    <div class="grid-counts">
      ${state.categories.map(c => `<label>${esc(c.name)}<input type="number" min="0" inputmode="numeric" name="${c.id}" value="${rec.counts[c.id] ?? ''}"></label>`).join('')}
    </div>
    <div class="row gap end" style="margin-top:12px">
      ${record(pid) ? '<button type="button" class="danger" data-x="del">Dönem kaydını sil</button>' : ''}
      <button value="cancel" class="secondary">Vazgeç</button>
      <button value="ok">Kaydet</button>
    </div>`, (form, value) => {
    if (value !== 'ok') return;
    const counts = {};
    for (const c of state.categories) counts[c.id] = num(form.elements[c.id].value);
    setRecord(pid, counts, false);
    save(); render();
  }, { del: () => { delete state.records[currentPeriod()][pid]; save(); closeModal(); render(); } });
}

function setRecord(pid, counts, add) {
  const period = currentPeriod();
  state.records[period] ??= {};
  const prev = state.records[period][pid];
  const next = { counts: {}, updatedAt: Date.now() };
  for (const c of state.categories) {
    next.counts[c.id] = (add ? num(prev?.counts?.[c.id]) : 0) + num(counts[c.id]);
  }
  state.records[period][pid] = next; // veri değiştiyse "gönderildi" bilgisi sıfırlanır
}

/* ---------- Modal ---------- */

function openModal(html, onClose, extra = {}) {
  const dlg = $('#modal'), form = $('#modalForm');
  form.innerHTML = html;
  form.onclick = e => {
    const x = e.target.closest('[data-x]');
    if (x && extra[x.dataset.x]) extra[x.dataset.x](e);
  };
  dlg.onclose = () => onClose && onClose(form, dlg.returnValue);
  dlg.returnValue = '';
  dlg.showModal();
}
function closeModal() { const d = $('#modal'); d.onclose = null; d.close(); }

/* ---------- Kişiler ---------- */

function renderPeople() {
  const q = norm($('#personSearch').value);
  const list = state.people
    .filter(p => !q || norm(p.name).includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  $('#personList').innerHTML = list.map(p => {
    const custom = Object.entries(p.prices || {}).filter(([, v]) => v !== '' && v != null).length;
    return `<div class="card pcard">
      <div class="head"><div class="who"><span class="avatar">${esc(initials(p.name))}</span>
        <div style="min-width:0"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.phone || 'numara yok')}</div></div></div></div>
      <div class="small muted">${custom ? custom + ' özel fiyat' : 'standart fiyatlar'}${p.aliases?.length ? ' · eşleşen adlar: ' + esc(p.aliases.join(', ')) : ''}</div>
      <div class="actions">
        <button class="secondary" data-act="edit" data-id="${p.id}">Düzenle</button>
        <button class="danger" data-act="del" data-id="${p.id}">Sil</button>
      </div></div>`;
  }).join('') || '<div class="card muted">Kişi yok.</div>';
}
$('#personSearch').oninput = renderPeople;
$('#addPerson').onclick = () => editPerson(null);
$('#personList').onclick = e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const p = personById(b.dataset.id);
  if (b.dataset.act === 'edit') editPerson(p);
  if (b.dataset.act === 'del' && confirm(`${p.name} silinsin mi? Tüm dönem kayıtları da silinir.`)) {
    state.people = state.people.filter(x => x.id !== p.id);
    for (const per of Object.values(state.records)) delete per[p.id];
    save(); render();
  }
};

function editPerson(p, presetName = '', after) {
  const isNew = !p;
  p = p || { id: uid(), name: presetName, phone: '', prices: {}, expenses: {}, aliases: [] };
  openModal(`
    <h2>${isNew ? 'Yeni kişi' : esc(p.name)}</h2>
    <label>Ad soyad (ekran görüntüsündeki gibi)<input name="name" required value="${esc(p.name)}"></label>
    <label>WhatsApp numarası<input name="phone" type="tel" placeholder="05xx xxx xx xx" value="${esc(p.phone)}"></label>
    <label>Diğer yazılışlar (virgülle) — eşleştirme için<input name="aliases" value="${esc((p.aliases || []).join(', '))}"></label>
    <h2 style="margin-top:14px">Kişiye özel fiyatlar</h2>
    <p class="muted small" style="margin:0">Boş bırak = standart fiyat.</p>
    <div class="grid-counts">
      ${state.categories.filter(c => c.id !== WEEKEND).map(c => `<label>${esc(c.name)}<input type="number" step="0.01" inputmode="decimal" name="price_${c.id}" placeholder="${num(c.price)}" value="${p.prices?.[c.id] ?? ''}"></label>`).join('')}
    </div>
    ${state.expenses.length ? `<h2 style="margin-top:14px">Giderler</h2>
      ${state.expenses.map(e => {
        const o = p.expenses?.[e.id] || {};
        return `<div class="setrow" style="grid-template-columns:1fr 100px auto">
          <span>${esc(e.name)} <span class="muted small">(${e.mode === 'add' ? 'ekle' : 'düş'})</span></span>
          <input type="number" step="0.01" name="exprate_${e.id}" placeholder="%${num(e.rate)}" value="${o.rate ?? ''}">
          <label class="check"><input type="checkbox" name="expon_${e.id}" ${(o.enabled ?? e.enabled) ? 'checked' : ''}> uygula</label>
        </div>`;
      }).join('')}` : ''}
    <div class="row gap end" style="margin-top:12px">
      <button value="cancel" class="secondary" formnovalidate>Vazgeç</button>
      <button value="ok">Kaydet</button>
    </div>`, (form, value) => {
    if (value !== 'ok') return;
    const f = form.elements;
    p.name = f.name.value.trim();
    if (!p.name) return;
    p.phone = f.phone.value.trim();
    p.aliases = f.aliases.value.split(',').map(s => s.trim()).filter(Boolean);
    p.prices = {};
    for (const c of state.categories) { const v = f['price_' + c.id]?.value ?? ''; if (v !== '') p.prices[c.id] = num(v); }
    p.expenses = {};
    for (const e of state.expenses) {
      const rate = f['exprate_' + e.id].value;
      const on = f['expon_' + e.id].checked;
      if (rate !== '' || on !== e.enabled) p.expenses[e.id] = { rate: rate === '' ? '' : num(rate), enabled: on };
    }
    if (isNew) state.people.push(p);
    save(); render();
    after && after(p);
  });
}

/* ---------- Ayarlar ---------- */

function renderSettings() {
  $('#catList').innerHTML = state.categories.map(c => `
    <div class="setrow" data-id="${c.id}">
      <input data-f="name" value="${esc(c.name)}" aria-label="Kategori adı">
      <input data-f="keys" value="${esc(c.keys ?? DEFAULT_KEYS[c.id] ?? c.name)}" aria-label="Ekran görüntüsündeki adları" title="Ekran görüntüsünde bu kategori hangi adlarla yazıyor (virgülle)">
      ${c.id === WEEKEND
        ? '<span class="muted small" style="grid-column: span 2">bonus baremle hesaplanır ↓</span>'
        : `<input data-f="price" type="number" step="0.01" inputmode="decimal" value="${c.price}" aria-label="Fiyat">
      <span class="muted small">₺ / paket</span>`}
      <button class="danger" data-del>Sil</button>
    </div>`).join('');
  $('#expList').innerHTML = state.expenses.map(e => `
    <div class="setrow exp" data-id="${e.id}">
      <input data-f="name" value="${esc(e.name)}" aria-label="Gider adı">
      <input data-f="rate" type="number" step="0.01" inputmode="decimal" value="${e.rate}" aria-label="Yüzde">
      <select data-f="mode" aria-label="Yön">
        <option value="deduct" ${e.mode !== 'add' ? 'selected' : ''}>% düş</option>
        <option value="add" ${e.mode === 'add' ? 'selected' : ''}>% ekle</option>
      </select>
      <label class="check"><input type="checkbox" data-f="enabled" ${e.enabled ? 'checked' : ''}> herkese</label>
      <button class="danger" data-del>Sil</button>
    </div>`).join('') || '<p class="muted small">Gider yok.</p>';
  $('#tierList').innerHTML = (state.weekendTiers || []).map((t, i) => `
    <div class="setrow tier" data-i="${i}">
      <input data-t="min" type="number" inputmode="numeric" value="${t.min}" aria-label="En az">
      <input data-t="max" type="number" inputmode="numeric" value="${t.max}" placeholder="üstü" aria-label="En çok">
      <input data-t="amount" type="number" inputmode="decimal" value="${t.amount}" aria-label="Bonus">
      <button class="danger" data-tdel>Sil</button>
    </div>`).join('');
  const active = document.activeElement;
  for (const id of ['company', 'footerNote', 'claudeKey', 'claudeModel', 'geminiKey', 'geminiModel']) {
    if (active !== $('#' + id)) $('#' + id).value = state[id] || '';
  }
  $('#claudeModel').placeholder = AI.claude.model;
  $('#geminiModel').placeholder = AI.gemini.model;
  $('#aiEngine').value = engine();
  for (const el of document.querySelectorAll('[data-engine]')) el.hidden = el.dataset.engine !== engine();
}

function bindList(sel, arr) {
  $(sel).addEventListener('change', e => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const item = state[arr].find(x => x.id === row.dataset.id);
    const f = e.target.dataset.f;
    item[f] = e.target.type === 'checkbox' ? e.target.checked : (f === 'price' || f === 'rate') ? num(e.target.value) : e.target.value;
    save(); renderPeriod();
  });
  $(sel).addEventListener('click', e => {
    if (!e.target.matches('[data-del]')) return;
    const id = e.target.closest('[data-id]').dataset.id;
    if (!confirm('Silinsin mi?')) return;
    state[arr] = state[arr].filter(x => x.id !== id);
    save(); render();
  });
}
bindList('#catList', 'categories');
$('#tierList').addEventListener('change', e => {
  const i = +e.target.closest('[data-i]').dataset.i;
  const f = e.target.dataset.t;
  state.weekendTiers[i][f] = f === 'max' && e.target.value === '' ? '' : num(e.target.value);
  state.weekendTiers.sort((a, b) => num(a.min) - num(b.min));
  save(); render();
});
$('#tierList').addEventListener('click', e => {
  if (!e.target.matches('[data-tdel]')) return;
  state.weekendTiers.splice(+e.target.closest('[data-i]').dataset.i, 1);
  save(); render();
});
$('#addTier').onclick = () => {
  const last = state.weekendTiers[state.weekendTiers.length - 1];
  state.weekendTiers.push({ min: last ? num(last.max || last.min) + 1 : 50, max: '', amount: 0 });
  save(); render();
};
bindList('#expList', 'expenses');
$('#addCat').onclick = () => { state.categories.push({ id: uid(), name: 'Yeni kategori', price: 0 }); save(); render(); };
$('#addExp').onclick = () => { state.expenses.push({ id: uid(), name: 'Gider', rate: 0, mode: 'deduct', enabled: true }); save(); render(); };
for (const id of ['company', 'footerNote', 'claudeKey', 'claudeModel', 'geminiKey', 'geminiModel', 'aiEngine']) {
  $('#' + id).onchange = e => { state[id] = e.target.value.trim(); save(); render(); };
}
$('#aiTest').onclick = async () => {
  if (engine() === 'ocr') { toast('OCR seçili'); return; }
  if (!aiReady()) { toast('Önce anahtarı gir'); return; }
  const btn = $('#aiTest');
  btn.disabled = true; btn.textContent = 'Deneniyor…';
  try {
    // Küçük bir test görüntüsü: tek kurye, bilinen sayılar
    const cv = document.createElement('canvas');
    cv.width = 420; cv.height = 150;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#111'; g.font = '20px Arial';
    g.fillText('Test Kurye', 16, 32);
    g.fillText(`${state.categories[0]?.name || 'Tekli'}: 7`, 16, 72);
    g.fillText(`${state.categories[1]?.name || 'Çiftli'}: 13`, 16, 108);
    const b64 = cv.toDataURL('image/jpeg', 0.92).split(',')[1];
    const text = engine() === 'gemini' ? await readWithGemini(b64) : await readWithClaude(b64);
    const f = parseAiJson(text)[0];
    const ok = f && f.counts[state.categories[0].id] === 7 && f.counts[state.categories[1].id] === 13;
    toast(ok ? 'Bağlantı tamam' : 'Bağlandı, sonuç farklı', 4000);
  } catch (e) {
    toast('Bağlantı hatası: ' + e.message, 8000);
  } finally {
    btn.disabled = false; btn.textContent = 'Bağlantıyı test et';
  }
};

$('#exportBtn').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  a.download = `kurye-fatura-yedek-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};
$('#importInput').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.people)) throw new Error('geçersiz dosya');
    if (!confirm('Mevcut veriler bu yedekle değiştirilsin mi?')) return;
    state = Object.assign(defaultState(), data);
    save(); render(); toast('Yedek yüklendi');
  } catch (err) { toast('Yüklenemedi: ' + err.message); }
  e.target.value = '';
};

/* ---------- Bulut (Supabase) ---------- */

async function pushCloud() {
  pushTimer = null;
  if (!sb || !user) return;
  const { error } = await sb.from('kurye_store').upsert({
    id: 'main', data: state, updated_at: new Date().toISOString(), updated_by: user.email,
  });
  if (error) { setSync('kayıt hatası!', error.message); toast('Kaydedilemedi: ' + error.message, 5000); return; }
  setSync('kaydedildi ' + new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }));
}

async function loadCloud() {
  setSync('yükleniyor…');
  const { data, error } = await sb.from('kurye_store').select('data').eq('id', 'main').maybeSingle();
  if (error) throw error;
  const cached = cacheLoad();
  const remote = data?.data;
  // Çevrimdışıyken yapılan ve buluta gitmemiş değişiklikler daha yeniyse onları koru
  if (!remote || (cached.updatedAt || 0) > (remote.updatedAt || 0)) {
    state = Object.assign(defaultState(), cached);
    if (cached.updatedAt || !remote) await pushCloud();
  } else {
    state = Object.assign(defaultState(), remote);
  }
  cacheSave();
  setSync('güncel');
}

// Diğer cihazda yapılan değişiklikleri sekmeye dönünce al
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && user && !pushTimer && !$('#modal').open && !pending.length) {
    loadCloud().then(render).catch(() => setSync('bağlantı yok'));
  }
});

/* ---------- Giriş ---------- */

function showAuth(msg = '') {
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#loginMsg').textContent = msg;
  $('#setupMsg').hidden = !!sb;
  $('#loginForm').hidden = !sb;
}

async function enterApp(session) {
  user = session.user;
  const { data: member, error } = await sb.from('kurye_members').select('email').limit(1);
  if (error || !member?.length) {
    await sb.auth.signOut();
    user = null;
    showAuth('Erişim izni yok.');
    return;
  }
  try {
    await loadCloud();
  } catch (e) {
    state = Object.assign(defaultState(), cacheLoad());
    setSync('çevrimdışı', e.message);
  }
  $('#auth').hidden = true;
  $('#app').hidden = false;
  render();
}

$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements;
  $('#loginBtn').disabled = true;
  $('#loginMsg').textContent = '';
  const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
  $('#loginBtn').disabled = false;
  if (error) { $('#loginMsg').textContent = error.message === 'Invalid login credentials' ? 'E-posta veya şifre hatalı.' : error.message; return; }
  f.password.value = '';
  enterApp(data.session);
};

$('#logoutBtn').onclick = async () => {
  if (pushTimer) { clearTimeout(pushTimer); await pushCloud(); }
  await sb.auth.signOut();
  user = null;
  state = defaultState();
  showAuth();
};

/* ---------- Ekran görüntüsü okuma ---------- */

const drop = $('#drop');
$('#shotInput').onchange = e => { handleFiles([...e.target.files]); e.target.value = ''; };
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleFiles([...e.dataTransfer.files]); });
document.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  showTab('yukle');
  handleFiles(files);
});

/* Ücretsiz okuma: Tesseract OCR tarayıcının içinde çalışır, görüntü hiçbir yere gönderilmez.
   İlk kullanımda Türkçe dil dosyası (~5 MB) indirilir, sonra önbellekten gelir. */

let ocrWorker = null;
let ocrLogger = null;
function getWorker(onProgress) {
  ocrLogger = onProgress;
  ocrWorker ??= Tesseract.createWorker('tur', 1, { logger: m => ocrLogger && ocrLogger(m) })
    .catch(e => { ocrWorker = null; throw e; });
  return ocrWorker;
}

/* OCR için görüntüyü hazırlar:
   - küçükse büyütür, griye çevirir, koyu temaysa tersine çevirir
   - bölgesel eşikleme: renkli hücrelerdeki yazı da (örn. kırmızı zemin) siyah-beyaz netleşir
   - Excel/tablo çizgilerini siler; çizgiler OCR'ın sayıları atlamasına yol açıyor */
function prepareImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.max(1, Math.min(3, 2000 / img.width));
      const cv = document.createElement('canvas');
      const W = cv.width = Math.round(img.width * scale);
      const H = cv.height = Math.round(img.height * scale);
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(img.src);
      const d = g.getImageData(0, 0, W, H);
      const px = d.data;
      const N = W * H;
      const lum = new Float32Array(N);
      let sum = 0;
      for (let i = 0; i < N; i++) {
        lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        sum += lum[i];
      }
      if (sum / N < 120) for (let i = 0; i < N; i++) lum[i] = 255 - lum[i];

      // Bölgesel eşik: piksel çevresinin ortalamasından belirgin koyuysa yazıdır
      const iw = W + 1;
      const integral = new Float64Array(iw * (H + 1));
      for (let y = 0; y < H; y++) {
        let row = 0;
        for (let x = 0; x < W; x++) {
          row += lum[y * W + x];
          integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1] + row;
        }
      }
      const R = 25, C = 12;
      const dark = new Uint8Array(N);
      for (let y = 0; y < H; y++) {
        const y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
        for (let x = 0; x < W; x++) {
          const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
          const s = integral[y1 * iw + x1] - integral[y0 * iw + x1] - integral[y1 * iw + x0] + integral[y0 * iw + x0];
          const mean = s / ((x1 - x0) * (y1 - y0));
          dark[y * W + x] = lum[y * W + x] < mean - C ? 1 : 0;
        }
      }

      // Uzun dikey ve yatay çizgileri sil (önce dikey: yatay çizgiler onları bölmeden)
      const minV = 140, minH = 160;
      for (let x = 0; x < W; x++) {
        for (let y = 0; y < H;) {
          if (!dark[y * W + x]) { y++; continue; }
          let e = y;
          while (e < H && dark[e * W + x]) e++;
          if (e - y >= minV) for (let k = y; k < e; k++) dark[k * W + x] = 2;
          y = e;
        }
      }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W;) {
          if (!dark[y * W + x]) { x++; continue; }
          let e = x;
          while (e < W && dark[y * W + e]) e++;
          if (e - x >= minH) for (let k = x; k < e; k++) dark[y * W + k] = 2;
          x = e;
        }
      }
      for (let i = 0; i < N; i++) {
        const v = dark[i] === 1 ? 0 : 255;
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
        px[i * 4 + 3] = 255;
      }
      g.putImageData(d, 0, 0);
      resolve(cv);
    };
    img.onerror = () => reject(new Error('görüntü açılamadı'));
    img.src = URL.createObjectURL(file);
  });
}

const DEFAULT_KEYS = {
  tekli: 'G10 İlk Sipariş Sayısı, ilk paket, ilk, tekli',
  ciftli: 'G10 Birleşen Sipariş Sayısı, birleşen, birlesen, çiftli',
  finans: 'Getir Finans Sipariş Sayısı, finans',
  carsi: 'Çarşı Sipariş Sayısı, çarşı, carsi',
  yemek: 'Yemek Sipariş Sayısı, yemek',
  haftasonu: 'Haftasonu Sipariş Sayısı, hafta sonu, haftasonu',
};
const catKeys = c => String(c.keys ?? DEFAULT_KEYS[c.id] ?? c.name)
  .split(',').map(norm).filter(Boolean).sort((a, b) => b.length - a.length);

// Bir satırdaki adetleri bulur; para tutarlarını (₺, TL, kuruşlu) atlar.
function lineNumbers(line) {
  const out = [];
  const re = /(₺\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(,\d{1,2})?(\s*(?:₺|tl\b))?/gi;
  let m;
  while ((m = re.exec(line))) {
    if (m[1] || m[3] || m[4]) continue;
    out.push({ value: parseInt(m[2].replace(/\./g, ''), 10), index: m.index });
  }
  return out;
}

// Metinde geçen ilk kategoriyi bulur
function findCategory(textNorm) {
  let best = null;
  for (const c of state.categories) {
    for (const k of catKeys(c)) {
      const i = textNorm.indexOf(k);
      if (i >= 0) {
        if (!best || i < best.index) best = { cat: c, index: i, key: k };
        break;
      }
    }
  }
  return best;
}

function looksLikeName(line) {
  const words = line.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(w => w.length > 1);
  if (words.length < 2 || words.length > 4 || /\d/.test(line)) return false;
  if (findCategory(norm(line))) return false;
  return words.every(w => w[0] === w[0].toLocaleUpperCase('tr'));
}

function detectName(lines) {
  // Önce kayıtlı kişilerden biri metinde geçiyor mu bak
  let best = null, score = 0;
  for (const l of lines) {
    const t = l.replace(/[\d:|]/g, ' ').trim();
    for (const p of state.people) {
      for (const cand of [p.name, ...(p.aliases || [])]) {
        const s = norm(t).includes(norm(cand)) ? 1 : similarity(t, cand);
        if (s > score) { score = s; best = p.name; }
      }
    }
  }
  if (score >= 0.72) return best;
  return lines.find(looksLikeName)?.replace(/\s+/g, ' ').trim() || '';
}

function parseOcr(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const emptyCounts = () => Object.fromEntries(state.categories.map(c => [c.id, 0]));

  // Tablo düzeni: başlık satırında kategoriler yan yana, altında "Ad Soyad 12 3 4 ..."
  const header = lines.find(l => {
    const n = norm(l);
    return state.categories.filter(c => catKeys(c).some(k => n.includes(k))).length >= 2;
  });
  const rows = lines.filter(l => {
    const words = l.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(w => w.length > 1);
    return lineNumbers(l).length >= 2 && words.length >= 2 && !findCategory(norm(l));
  });
  if (rows.length && (header || rows.length >= 2)) {
    let order = state.categories;
    if (header) {
      const n = norm(header);
      order = state.categories
        .map(c => ({ c, i: Math.min(...catKeys(c).map(k => { const i = n.indexOf(k); return i < 0 ? Infinity : i; })) }))
        .filter(x => x.i < Infinity).sort((a, b) => a.i - b.i).map(x => x.c);
    }
    return rows.map(l => {
      let nums = lineNumbers(l).map(x => x.value);
      // Fazla sayı varsa: sondaki toplamı ya da baştaki sıra numarasını at
      if (nums.length > order.length) {
        const sumHead = nums.slice(0, -1).reduce((a, b) => a + b, 0);
        if (nums.length === order.length + 1 && nums[nums.length - 1] === sumHead) nums = nums.slice(0, -1);
        else nums = nums.slice(nums.length - order.length);
      }
      const counts = emptyCounts();
      order.forEach((c, i) => { counts[c.id] = nums[i] ?? 0; });
      const name = l.replace(/[^\p{L}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
      return { name, counts };
    });
  }

  // Kart düzeni: tek kişi; "İlk Paket: 120", "Birleşen Paket  30" gibi satırlar
  const counts = emptyCounts();
  let foundAny = false;
  lines.forEach((l, i) => {
    const hit = findCategory(norm(l));
    if (!hit || counts[hit.cat.id]) return;
    // Kategori adından sonraki ilk sayı; yoksa alt satırdaki ilk sayı
    const after = lineNumbers(l).filter(x => norm(l.slice(0, x.index)).length >= hit.index + hit.key.length);
    const next = lines[i + 1] || '';
    const val = after[0]?.value ?? (findCategory(norm(next)) ? undefined : lineNumbers(next)[0]?.value);
    if (val != null) { counts[hit.cat.id] = val; foundAny = true; }
  });
  if (!foundAny) return [];
  return [{ name: detectName(lines), counts }];
}

/* Konuma dayalı okuma: sayıları ekrandaki yerine göre sütunlara/etiketlere bağlar.
   Okunamayan hücre (genelde tek haneli sayılar) sadece rakam modunda yeniden okunur. */

const wordValue = t => {
  if (/^[-–—_.]+$/.test(t)) return null;
  const n = lineNumbers(t);
  return n.length === 1 && t.replace(/[^\d]/g, '').length >= String(n[0].value).length ? n[0].value : null;
};

async function readDigits(worker, canvas, box) {
  // Hücredeki koyu piksellerin sınırını bul, rakamı sıkı kırpıp büyüt (tek haneliler için önemli)
  const bx0 = Math.max(0, box.x0), by0 = Math.max(0, box.y0);
  const bw = Math.min(canvas.width, box.x1) - bx0, bh = Math.min(canvas.height, box.y1) - by0;
  if (bw < 2 || bh < 2) return null;
  const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(bx0, by0, bw, bh).data;
  let x0 = bw, y0 = bh, x1 = -1, y1 = -1;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (px[(y * bw + x) * 4] < 140) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null; // hücre boş
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const scale = Math.max(1, 64 / h);
  const pad = Math.round(32 * scale / 2);
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * scale) + pad * 2; cv.height = Math.round(h * scale) + pad * 2;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, bx0 + x0, by0 + y0, w, h, pad, pad, Math.round(w * scale), Math.round(h * scale));
  const { data } = await worker.recognize(cv);
  const digits = data.text.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : null;
}

// Kategori anahtarının satırdaki kelime aralığını bulur ("ilk paket" iki kelime olabilir)
function findKeyWords(words, cat) {
  const wn = words.map(w => norm(w.t));
  for (const key of catKeys(cat)) {
    const toks = key.split(' ');
    for (let i = 0; i + toks.length <= wn.length; i++) {
      if (toks.every((t, j) => wn[i + j] === t || (t.length >= 4 && wn[i + j].startsWith(t)))) {
        return { first: words[i], last: words[i + toks.length - 1], end: i + toks.length };
      }
    }
  }
  return null;
}

async function parseLayout(data, canvas, worker) {
  const lines = (data.lines || []).map(l => ({
    text: l.text.trim(),
    y0: l.bbox.y0, y1: l.bbox.y1,
    words: l.words.map(w => ({ t: w.text, ...w.bbox, cx: (w.bbox.x0 + w.bbox.x1) / 2 })),
  })).filter(l => l.words.length);
  const emptyCounts = () => Object.fromEntries(state.categories.map(c => [c.id, 0]));
  const fixes = []; // rakam modunda yeniden okunacak hücreler

  // Tablo: kategorilerin en az ikisi aynı başlık satırında
  const header = lines.find(l => state.categories.filter(c => findKeyWords(l.words, c)).length >= 2);
  if (header) {
    const cols = state.categories.map(c => {
      const k = findKeyWords(header.words, c);
      return k && { cat: c, x0: k.first.x0, x1: k.last.x1, cx: (k.first.x0 + k.last.x1) / 2 };
    }).filter(Boolean).sort((a, b) => a.cx - b.cx);
    cols.forEach((c, i) => {
      c.lo = i ? (cols[i - 1].cx + c.cx) / 2 : c.x0 - (c.x1 - c.x0);
      c.hi = i < cols.length - 1 ? (c.cx + cols[i + 1].cx) / 2 : c.x1 + (c.x1 - c.x0) + 40;
    });
    const nameEdge = cols[0].lo;
    const out = [];
    for (const l of lines) {
      if (l.y0 <= header.y0) continue;
      const nameWords = l.words.filter(w => w.cx < nameEdge && /\p{L}{2,}/u.test(w.t));
      if (!nameWords.length) continue;
      const counts = emptyCounts();
      for (const c of cols) {
        const w = l.words.find(w => w.cx >= c.lo && w.cx < c.hi && wordValue(w.t) != null);
        if (w) { counts[c.cat.id] = wordValue(w.t); verifySmall(fixes, counts, c.cat.id, w); }
        else fixes.push({ counts, id: c.cat.id, box: { x0: Math.round(c.lo), x1: Math.round(c.hi), y0: l.y0 - 6, y1: l.y1 + 6 } });
      }
      const name = nameWords.map(w => w.t).join(' ').replace(/[^\p{L}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
      out.push({ name, counts });
    }
    await applyFixes(fixes, worker, canvas);
    return out;
  }

  // Kart: "İlk Paket ..... 120" gibi etiket satırları
  const counts = emptyCounts();
  let foundAny = false;
  lines.forEach((l, i) => {
    for (const c of state.categories) {
      const k = findKeyWords(l.words, c);
      if (!k || counts[c.id]) continue;
      foundAny = true;
      // Aynı hizadaki sayı: OCR sağdaki hücreyi ayrı satır sayabilir, o yüzden tüm kelimelere bak
      const mid = (l.y0 + l.y1) / 2;
      const w = l.words.slice(k.end).find(w => wordValue(w.t) != null) || lines
        .flatMap(x => x.words)
        .filter(w => w.x0 > k.last.x1 && w.y0 < mid && w.y1 > mid && wordValue(w.t) != null)
        .sort((a, b) => a.x0 - b.x0)[0];
      if (w) { counts[c.id] = wordValue(w.t); verifySmall(fixes, counts, c.id, w); return; }
      const next = lines[i + 1];
      const nextVal = next && !state.categories.some(cc => findKeyWords(next.words, cc))
        ? next.words.map(w => wordValue(w.t)).find(v => v != null) : null;
      fixes.push({
        counts, id: c.id, fallback: nextVal,
        box: { x0: k.last.x1 + 8, x1: canvas.width, y0: l.y0 - 6, y1: l.y1 + 6 },
      });
      return;
    }
  });
  if (!foundAny) return [];
  await applyFixes(fixes, worker, canvas);
  return [{ name: detectName(lines.map(l => l.text)), counts }];
}

// Tek haneli sayılar ana okumada sık karışır (7↔1, 4↔-): rakam modunda tekrar oku
function verifySmall(fixes, counts, id, w) {
  if (counts[id] < 10) fixes.push({ counts, id, fallback: counts[id], box: { x0: w.x0 - 6, x1: w.x1 + 6, y0: w.y0 - 6, y1: w.y1 + 6 } });
}

async function applyFixes(fixes, worker, canvas) {
  if (!fixes.length) return;
  await worker.setParameters({ tessedit_pageseg_mode: '8', tessedit_char_whitelist: '0123456789' });
  try {
    for (const f of fixes) {
      const v = await readDigits(worker, canvas, f.box);
      f.counts[f.id] = v ?? f.fallback ?? 0;
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
  }
}

async function readWithOcr(file, onProgress) {
  if (!window.Tesseract) throw new Error('OCR modülü yüklenemedi, internet bağlantını kontrol et');
  const canvas = await prepareImage(file);
  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
  let found = await parseLayout(data, canvas, worker);
  if (!found.length) found = parseOcr(data.text);
  return { found, text: data.text };
}

/* ---------- Yapay zekâ ile okuma (Claude / Gemini) ---------- */

const AI = {
  claude: { label: 'Claude', keyField: 'claudeKey', modelField: 'claudeModel', model: 'claude-sonnet-5-5' },
  gemini: { label: 'Gemini', keyField: 'geminiKey', modelField: 'geminiModel', model: 'gemini-3.6-flash' },
};
const engine = () => {
  const sel = state.aiEngine || 'gemini';
  if (sel === 'ocr' || state[AI[sel]?.keyField]) return sel;
  return Object.keys(AI).find(k => state[AI[k].keyField]) || sel;
};
const aiReady = () => AI[engine()] && !!state[AI[engine()].keyField];

// Görüntüyü yapay zekâya göndermek için JPEG'e çevirir (küçük rakamlar bozulmasın diye yüksek kalite)
function imageToBase64(file, max = 2000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      const g = cv.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
      g.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      resolve(cv.toDataURL('image/jpeg', 0.92).split(',')[1]);
    };
    img.onerror = () => reject(new Error('görüntü açılamadı'));
    img.src = URL.createObjectURL(file);
  });
}

function aiPrompt() {
  const cats = state.categories.map(c => `- "${c.id}" (${c.name}): şu sütun/etiketten al → ${c.keys ?? DEFAULT_KEYS[c.id] ?? c.name}`).join('\n');
  const people = state.people.map(p => p.name).join(', ');
  return `Bu görüntü bir kurye yönetim panelinin ekranı (çoğu zaman telefonla ekrandan çekilmiş, eğik ya da bulanık olabilir).
Genelde bir tablodur: her satır bir kurye, ilk sütun "Ad", diğer sütunlar sayılardır. Sütun başlıkları birkaç satıra bölünmüş olabilir, örneğin:
Ad | G10 İlk Sipariş Sayısı | G10 Birleşen Sipariş Sayısı | Mor Saatler G10 Sipariş Sayısı | G10 Mesafe KM | GB İlk Sipariş Sayısı | GB Birleşen Sipariş Sayısı | Mor Saatler GB Sipariş Sayısı | GB Mesafe KM | GB 30-50 KG Sipariş Sayısı | GB 50+ KG Sipariş Sayısı | Yemek Sipariş Sayısı | Kuzeyden Sipariş Sayısı | Damacana Sayısı | Çarşı Sipariş Sayısı | Getir Finans Sipariş Sayısı | Haftasonu Sipariş Sayısı
Bazen de tek kurye için "İLK PAKET 658", "BİRLEŞEN 307" gibi etiket–değer satırları olur.

Görüntüdeki HER kurye satırı için adı ve aşağıdaki değerleri çıkar:
${cats}

Kurallar:
- Önce başlıkları oku ve her sütunun yerini belirle; sonra her satırdaki sayıyı DOĞRU SÜTUNDAN al. Sütunları kaydırma.
- Yukarıda istenmeyen sütunları (Mesafe KM, Mor Saatler, GB, Kuzeyden, Damacana vb.) YOK SAY.
- Sadece adet yaz. Ondalıklı KM değerlerini ve para tutarlarını kullanma. Görüntüde olmayan değer için 0 yaz.
- Rakamları dikkatle oku; 1–7, 3–8, 0–6–9 karışmasın. Emin olmadığın satırda yine en olası değeri yaz.
- İsmi tam ve Türkçe karakterleriyle yaz (ö, ü, ş, ç, ğ, ı, İ).${people ? `\n- Kayıtlı kuryeler: ${people}. Görüntüdeki isim bunlardan birine benziyorsa aynen bu yazılışı kullan; değilse görüntüdeki gibi yaz.` : ''}
- Tablo kaydırılmış/yarım görünen satırları da al. Görüntüde kurye yoksa "couriers" boş liste olsun.

Sadece şu biçimde geçerli JSON döndür, başka hiçbir şey yazma:
{"couriers":[{"name":"Ad Soyad","counts":{${state.categories.map(c => `"${c.id}":0`).join(',')}}}]}`;
}

function parseAiJson(text) {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!json) throw new Error('yapay zekâ cevabı anlaşılamadı');
  const parsed = JSON.parse(json);
  return (parsed.couriers || []).map(c => ({
    name: String(c.name || '').trim(),
    counts: Object.fromEntries(state.categories.map(cat => [cat.id, Math.max(0, Math.round(num(c.counts?.[cat.id])))])),
  }));
}

async function readWithClaude(b64) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': state.claudeKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: state.claudeModel || AI.claude.model,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: aiPrompt() },
        ],
      }],
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Claude: ' + (body.error?.message || r.status));
  return (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// Tablo okumak için "düşünme" gereksiz ve yavaşlatıyor: modelin izin verdiği en düşük seviyeye çek
function geminiThinking(model) {
  if (/gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/gemini-2\.5-pro/.test(model)) return { thinkingBudget: 128 };
  if (/gemini-[3-9]/.test(model)) return { thinkingLevel: 'low' };
  return null;
}

const GEMINI_TIMEOUT = 30000;
async function geminiCall(model, b64) {
  const thinkingConfig = geminiThinking(model);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT);
  try {
    return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': state.geminiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: aiPrompt() }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', ...(thinkingConfig && { thinkingConfig }) },
      }),
    });
  } catch (e) {
    // Süre aşımı yoğunluk gibi ele alınır: sıradaki modele geçilir
    if (e.name === 'AbortError') return new Response(JSON.stringify({ error: { message: `${model} ${GEMINI_TIMEOUT / 1000} sn içinde cevap vermedi` } }), { status: 504 });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Hesabın erişebildiği Gemini modelleri: en yeni "flash" önce, sonra "flash-lite", sonra "pro"
let geminiModelsCache = null;
async function geminiModels() {
  if (geminiModelsCache) return geminiModelsCache;
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
    headers: { 'x-goog-api-key': state.geminiKey },
  });
  const body = await r.json().catch(() => ({}));
  const names = (body.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /^gemini-/.test(n) && /flash|pro/.test(n) && !/tts|image|audio|live|exp|preview|thinking|embedding/.test(n));
  const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const rank = n => (/lite/.test(n) ? 1 : /flash/.test(n) ? 0 : 2);
  geminiModelsCache = names.sort((a, b) => rank(a) - rank(b) || ver(b) - ver(a) || a.length - b.length);
  return geminiModelsCache;
}

async function readWithGemini(b64, onStatus = () => {}) {
  const first = state.geminiModel || AI.gemini.model;
  const tried = new Set();
  let lastError = '';
  // Yoğun ya da kaldırılmış modelde beklemeden sıradakine geçilir (ölçüm: yoğun model 2–10 sn kaybettiriyor)
  const tryModel = async model => {
    tried.add(model);
    const r = await geminiCall(model, b64);
    if (r.ok) return r;
    const body = await r.json().catch(() => ({}));
    lastError = body.error?.message || String(r.status);
    if (r.status === 400 || r.status === 401 || r.status === 403) throw new Error('Gemini: ' + lastError);
    return null;
  };

  let r = await tryModel(first);
  if (!r) {
    const alternatives = (await geminiModels().catch(() => [])).filter(m => !tried.has(m)).slice(0, 6);
    for (const model of alternatives) {
      onStatus(`Gemini yoğun, ${model} deneniyor…`);
      r = await tryModel(model);
      if (r) {
        // Çalışan modeli hatırla; yoğunluk geçince Ayarlar'dan değiştirilebilir
        if (model !== first) { state.geminiModel = model; save(); }
        break;
      }
    }
  }
  if (!r) throw new Error('Gemini: ' + (lastError || 'yanıt alınamadı') + ' — birkaç dakika sonra tekrar dene');
  const body = await r.json().catch(() => ({}));
  return (body.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

async function readScreenshot(file, onProgress) {
  if (engine() !== 'ocr' && aiReady()) {
    onProgress({ status: 'ai' });
    const b64 = await imageToBase64(file);
    const text = engine() === 'gemini'
      ? await readWithGemini(b64, msg => onProgress({ status: 'ai', msg }))
      : await readWithClaude(b64);
    return { found: parseAiJson(text), text, via: AI[engine()].label };
  }
  return { ...(await readWithOcr(file, onProgress)), via: 'OCR' };
}

let pending = []; // { name, counts, personId }
let ocrQueue = Promise.resolve();

function handleFiles(files) {
  files = files.filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  if (engine() !== 'ocr' && !aiReady()) {
    toast('Okuma anahtarı yok', 3000);
  }
  const queue = $('#shotQueue');
  for (const file of files) {
    const imgUrl = URL.createObjectURL(file);
    const item = document.createElement('div');
    item.className = 'qitem';
    item.innerHTML = `<img alt=""><div class="qbody"><span class="st">Sırada…</span></div>`;
    item.querySelector('img').src = imgUrl;
    queue.prepend(item);
    const st = item.querySelector('.st');
    // Görüntüler sırayla okunur
    ocrQueue = ocrQueue.then(async () => {
      const t0 = Date.now();
      let label = '';
      const tick = setInterval(() => { if (label) st.textContent = `${label} ${Math.round((Date.now() - t0) / 1000)} sn`; }, 500);
      try {
        const { found, text, via } = await readScreenshot(file, m => {
          if (m.status === 'ai') st.textContent = label = 'Okunuyor…';
          else if (m.status === 'recognizing text') st.textContent = `Okunuyor… %${Math.round(m.progress * 100)}`;
          else st.textContent = 'Okunuyor…';
        });
        clearInterval(tick);
        const took = `${Math.round((Date.now() - t0) / 1000)} sn`;
        st.textContent = found.length ? `${found.length} kişi · ${took}` : 'Okunamadı';
        for (const f of found) {
          const p = f.name ? matchPerson(f.name) : null;
          // Aynı kişi birden fazla görüntüde varsa topla
          const same = pending.find(x => (p && x.personId === p.id) || (f.name && norm(x.name) === norm(f.name)));
          if (same) { same.counts = f.counts; same.img = imgUrl; }
          else pending.push({ key: uid(), name: f.name || 'İsim okunamadı', counts: f.counts, personId: p?.id || '', img: imgUrl, auto: via !== 'OCR' });
        }
      } catch (err) {
        clearInterval(tick);
        st.innerHTML = `<span class="err">Okunamadı: ${esc(err.message || err)}</span>`;
      }
      renderReview();
    });
  }
}

function renderReview() {
  $('#review').hidden = !pending.length;
  const opts = sel => `<option value="">— eşleşmedi —</option>` +
    [...state.people].sort((a, b) => a.name.localeCompare(b.name, 'tr'))
      .map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#reviewRows').innerHTML = pending.map(r => `
    <div class="rrow ${r.personId ? '' : r.auto ? 'newperson' : 'unmatched'}" data-key="${r.key}">
      <div class="row gap">
        ${r.img ? `<img class="rthumb" src="${r.img}" alt="Ekran görüntüsü" data-f="zoom" title="Büyüt">` : ''}
        <strong style="flex:1 1 140px">${esc(r.name)}</strong>
        <select data-f="person" style="flex:1 1 180px;width:auto">${opts(r.personId)}</select>
        ${r.personId ? '' : r.auto ? '<span class="badge new">yeni</span>' : '<span class="badge warn">eşleşmedi</span>'}
        <button class="danger" data-f="drop" title="Bu satırı atla">✕</button>
      </div>
      <div class="grid-counts">
        ${state.categories.map(c => `<label>${esc(c.name)}<input type="number" min="0" inputmode="numeric" data-c="${c.id}" value="${r.counts[c.id]}"></label>`).join('')}
      </div>
    </div>`).join('');
}
$('#reviewRows').addEventListener('change', e => {
  const row = pending.find(r => r.key === e.target.closest('[data-key]').dataset.key);
  if (e.target.dataset.c) row.counts[e.target.dataset.c] = num(e.target.value);
  if (e.target.dataset.f === 'person') { row.personId = e.target.value; renderReview(); }
});
$('#reviewRows').addEventListener('click', e => {
  const f = e.target.dataset.f;
  if (f === 'zoom') { openModal(`<img src="${e.target.src}" alt="Ekran görüntüsü"><div class="row end" style="margin-top:12px"><button value="close">Kapat</button></div>`); return; }
  if (!f || e.target.tagName !== 'BUTTON') return;
  const row = pending.find(r => r.key === e.target.closest('[data-key]').dataset.key);
  if (f === 'drop') { pending = pending.filter(r => r !== row); renderReview(); }
});
$('#reviewCancel').onclick = () => { pending = []; renderReview(); };
$('#reviewSave').onclick = () => {
  const add = $('#addMode').checked;
  let n = 0, created = 0;
  for (const r of pending) {
    if (!r.personId) {
      const name = r.name.trim();
      if (!r.auto || !name || name === 'İsim okunamadı') continue;
      const existing = matchPerson(name);
      if (existing) r.personId = existing.id;
      else {
        const np = { id: uid(), name: titleCase(name), phone: '', prices: {}, expenses: {}, aliases: [] };
        state.people.push(np);
        r.personId = np.id;
        created++;
      }
    }
    const p = personById(r.personId);
    // Ekran görüntüsündeki farklı yazılışı hatırla, bir dahaki sefere otomatik eşleşsin
    if (norm(r.name) !== norm(p.name) && !(p.aliases || []).some(a => norm(a) === norm(r.name))) {
      (p.aliases ??= []).push(r.name);
    }
    setRecord(r.personId, r.counts, add);
    n++;
  }
  pending = [];
  save();
  $('#shotQueue').innerHTML = '';
  toast(`${n} kişi kaydedildi` + (created ? ` · ${created} yeni kişi` : ''), 3000);
  showTab(created ? 'kisiler' : 'donem');
};

/* ---------- Fatura görseli ---------- */

function renderInvoice(pid) {
  const p = personById(pid);
  const c = calc(p, record(pid));
  const W = 1080, P = 64, rowH = 64;
  const rows = c.lines.filter(l => l.count);
  const H = 360 + rows.length * rowH + 90 + c.expenses.length * 56 + 190 + (state.footerNote ? 70 : 0);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const font = (w, s) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const right = (t, x, y) => { g.textAlign = 'right'; g.fillText(t, x, y); g.textAlign = 'left'; };

  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0f766e'; g.fillRect(0, 0, W, 150);
  g.fillStyle = '#ffffff';
  g.font = font(700, 44); g.fillText(state.company || 'Paket Hakediş Özeti', P, 78);
  g.font = font(500, 28); g.fillText(`${periodLabel(currentPeriod())} dönemi`, P, 122);

  let y = 220;
  g.fillStyle = '#16201f'; g.font = font(700, 40); g.fillText(p.name, P, y);
  y += 70;
  g.fillStyle = '#5d6b69'; g.font = font(600, 24);
  g.fillText('PAKET', P, y); right('ADET', 560, y); right('BİRİM', 780, y); right('TUTAR', W - P, y);
  y += 18;
  g.fillStyle = '#dde3e2'; g.fillRect(P, y, W - 2 * P, 2);

  for (const l of rows) {
    y += rowH - 14;
    g.fillStyle = '#16201f'; g.font = font(500, 30);
    g.fillText(l.name, P, y);
    right(String(l.count), 560, y);
    if (!l.bonus) right(money(l.price), 780, y);
    g.font = font(600, 30); right(money(l.amount), W - P, y);
    y += 14;
    g.fillStyle = '#eef1f1'; g.fillRect(P, y, W - 2 * P, 1);
  }

  y += 70;
  g.fillStyle = '#16201f'; g.font = font(700, 32);
  g.fillText(`Toplam (${c.packages} paket)`, P, y); right(money(c.gross), W - P, y);

  for (const e of c.expenses) {
    y += 56;
    g.fillStyle = e.mode === 'add' ? '#15803d' : '#b42318'; g.font = font(500, 28);
    g.fillText(`${e.name} (%${e.rate.toLocaleString('tr-TR')})`, P, y);
    right((e.mode === 'add' ? '+ ' : '− ') + money(e.amount), W - P, y);
  }

  y += 50;
  g.fillStyle = '#e6f4f1'; g.fillRect(P - 20, y, W - 2 * P + 40, 110);
  g.fillStyle = '#0f766e'; g.font = font(700, 30); g.fillText('KESİLECEK FATURA', P, y + 68);
  g.font = font(800, 46); right(money(c.net), W - P, y + 72);
  y += 110;

  if (state.footerNote) {
    y += 56;
    g.fillStyle = '#5d6b69'; g.font = font(400, 26); g.fillText(state.footerNote, P, y);
  }
  return new Promise(res => cv.toBlob(res, 'image/png'));
}

function invoiceText(pid) {
  const p = personById(pid);
  const c = calc(p, record(pid));
  const lines = [`*${p.name}* — ${periodLabel(currentPeriod())}`, ''];
  for (const l of c.lines.filter(l => l.count)) {
    lines.push(l.bonus ? `${l.name}: ${money(l.amount)}` : `${l.name}: ${l.count} × ${money(l.price)} = ${money(l.amount)}`);
  }
  lines.push('', `Toplam: ${money(c.gross)}`);
  for (const e of c.expenses) lines.push(`${e.name} %${e.rate}: ${e.mode === 'add' ? '+' : '−'}${money(e.amount)}`);
  lines.push(`*Kesilecek fatura: ${money(c.net)}*`);
  if (state.footerNote) lines.push('', state.footerNote);
  return lines.join('\n');
}

const fileName = pid => `fatura-${norm(personById(pid).name).replace(/ /g, '-')}-${currentPeriod()}.png`;

async function previewInvoice(pid) {
  const blob = await renderInvoice(pid);
  const url = URL.createObjectURL(blob);
  openModal(`
    <img src="${url}" alt="Fatura görseli">
    <div class="row gap end" style="margin-top:12px">
      <button type="button" class="secondary" data-x="dl">İndir</button>
      <button type="button" class="secondary" data-x="copy">Metni kopyala</button>
      <button value="close">Kapat</button>
    </div>`, () => URL.revokeObjectURL(url), {
    dl: () => { const a = document.createElement('a'); a.href = url; a.download = fileName(pid); a.click(); },
    copy: () => navigator.clipboard.writeText(invoiceText(pid)).then(() => toast('Metin kopyalandı')),
  });
}

const isTouch = () => matchMedia('(pointer: coarse)').matches;

// Bilgisayarda tek bir WhatsApp Web sekmesi kullanılır; her kişide aynı sekme o sohbete gider
function openChat(phone) {
  const url = isTouch() ? `https://wa.me/${phone}` : `https://web.whatsapp.com/send?phone=${phone}`;
  window.open(url, 'kuryeWhatsApp');
}

async function sendWhatsApp(pid) {
  const p = personById(pid);
  const phone = waNumber(p.phone);
  const blobPromise = renderInvoice(pid);

  // Telefon: paylaşım menüsünden WhatsApp → kişi
  if (isTouch() && navigator.canShare) {
    const file = new File([await blobPromise], fileName(pid), { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        markSent(pid);
      } catch (e) { if (e.name !== 'AbortError') toast('Paylaşılamadı: ' + e.message); }
      return;
    }
  }

  // Bilgisayar: görsel panoya, sohbet açılır → Ctrl+V, Enter
  let copied = false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
    copied = true;
  } catch {
    downloadBlob(await blobPromise, fileName(pid));
  }
  if (!phone) { toast(`${p.name}: numara yok`); return; }
  openChat(phone);
  toast(copied ? 'Kopyalandı — Ctrl+V, Enter' : 'İndirildi', 3000);
  markSent(pid);
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function markSent(pid) {
  const rec = record(pid);
  if (rec) { rec.sentAt = Date.now(); save(); renderPeriod(); }
}

const peopleWithRecords = () => {
  const recs = state.records[currentPeriod()] || {};
  return state.people.filter(p => recs[p.id]).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
};

// Hepsini indir: bilgisayarda tek ZIP, telefonda paylaşım menüsünden "Kaydet"
$('#saveAll').onclick = async () => {
  const list = peopleWithRecords();
  if (!list.length) { toast('Bu ay kayıt yok'); return; }
  const btn = $('#saveAll');
  btn.disabled = true;
  try {
    const files = [];
    for (const p of list) files.push(new File([await renderInvoice(p.id)], `${p.name} - ${periodLabel(currentPeriod())}.png`, { type: 'image/png' }));
    if (isTouch() && navigator.canShare?.({ files })) {
      try { await navigator.share({ files }); } catch (e) { if (e.name !== 'AbortError') throw e; }
    } else if (window.JSZip) {
      const zip = new JSZip();
      for (const f of files) zip.file(f.name, f);
      downloadBlob(await zip.generateAsync({ type: 'blob' }), `Faturalar - ${periodLabel(currentPeriod())}.zip`);
    } else {
      for (const f of files) downloadBlob(f, f.name);
    }
  } catch (e) {
    toast('İndirilemedi: ' + e.message);
  } finally {
    btn.disabled = false;
  }
};

// Gönderim listesi: herkes tek ekranda; Enter sıradakini gönderir
$('#bulkSend').onclick = () => {
  const list = peopleWithRecords();
  if (!list.length) { toast('Bu ay kayıt yok'); return; }
  const recs = state.records[currentPeriod()];
  const rows = () => list.map(p => {
    const sent = !!recs[p.id]?.sentAt;
    return `<div class="sendrow ${sent ? 'done' : ''}" data-id="${p.id}">
      <span class="avatar">${esc(initials(p.name))}</span>
      <div class="sname"><b>${esc(p.name)}</b><span>${money(calc(p, recs[p.id]).net)}${p.phone ? '' : ' · numara yok'}</span></div>
      <button type="button" class="${sent ? 'secondary' : 'wa'}" data-x="send">${sent ? '✓' : 'Gönder'}</button>
    </div>`;
  }).join('');
  const nextId = () => list.find(p => !recs[p.id]?.sentAt && p.phone)?.id;
  const draw = () => {
    $('#sendRows').innerHTML = rows();
    const n = nextId();
    $('#sendRows').querySelector(`[data-id="${n}"]`)?.classList.add('next');
    $('#sendCount').textContent = `${list.filter(p => recs[p.id]?.sentAt).length} / ${list.length}`;
  };
  const send = async id => { if (!id) return; await sendWhatsApp(id); draw(); };
  const onKey = e => {
    if (e.key === 'Enter' && $('#modal').open && $('#sendRows')) { e.preventDefault(); send(nextId()); }
  };
  openModal(`
    <div class="row" style="justify-content:space-between"><h2>Gönder</h2><span class="badge" id="sendCount"></span></div>
    <div id="sendRows" class="sendlist"></div>
    <div class="row gap end" style="margin-top:12px">
      <button type="button" class="secondary" data-x="reset">Sıfırla</button>
      <button value="close">Kapat</button>
    </div>`, () => document.removeEventListener('keydown', onKey), {
    send: e => send(e.target.closest('[data-id]').dataset.id),
    reset: () => { for (const p of list) delete recs[p.id].sentAt; save(); renderPeriod(); draw(); },
  });
  document.addEventListener('keydown', onKey);
  draw();
};

/* ---------- Başlat ---------- */

(async () => {
  if (!sb) { showAuth(); return; }
  const { data } = await sb.auth.getSession();
  if (data.session) enterApp(data.session);
  else showAuth();
})();
