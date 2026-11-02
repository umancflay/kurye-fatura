'use strict';

/* ---------- Durum ve saklama ---------- */

const STORE_KEY = 'kuryeFatura.v1'; // çevrimdışı önbellek; asıl kayıt Supabase'te
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const CFG = window.KURYE_CONFIG || {};
const sb = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey)
  : null;

const uid = () => Math.random().toString(36).slice(2, 10);

function defaultState() {
  return {
    categories: [
      { id: 'tekli', name: 'Tekli (İlk paket)', price: 0 },
      { id: 'ciftli', name: 'Çiftli (Birleşen)', price: 0 },
      { id: 'finans', name: 'Finans', price: 0 },
      { id: 'carsi', name: 'Çarşı', price: 0 },
      { id: 'yemek', name: 'Yemek', price: 0 },
    ],
    expenses: [],
    people: [],
    records: {},
    company: '',
    footerNote: 'Lütfen bu tutara fatura kesiniz.',
    apiKey: '',
    model: DEFAULT_MODEL,
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

function calc(person, rec) {
  const lines = state.categories.map(c => {
    const count = num(rec?.counts?.[c.id]);
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
  const packages = lines.reduce((s, l) => s + l.count, 0);
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

function render() {
  renderPeriod();
  renderPeople();
  renderSettings();
  $('#reviewPeriod').textContent = periodLabel(currentPeriod());
  $('#aiHint').textContent = state.apiKey
    ? 'Görüntüdeki isimler ve paket sayıları otomatik okunur, kişilerle eşleştirilir.'
    : 'Önce Ayarlar → “Ekran görüntüsü okuma” bölümüne Claude API anahtarını gir.';
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
    `<div class="card muted">Henüz kişi yok. “Ekran Görüntüsü” sekmesinden yükleme yapabilir ya da “Kişiler” sekmesinden kişi ekleyebilirsin.</div>`;
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
      ${state.categories.map(c => `<label>${esc(c.name)}<input type="number" step="0.01" inputmode="decimal" name="price_${c.id}" placeholder="${num(c.price)}" value="${p.prices?.[c.id] ?? ''}"></label>`).join('')}
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
    for (const c of state.categories) { const v = f['price_' + c.id].value; if (v !== '') p.prices[c.id] = num(v); }
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
      <input data-f="price" type="number" step="0.01" inputmode="decimal" value="${c.price}" aria-label="Fiyat">
      <span class="muted small">₺ / paket</span>
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
  const active = document.activeElement;
  for (const id of ['company', 'footerNote', 'apiKey', 'model']) if (active !== $('#' + id)) $('#' + id).value = state[id] || '';
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
bindList('#expList', 'expenses');
$('#addCat').onclick = () => { state.categories.push({ id: uid(), name: 'Yeni kategori', price: 0 }); save(); render(); };
$('#addExp').onclick = () => { state.expenses.push({ id: uid(), name: 'Gider', rate: 0, mode: 'deduct', enabled: true }); save(); render(); };
for (const id of ['company', 'footerNote', 'apiKey', 'model']) $('#' + id).onchange = e => { state[id] = e.target.value.trim(); save(); render(); };

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
    showAuth('Bu hesabın panele erişim izni yok.');
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

// Büyük görüntüleri küçültüp base64 JPEG yapar (API maliyeti ve hız için).
function imageToBase64(file, max = 1800) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      resolve(cv.toDataURL('image/jpeg', 0.9).split(',')[1]);
    };
    img.onerror = () => reject(new Error('görüntü açılamadı'));
    img.src = URL.createObjectURL(file);
  });
}

function buildPrompt() {
  const cats = state.categories.map(c => `- "${c.id}": ${c.name}`).join('\n');
  return `Bu ekran görüntüsü bir depodaki kuryelerin aylık paket sayılarını gösteriyor.
Görüntüdeki HER kurye için adını ve aşağıdaki kategorilerdeki paket ADETLERİNİ çıkar.

Kategoriler (anahtar: açıklama):
${cats}

Kurallar:
- "Tekli" ile "ilk paket" aynı şeydir; "çiftli" ile "birleşen paket" aynı şeydir.
- Sadece ADET (sayı) yaz, para tutarı yazma. Görüntüde olmayan kategori için 0 yaz.
- Kategori görüntüde farklı adla geçiyorsa en yakın kategoriye eşleştir.
- İsimleri görüntüde yazdığı gibi, Türkçe karakterleriyle yaz.
- Görüntüde kurye satırı yoksa "couriers" boş liste olsun.

Sadece şu biçimde geçerli JSON döndür, başka hiçbir şey yazma:
{"couriers":[{"name":"Ad Soyad","counts":{${state.categories.map(c => `"${c.id}":0`).join(',')}}}]}`;
}

async function readScreenshot(file) {
  const data = await imageToBase64(file);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': state.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: state.model || DEFAULT_MODEL,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: buildPrompt() },
        ],
      }],
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error?.message || `API ${r.status}`);
  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(json);
  return (parsed.couriers || []).filter(c => c.name);
}

let pending = []; // { name, counts, personId }

async function handleFiles(files) {
  files = files.filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  if (!state.apiKey) { toast('Önce Ayarlar’dan Claude API anahtarını gir'); showTab('ayarlar'); return; }
  const queue = $('#shotQueue');
  await Promise.all(files.map(async file => {
    const item = document.createElement('div');
    item.className = 'qitem';
    item.innerHTML = `<img alt=""><span>Okunuyor…</span>`;
    item.querySelector('img').src = URL.createObjectURL(file);
    queue.prepend(item);
    try {
      const found = await readScreenshot(file);
      item.querySelector('span').textContent = found.length ? `${found.length} kişi okundu: ${found.map(f => f.name).join(', ')}` : 'Kurye bulunamadı';
      for (const f of found) {
        const counts = {};
        for (const c of state.categories) counts[c.id] = num(f.counts?.[c.id]);
        // Aynı kişi birden fazla görüntüde varsa ilk okunan satırla birleştir
        const p = matchPerson(f.name);
        const same = pending.find(x => (p && x.personId === p.id) || norm(x.name) === norm(f.name));
        if (same) { for (const c of state.categories) same.counts[c.id] += counts[c.id]; }
        else pending.push({ key: uid(), name: f.name, counts, personId: p?.id || '' });
      }
    } catch (err) {
      item.querySelector('span').innerHTML = `<span class="err">Okunamadı: ${esc(err.message)}</span>`;
    }
  }));
  renderReview();
}

function renderReview() {
  $('#review').hidden = !pending.length;
  const opts = sel => `<option value="">— eşleşmedi —</option>` +
    [...state.people].sort((a, b) => a.name.localeCompare(b.name, 'tr'))
      .map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#reviewRows').innerHTML = pending.map(r => `
    <div class="rrow ${r.personId ? '' : 'unmatched'}" data-key="${r.key}">
      <div class="row gap">
        <strong style="flex:1 1 140px">${esc(r.name)}</strong>
        <select data-f="person" style="flex:1 1 180px;width:auto">${opts(r.personId)}</select>
        ${r.personId ? '' : '<button class="secondary" data-f="new">Yeni kişi olarak ekle</button>'}
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
  if (!f || e.target.tagName !== 'BUTTON') return;
  const row = pending.find(r => r.key === e.target.closest('[data-key]').dataset.key);
  if (f === 'drop') { pending = pending.filter(r => r !== row); renderReview(); }
  if (f === 'new') editPerson(null, row.name, p => { row.personId = p.id; renderReview(); });
});
$('#reviewCancel').onclick = () => { pending = []; renderReview(); };
$('#reviewSave').onclick = () => {
  const unmatched = pending.filter(r => !r.personId);
  if (unmatched.length && !confirm(`${unmatched.length} satır bir kişiyle eşleşmedi, bunlar atlanacak. Devam?`)) return;
  const add = $('#addMode').checked;
  let n = 0;
  for (const r of pending.filter(r => r.personId)) {
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
  toast(`${n} kişinin ${periodLabel(currentPeriod())} verisi kaydedildi`);
  showTab('donem');
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
    right(money(l.price), 780, y);
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
  for (const l of c.lines.filter(l => l.count)) lines.push(`${l.name}: ${l.count} × ${money(l.price)} = ${money(l.amount)}`);
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

async function sendWhatsApp(pid) {
  const p = personById(pid);
  const phone = waNumber(p.phone);
  const blobPromise = renderInvoice(pid);

  // Telefon: paylaşım menüsü görseli doğrudan WhatsApp'a verir (kişiyi orada seçersin).
  if (isTouch() && navigator.canShare) {
    const file = new File([await blobPromise], fileName(pid), { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: invoiceText(pid) });
        markSent(pid);
      } catch (e) { if (e.name !== 'AbortError') toast('Paylaşılamadı: ' + e.message); }
      return;
    }
  }

  // Bilgisayar: görsel panoya kopyalanır, WhatsApp sohbeti açılır, Ctrl+V ile yapıştırılır.
  let copied = false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
    copied = true;
  } catch {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await blobPromise);
    a.download = fileName(pid);
    a.click();
  }
  if (phone) {
    window.open(`https://wa.me/${phone}`, '_blank');
  } else {
    toast(`${p.name} için numara yok — Kişiler’den ekle`);
  }
  if (copied) toast('Görsel kopyalandı — WhatsApp sohbetinde Ctrl+V yapıp gönder', 5000);
  else toast('Görsel indirildi — WhatsApp sohbetine ekleyip gönder', 5000);
  markSent(pid);
}

function markSent(pid) {
  const rec = record(pid);
  if (rec) { rec.sentAt = Date.now(); save(); renderPeriod(); }
}

// Sırayla gönder: gönderilmemiş kişileri tek tek açar.
$('#bulkSend').onclick = () => {
  const recs = state.records[currentPeriod()] || {};
  const todo = state.people.filter(p => recs[p.id] && !recs[p.id].sentAt);
  if (!todo.length) { toast('Gönderilmemiş kişi yok'); return; }
  let i = 0;
  const step = () => {
    const p = todo[i];
    openModal(`
      <h2>${i + 1} / ${todo.length}: ${esc(p.name)}</h2>
      <p class="muted">${money(calc(p, recs[p.id]).net)} — ${esc(p.phone || 'numara yok')}</p>
      <div class="row gap end">
        <button value="stop" class="secondary">Bitir</button>
        <button type="button" class="secondary" data-x="skip">Atla</button>
        <button type="button" class="wa" data-x="send">WhatsApp'a gönder</button>
      </div>`, null, {
      send: async () => { closeModal(); await sendWhatsApp(p.id); next(); },
      skip: () => { closeModal(); next(); },
    });
  };
  const next = () => { i++; if (i < todo.length) setTimeout(step, 400); else toast('Liste bitti'); };
  step();
};

/* ---------- Başlat ---------- */

(async () => {
  if (!sb) { showAuth(); return; }
  const { data } = await sb.auth.getSession();
  if (data.session) enterApp(data.session);
  else showAuth();
})();
