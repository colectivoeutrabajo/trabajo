// admin.js — versión robusta para que SIEMPRE mande x-admin-key
// y muestre errores claros cuando falte o no coincida.
//
// No cambia la UI. Solo arregla el wiring de la Admin Key y las llamadas.
//
// Requisitos backend: /api/admin/cleanup con:
//  - GET   ?op=usage
//  - POST  { action: 'signed_urls'|'disapprove_only'|'delete_storage_and_disapprove', ... }
// Debe validar header 'x-admin-key'.

// ========= util dom =========
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const toastEl = document.createElement('div');
toastEl.id = 'toast';
toastEl.style.position = 'fixed';
toastEl.style.left = '50%';
toastEl.style.bottom = '24px';
toastEl.style.transform = 'translateX(-50%)';
toastEl.style.background = 'rgba(20,20,20,.92)';
toastEl.style.color = '#fff';
toastEl.style.padding = '10px 14px';
toastEl.style.borderRadius = '999px';
toastEl.style.boxShadow = '0 8px 30px rgba(0,0,0,.2)';
toastEl.style.zIndex = '9999';
toastEl.style.display = 'none';
document.addEventListener('DOMContentLoaded', ()=> document.body.appendChild(toastEl));
let TOAST_T;
function toast(msg, ms=1800){
  clearTimeout(TOAST_T);
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  TOAST_T = setTimeout(()=> toastEl.style.display='none', ms);
}

function showResult(obj, ok=true){
  const box = $('#resultBox');
  if (!box) return;
  box.className = `result ${ok ? 'ok' : 'err'}`;
  box.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  box.classList.remove('hidden');
}

function setHint(msg){
  const h = $('#hint');
  if (!h) return;
  if (!msg) { h.classList.add('hidden'); h.textContent = ''; }
  else { h.textContent = msg; h.classList.remove('hidden'); }
}

function humanBytes(n){
  if (!Number.isFinite(n)) return '—';
  const u=['B','KB','MB','GB','TB']; let i=0, v=Number(n);
  while (v>=1024 && i<u.length-1){ v/=1024; i++; }
  return `${v.toFixed(v<10?2:1)} ${u[i]}`;
}

// ========= estado =========
const PAGE_SIZE = 50;          // puedes subir a 500 si vas a limpiar mucho
let page = 1;
let rows = [];
let checkedIds = new Set();

// Admin Key management
function getAdminKey(){
  // 1) input
  const v = $('#adminKeyInput')?.value?.trim();
  if (v) return v;
  // 2) sessionStorage
  const s = sessionStorage.getItem('ADMIN_KEY');
  if (s) {
    // refleja al input si está vacío
    if ($('#adminKeyInput') && !$('#adminKeyInput').value) $('#adminKeyInput').value = s;
    return s;
  }
  return '';
}

function saveAdminKey(v){
  sessionStorage.setItem('ADMIN_KEY', v);
  if ($('#adminKeyInput')) $('#adminKeyInput').value = v;
}

// ========= llamadas backend =========
async function callCleanup(method, urlParams=null, body=null){
  const url = new URL('/api/admin/cleanup', location.origin);
  if (urlParams) for (const [k,v] of Object.entries(urlParams)) url.searchParams.set(k, v);

  const adminKey = getAdminKey();
  const headers = {};
  if (adminKey) headers['x-admin-key'] = adminKey;
  if (body) headers['content-type'] = 'application/json';

  const res = await fetch(url.toString(), {
    method, headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let data;
  try { data = await res.json(); } catch { data = { error: 'Bad JSON' }; }

  if (res.status === 401){
    // Mensaje claro y enfoque al campo
    setHint('No autorizado: ingresa una Admin Key válida y pulsa “Guardar”.');
    $('#adminKeyInput')?.focus();
    showResult(data, false);
    throw new Error('UNAUTHORIZED');
  }
  if (!res.ok){
    showResult(data, false);
    throw new Error(`HTTP ${res.status}`);
  }
  setHint('');
  return data;
}

// ========= usage (barra) =========
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
    return false;
  }
}

// ========= listado (con Supabase anon si lo tienes) =========
let supa = null;
async function ensureSupa(){
  if (supa) return supa;
  // Si tienes SUPABASE_URL/ANON_KEY expuestas en window (como en tus otras pantallas)
  const url = window.SUPABASE_URL || (window.env && window.env.SUPABASE_URL);
  const anon = window.SUPABASE_ANON_KEY || (window.env && window.env.SUPABASE_ANON_KEY);
  if (!url || !anon) return null;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  supa = createClient(url, anon);
  return supa;
}

async function load(){
  const client = await ensureSupa();
  if (!client){
    $('#tbody').innerHTML = `<tr><td colspan="8" style="color:#666">Sin cliente Supabase (anon). Aún puedes usar Descargar/Borrar con Admin Key.</td></tr>`;
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
    showResult({error:error.message}, false);
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
  cap.checked = rows.every(r => checkedIds.has(r.id)) && rows.length>0;
  cap.onchange = ()=> {
    if (cap.checked) rows.forEach(r=>checkedIds.add(r.id));
    else rows.forEach(r=>checkedIds.delete(r.id));
    renderTable();
  };
}

// ========= helpers acciones =========
function pickCurrent(){
  const selected = rows.filter(r => checkedIds.has(r.id));
  const ids = selected.map(r=>r.id);
  const file_paths = selected.map(r=>r.file_path).filter(Boolean);
  return { ids, file_paths, selected };
}

// ========= acciones =========
async function actDownloadLinks(){
  const { file_paths } = pickCurrent();
  if (!file_paths.length) { toast('Selecciona al menos 1 fila'); return; }
  const res = await callCleanup('POST', null, {
    action:'signed_urls',
    file_paths,
    expiresInSec: 600
  });
  showResult({count: res.links?.length||0, links: res.links}, true);
  toast('Links generados (.txt descargado si tu UI lo hace)');
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

// ========= bind =========
function bind(){
  $('#saveKeyBtn')?.addEventListener('click', ()=>{
    const v = $('#adminKeyInput')?.value?.trim();
    if (!v) { toast('Ingresa Admin Key'); $('#adminKeyInput')?.focus(); return; }
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

// ========= init =========
window.addEventListener('DOMContentLoaded', async ()=>{
  // Si la Admin Key ya estaba en sessionStorage, refléjala al input
  const k = sessionStorage.getItem('ADMIN_KEY');
  if (k && $('#adminKeyInput') && !$('#adminKeyInput').value) $('#adminKeyInput').value = k;

  bind();

  // Primer intento: usage (si 401, mostrará hint y pedirá key)
  await refreshUsage();

  // Carga de tabla (si no tienes supabase anon en window, igual podrás usar los botones)
  await load();
});
