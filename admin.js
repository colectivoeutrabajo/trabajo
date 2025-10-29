
// admin.js (ESM)
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ====== CONFIG UI ======
const PAGE_SIZE = 50; // cámbialo a 500 temporalmente si quieres limpiar rápido

// ====== UI helpers ======
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const toastEl = $('#toast');
let TOAST_T;

function toast(msg, ms=1800){
  clearTimeout(TOAST_T);
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  TOAST_T = setTimeout(()=>toastEl.classList.add('hidden'), ms);
}

function setHint(msg){ const h=$('#hint'); if(!msg){h.classList.add('hidden');h.textContent='';} else {h.textContent=msg;h.classList.remove('hidden');} }

function showResult(obj, ok=true){
  const box = $('#resultBox'); box.className = `result ${ok?'ok':'err'}`;
  if (typeof obj === 'string') { box.textContent = obj; }
  else { box.textContent = JSON.stringify(obj, null, 2); }
  box.classList.remove('hidden');
}

function humanBytes(n){
  if (!Number.isFinite(n)) return '—';
  const u=['B','KB','MB','GB','TB']; let i=0, v=Number(n);
  while (v>=1024 && i<u.length-1){ v/=1024; i++; }
  return `${v.toFixed(v<10?2:1)} ${u[i]}`;
}

// ====== STATE ======
let adminKey = sessionStorage.getItem('ADMIN_KEY') || '';
let supa; // cliente de sólo lectura para listar (usa anon si lo quieres)
let page = 1;
let rows = [];         // última página
let checkedIds = new Set();

// ====== BACKEND CALL ======
async function callCleanup(method, urlParams=null, body=null){
  const url = new URL('/api/admin/cleanup', location.origin);
  if (urlParams) for (const [k,v] of Object.entries(urlParams)) url.searchParams.set(k, v);

  const headers = { 'x-admin-key': adminKey };
  if (body) headers['content-type'] = 'application/json';

  const res = await fetch(url.toString(), {
    method, headers,
    body: body ? JSON.stringify(body) : undefined
  });

  // Ayuda visual según 401
  if (res.status === 401){
    const msg = await res.json().catch(()=>({error:'UNAUTHORIZED'}));
    setHint('No autorizado: ingresa una Admin Key válida y pulsa “Guardar”.');
    showResult(msg, false);
    throw new Error('UNAUTHORIZED');
  }
  return res.json();
}

// ====== USO DE STORAGE ======
async function refreshUsage(){
  try{
    const data = await callCleanup('GET', { op:'usage' });
    const used = Number(data.usedBytes||0);
    const quota = Number(data.quotaBytes||0);
    $('#usageText').textContent = `${humanBytes(used)} de ${humanBytes(quota)} (${data.count} archivos)`;
    const pct = quota ? Math.min(100, Math.round(used*100/quota)) : 0;
    $('#usageBar').style.width = `${pct}%`;
    setHint('');
    return true;
  }catch(e){
    // si no autorizado, ya mostramos hint
    return false;
  }
}

// ====== LISTADO (con Supabase anon para lectura) ======
function supaClient(){
  // Usa variables ya inyectadas en index/escuchar (si las tienes globales).
  // Si no, puedes dejar anonKey/url aquí (solo para lectura).
  // Para no tocar tu setup, intento leer del window si existe:
  const url = window.SUPABASE_URL || (window.env && window.env.SUPABASE_URL);
  const anon = window.SUPABASE_ANON_KEY || (window.env && window.env.SUPABASE_ANON_KEY);
  if (!url || !anon) return null;
  return createClient(url, anon);
}

async function load(){
  if (!supa){
    supa = supaClient();
    if (!supa){
      setHint('No se encontró SUPABASE_URL/ANON_KEY en window. Solo funcionará la parte de “Borrar/Descargar” con Admin Key.');
      $('#grid').classList.add('readonly');
    }
  }
  if (!supa){ // sin listado, pero no bloquea admin
    $('#tbody').innerHTML = `<tr><td colspan="8" style="color:#666">Sin cliente Supabase: sólo administra con los botones de arriba.</td></tr>`;
    return;
  }

  const from = (page-1)*PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data, error, count } = await supa
    .from('recordings')
    .select('id,file_path,mime_type,duration_seconds,size_bytes,approved,created_at', { count:'exact' })
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

  // hooks checks
  $$('#tbody input[type=checkbox]').forEach(chk=>{
    chk.addEventListener('change', e=>{
      const id = e.target.getAttribute('data-id');
      if (e.target.checked) checkedIds.add(id);
      else checkedIds.delete(id);
    });
  });

  // checkAll for page
  const cap = $('#checkAllPage');
  cap.checked = rows.every(r => checkedIds.has(r.id)) && rows.length>0;
  cap.onchange = ()=> {
    if (cap.checked) rows.forEach(r=>checkedIds.add(r.id));
    else rows.forEach(r=>checkedIds.delete(r.id));
    renderTable();
  };
}

// ====== ACCIONES ======
function pickCurrent(){
  // devuelve los ids y file_paths seleccionados presentes en la página
  const selected = rows.filter(r => checkedIds.has(r.id));
  const ids = selected.map(r=>r.id);
  const file_paths = selected.map(r=>r.file_path).filter(Boolean);
  return { ids, file_paths, selected };
}

async function actDownloadLinks(){
  const { file_paths } = pickCurrent();
  if (!file_paths.length) { toast('Selecciona al menos 1 fila'); return; }
  const res = await callCleanup('POST', null, {
    action:'signed_urls',
    file_paths,
    expiresInSec: 600
  });
  // Mostrar lista amigable
  const list = (res.links||[]).map((u,i)=>`#${i+1} ${u}`).join('\n');
  showResult({count:res.links?.length||0, links:res.links});
  // plus: descarga .txt
  const blob = new Blob([list], {type:'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `links_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
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
  toast('Marcados como approved=false');
  // refresca listado
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

// ====== INIT ======
function bind(){
  $('#saveKeyBtn').addEventListener('click', ()=>{
    const v = $('#adminKeyInput').value.trim();
    if (!v) return toast('Ingresa una Admin Key');
    adminKey = v;
    sessionStorage.setItem('ADMIN_KEY', v);
    toast('Admin Key guardada');
    setHint('');
  });

  $('#refresh').addEventListener('click', async ()=>{
    await refreshUsage();
    await load();
  });

  $('#selectPage').addEventListener('click', ()=>{
    rows.forEach(r=>checkedIds.add(r.id));
    renderTable();
  });

  $('#clearSel').addEventListener('click', ()=>{
    checkedIds.clear();
    renderTable();
  });

  $('#downloadLinks').addEventListener('click', actDownloadLinks);
  $('#archiveOnly').addEventListener('click', actArchiveOnly);
  $('#deleteAndDisapprove').addEventListener('click', actDeleteAndDisapprove);

  $('#prev').addEventListener('click', ()=>{
    if (page>1){ page--; load(); }
  });
  $('#next').addEventListener('click', ()=>{
    page++; load();
  });
}

async function selfCheck(){
  // 1) Admin Key: pide si no hay
  if (!adminKey){
    setHint('Ingresa una Admin Key y pulsa “Guardar”. Luego “Recargar”.');
    $('#adminKeyInput').focus();
  }
  // 2) Probar backend (usage). Si 401, mostrará hint solo.
  await refreshUsage();
  // 3) Listado inicial (si hay anon)
  await load();
}

window.addEventListener('DOMContentLoaded', ()=>{
  // precarga valor si existe
  if (adminKey) $('#adminKeyInput').value = adminKey;
  bind();
  selfCheck();
});
