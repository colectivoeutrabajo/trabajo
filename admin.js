// admin.js — versión compatible con tu estructura previa
// - No muestra el JSON UNAUTHORIZED al cargar; pide la Admin Key con un hint.
// - Lee Supabase de window.SUPABASE_URL / window.SUPABASE_ANON_KEY
//   o de window.env.* o de constantes globales SUPABASE_URL / SUPABASE_ANON_KEY
// - Siempre manda x-admin-key si existe.
// - UI y botones igual que tu admin original.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const PAGE_SIZE = 50;

let page = 1;
let rows = [];
let checkedIds = new Set();
let supa = null;

function humanBytes(n){
  if (!Number.isFinite(n)) return '—';
  const u=['B','KB','MB','GB','TB']; let i=0, v=Number(n);
  while (v>=1024 && i<u.length-1){ v/=1024; i++; }
  return `${v.toFixed(v<10?2:1)} ${u[i]}`;
}

const toastEl = $('#toast');
let TOAST_T;
function toast(msg, ms=1800){
  clearTimeout(TOAST_T);
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  TOAST_T = setTimeout(()=> toastEl.classList.add('hidden'), ms);
}

function showResult(obj, ok=true){
  const box = $('#resultBox');
  if (!box) return;
  box.className = `result ${ok?'ok':'err'}`;
  box.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  box.classList.remove('hidden');
}

function setHint(msg){
  const h = $('#hint');
  if (!h) return;
  if (!msg){ h.classList.add('hidden'); h.textContent=''; }
  else { h.textContent = msg; h.classList.remove('hidden'); }
}

// ===== Admin Key =====
function getAdminKey(){
  const input = $('#adminKeyInput');
  const v = input?.value?.trim();
  if (v) return v;
  const s = sessionStorage.getItem('ADMIN_KEY');
  if (s){ if (input && !input.value) input.value = s; return s; }
  return '';
}
function saveAdminKey(v){
  sessionStorage.setItem('ADMIN_KEY', v);
  const input = $('#adminKeyInput');
  if (input) input.value = v;
}

// ===== Supabase client (anon lectura) =====
function getSupabaseConfig(){
  // Prioridad: window.* -> window.env.* -> constantes globales (compat)
  const url =
    window.SUPABASE_URL ||
    (window.env && window.env.SUPABASE_URL) ||
    (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : null);

  const anon =
    window.SUPABASE_ANON_KEY ||
    (window.env && window.env.SUPABASE_ANON_KEY) ||
    (typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : null);

  return { url, anon };
}

function ensureSupa(){
  if (supa) return supa;
  const { url, anon } = getSupabaseConfig();
  if (!url || !anon) return null;
  supa = createClient(url, anon);
  return supa;
}

// ===== Backend call =====
async function callCleanup(method, urlParams=null, body=null){
  const url = new URL('/api/admin/cleanup', location.origin);
  if (urlParams) for (const [k,v] of Object.entries(urlParams)) url.searchParams.set(k, v);

  const headers = {};
  const adminKey = getAdminKey();
  if (adminKey) headers['x-admin-key'] = adminKey;
  if (body) headers['content-type'] = 'application/json';

  const res = await fetch(url.toString(), {
    method, headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let data = null;
  try { data = await res.json(); } catch { data = { error:'bad-json' }; }

  if (res.status === 401){
    // No inundamos la UI con el JSON; solo hint claro
    setHint('No autorizado: ingresa Admin Key y pulsa “Guardar”.');
    $('#adminKeyInput')?.focus();
    // NO showResult del error aquí para que no estorbe visualmente
    throw new Error('UNAUTHORIZED');
  }
  if (!res.ok){
    showResult(data || {error: `HTTP ${res.status}`}, false);
    throw new Error(`HTTP ${res.status}`);
  }
  setHint('');
  return data;
}

// ===== Usage bar =====
async function refreshUsage(){
  try{
    const data = await callCleanup('GET', { op:'usage' });
    const used = Number(data.usedBytes||0);
    const quota = Number(data.quotaBytes||0);
    $('#usageText').textContent = `${humanBytes(used)} de ${humanBytes(quota)} (${data.count} archivos)`;
    const pct = quota ? Math.min(100, Math.round(used*100/quota)) : 0;
    $('#usageBar').style.width = `${pct}%`;
    return true;
  }catch(e){
    // Si es 401, dejamos el hint puesto y no ensuciamos la pantalla
    return false;
  }
}

// ===== Listado =====
async function load(){
  const client = ensureSupa();
  if (!client){
    $('#tbody').innerHTML = `<tr><td colspan="8" style="color:#666">Sin cliente Supabase (anon). Aún puedes usar Descargar/Borrar con Admin Key.</td></tr>`;
    $('#pageInfo').textContent = '—';
    return;
  }
  const from = (page-1)*PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data, error } = await client
    .from('recordings')
    .select('id,file_path,mime_type,duration_seconds,size_bytes,approved,created_at')
    .order('created_at', { ascending:false })
    .range(from, to);

  if (error){
    showResult({error: error.message}, false);
    return;
  }
  rows = data || [];
  renderTable();
  $('#pageInfo').textContent = `Página ${page} · ${rows.length} filas`;
}

function renderTable(){
  const tb = $('#tbody');
  tb.innerHTML = rows.map(r=>{
    const checked = checkedIds.has(r.id) ? 'checked' : '';
    const size = humanBytes(r.size_bytes||0);
    return `<tr>
      <td><input type="checkbox" data-id="${r.id}" ${checked}></td>
      <td class="mono">${r.id}</td>
      <td class="mono">${r.file_path || '—'}</td>
      <td>${r.mime_type || '—'}</td>
      <td>${r.duration_seconds ?? '—'}</td>
      <td>${size}</td>
      <td>${r.approved ? 'true' : 'false'}</td>
      <td>${new Date(r.created_at).toLocaleString()}</td>
    </tr>`;
  }).join('');

  $$('#tbody input[type=checkbox]').forEach(chk=>{
    chk.addEventListener('change', e=>{
      const id = e.target.getAttribute('data-id');
      if (e.target.checked) checkedIds.add(id);
      else checkedIds.delete(id);
    });
  });

  const cap = $('#checkAllPage');
  cap.checked = rows.length>0 && rows.every(r=>checkedIds.has(r.id));
  cap.onchange = ()=>{
    if (cap.checked) rows.forEach(r=>checkedIds.add(r.id));
    else rows.forEach(r=>checkedIds.delete(r.id));
    renderTable();
  };
}

function pickCurrent(){
  const selected = rows.filter(r => checkedIds.has(r.id));
  const ids = selected.map(r=>r.id);
  const file_paths = selected.map(r=>r.file_path).filter(Boolean);
  return { ids, file_paths, selected };
}

// ===== Acciones =====
async function actDownloadLinks(){
  const { file_paths } = pickCurrent();
  if (!file_paths.length) { toast('Selecciona al menos 1 fila'); return; }
  const res = await callCleanup('POST', null, {
    action:'signed_urls',
    file_paths,
    expiresInSec: 600
  });
  showResult({count: res.links?.length||0, links: res.links}, true);
  toast('Links generados');
}

async function actArchiveOnly(){
  const { ids } = pickCurrent();
  if (!ids.length) { toast('Selecciona al menos 1 fila'); return; }
  const res = await callCleanup('POST', null, {
    action:'disapprove_only',
    ids
  });
  showResult(res, true);
  toast('Marcados approved=false');
  await load();
}

async function actDeleteAndDisapprove(){
  const { ids, file_paths } = pickCurrent();
  if (!ids.length || !file_paths.length) { toast('Selecciona filas con file_path'); return; }
  if (!confirm(`¿Borrar ${file_paths.length} del Storage y marcar ${ids.length} como approved=false?`)) return;
  const res = await callCleanup('POST', null, {
    action:'delete_storage_and_disapprove',
    ids, file_paths
  });
  showResult(res, true);
  toast(`Borrados del Storage: ${res.deleted || 0}`);
  checkedIds.clear();
  await Promise.all([refreshUsage(), load()]);
}

// ===== Bind / Init =====
function bind(){
  $('#saveKeyBtn')?.addEventListener('click', ()=>{
    const v = $('#adminKeyInput')?.value?.trim();
    if (!v){ toast('Ingresa Admin Key'); $('#adminKeyInput')?.focus(); return; }
    saveAdminKey(v);
    toast('Admin Key guardada');
    setHint('');
  });
  $('#refresh')?.addEventListener('click', async ()=>{
    await refreshUsage();
    await load();
  });
  $('#selectPage')?.addEventListener('click', ()=>{
    rows.forEach(r=>checkedIds.add(r.id));
    renderTable();
  });
  $('#clearSel')?.addEventListener('click', ()=>{
    checkedIds.clear();
    renderTable();
  });

  $('#downloadLinks')?.addEventListener('click', actDownloadLinks);
  $('#archiveOnly')?.addEventListener('click', actArchiveOnly);
  $('#deleteAndDisapprove')?.addEventListener('click', actDeleteAndDisapprove);

  $('#prev')?.addEventListener('click', ()=>{
    if (page>1){ page--; load(); }
  });
  $('#next')?.addEventListener('click', ()=>{
    page++; load();
  });
}

window.addEventListener('DOMContentLoaded', async ()=>{
  // refleja admin key guardada si existe
  const k = sessionStorage.getItem('ADMIN_KEY');
  if (k && $('#adminKeyInput') && !$('#adminKeyInput').value) $('#adminKeyInput').value = k;

  bind();

  // 1) Intento de usage (si 401, solo pone hint; ya no muestra JSON feo)
  await refreshUsage();

  // 2) Lista (si no hay supabase anon en window, te lo dice y puedes usar los botones igual)
  await load();
});
