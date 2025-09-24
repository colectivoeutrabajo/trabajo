// Config
const SUPABASE_URL = 'https://kozwtpgopvxrvkbvsaeo.supabase.co'; // <-- tu URL
const SUPABASE_ANON_KEY = 'REEMPLAZA_CON_TU_ANON_KEY';            // <-- tu anon
const BUCKET = 'audios';
const PREFIX = 'recordings';     // carpeta donde guardas los audios
const PAGE_SIZE = 50;

// Si no configuras en el backend, usamos 1 GB (Free)
const DEFAULT_QUOTA_BYTES = 1 * 1024 * 1024 * 1024;

// Supabase client (solo SELECT)
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Estado UI
let PAGE = 1;
let LAST_TOTAL = 0;
let CURRENT_ROWS = [];
let SELECTED = new Set();

const $ = s => document.querySelector(s);
const fmtBytes = n => {
  if (n == null) return '—';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < units.length-1){ v/=1024; i++; }
  return `${v.toFixed(v<10?2:1)} ${units[i]}`;
};
const toast = (m)=>{ const t=$('#toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2500); };

function getAdminKey(){ return sessionStorage.getItem('ADMIN_KEY') || $('#adminKeyInput').value.trim(); }
function saveAdminKey(){ const k=$('#adminKeyInput').value.trim(); if(k){ sessionStorage.setItem('ADMIN_KEY',k); toast('Admin key guardada'); }}

// ------- Resumen de uso real (Storage) -------
async function refreshUsage(){
  try{
    const res = await fetch(`/api/admin/cleanup?op=usage`, {
      headers: { 'x-admin-key': getAdminKey() || '' }
    });
    if(!res.ok){ throw new Error('No autorizado o error de servidor'); }
    const j = await res.json();
    const used = j.usedBytes ?? 0;
    const quota = j.quotaBytes ?? DEFAULT_QUOTA_BYTES;
    $('#usedHuman').textContent = fmtBytes(used);
    $('#quotaHuman').textContent = fmtBytes(quota);
    const pct = Math.min(100, (used/quota)*100);
    $('#usedBar').style.width = `${pct.toFixed(1)}%`;
  }catch(e){
    console.error(e);
    $('#usedHuman').textContent = '—';
    $('#quotaHuman').textContent = fmtBytes(DEFAULT_QUOTA_BYTES);
    $('#usedBar').style.width = '0%';
  }
}

// ------- Query builder -------
function buildQuery(){
  const q = $('#q').value.trim();
  const approved = $('#approved').value;
  const transcript = $('#transcript').value;
  const mime = $('#mime').value;
  const from = $('#fromDate').value;
  const to = $('#toDate').value;
  const minDur = parseInt($('#minDur').value || '0', 10);
  const minKB  = parseInt($('#minKB').value || '0', 10);
  const order = $('#orderBy').value; // e.g., created_at.desc

  let query = sb.from('recordings')
    .select('id, created_at, file_path, mime_type, size_bytes, duration_seconds, transcript, approved, location_city', { count: 'exact' });

  if (approved !== 'all') query = query.eq('approved', approved === 'true');

  if (transcript === 'null')      query = query.is('transcript', null);
  else if (transcript === 'nonnull') query = query.not('transcript', 'is', null);

  if (mime === 'mp4')  query = query.or('mime_type.ilike.%mp4%,file_path.ilike.%.m4a');
  if (mime === 'webm') query = query.or('mime_type.ilike.%webm%,file_path.ilike.%.webm');

  if (q) {
    // buscar por path o transcript
    query = query.or(`file_path.ilike.%${q}%,transcript.ilike.%${q}%`);
  }

  if (from) query = query.gte('created_at', new Date(from).toISOString());
  if (to) {
    const end = new Date(to); end.setDate(end.getDate()+1); // incluir el día
    query = query.lt('created_at', end.toISOString());
  }

  if (minDur > 0) query = query.gte('duration_seconds', minDur);
  if (minKB  > 0) query = query.gte('size_bytes', minKB * 1024);

  // order
  const [col, dir] = order.split('.');
  query = query.order(col, { ascending: dir === 'asc' });

  // paginación
  const fromIdx = (PAGE-1) * PAGE_SIZE;
  const toIdx   = fromIdx + PAGE_SIZE - 1;
  query = query.range(fromIdx, toIdx);

  return query;
}

function renderRows(rows){
  const tbody = $('#rows');
  tbody.innerHTML = '';
  $('#empty').classList.toggle('hidden', rows.length > 0);

  CURRENT_ROWS = rows;
  const fmtDate = s => new Date(s).toLocaleString();

  for(const r of rows){
    const tr = document.createElement('tr');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = SELECTED.has(r.id);
    cb.addEventListener('change', ()=> {
      if(cb.checked) SELECTED.add(r.id); else SELECTED.delete(r.id);
    });
    const tdSel = document.createElement('td'); tdSel.appendChild(cb);

    const tdDate = document.createElement('td'); tdDate.textContent = fmtDate(r.created_at);
    const tdDur  = document.createElement('td'); tdDur.textContent  = (r.duration_seconds ?? 0) + 's';
    const tdSize = document.createElement('td'); tdSize.textContent = fmtBytes(r.size_bytes);
    const tdMime = document.createElement('td'); tdMime.textContent = r.mime_type || '—';
    const tdAppr = document.createElement('td'); tdAppr.innerHTML   = r.approved ? '<span class="badge-true">true</span>' : '<span class="badge-false">false</span>';
    const tdTr   = document.createElement('td'); tdTr.textContent   = (r.transcript ? 'sí' : 'NULL');
    const tdCity = document.createElement('td'); tdCity.textContent = r.location_city || '—';
    const tdPath = document.createElement('td'); tdPath.innerHTML   = `<span class="mono">${r.file_path || '—'}</span>`;

    tr.append(tdSel, tdDate, tdDur, tdSize, tdMime, tdAppr, tdTr, tdCity, tdPath);
    tbody.appendChild(tr);
  }
  $('#pageInfo').textContent = `Página ${PAGE} · ${rows.length} filas (de ${LAST_TOTAL})`;
}

async function load(){
  const { data, count, error } = await buildQuery();
  if(error){ console.error(error); toast('Error al consultar'); return; }
  LAST_TOTAL = count || 0;
  renderRows(data || []);
}

// ------- Acciones -------
function selectedRows(){
  const map = new Map(CURRENT_ROWS.map(r => [r.id, r]));
  const picked = [];
  for(const id of SELECTED){
    if(map.has(id)) picked.push(map.get(id));
  }
  return picked;
}

function showResult(obj, ok=true){
  const box = $('#resultBox');
  box.className = `result ${ok?'ok':'err'}`;
  box.innerHTML = `<pre>${JSON.stringify(obj, null, 2)}</pre>`;
  box.classList.remove('hidden');
}

async function action(endpointBody){
  const key = getAdminKey();
  if(!key){ toast('Ingresa Admin Key'); return null; }

  const res = await fetch('/api/admin/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify(endpointBody)
  });
  if(!res.ok){
    const err = await res.text().catch(()=>('Error'));
    showResult({ error: err }, false);
    return null;
  }
  const j = await res.json();
  showResult(j, true);
  return j;
}

// ---- Botones ----
$('#applyFilters').addEventListener('click', ()=>{ PAGE=1; SELECTED.clear(); load(); });
$('#resetFilters').addEventListener('click', ()=>{
  $('#q').value=''; $('#approved').value='true'; $('#transcript').value='all'; $('#mime').value='all';
  $('#fromDate').value=''; $('#toDate').value=''; $('#minDur').value=''; $('#minKB').value='';
  $('#orderBy').value='created_at.desc'; PAGE=1; SELECTED.clear(); load();
});

$('#refresh').addEventListener('click', ()=>{ load(); refreshUsage(); });
$('#selectPage').addEventListener('click', ()=>{
  for(const r of CURRENT_ROWS){ SELECTED.add(r.id); }
  load();
});
$('#clearSel').addEventListener('click', ()=>{ SELECTED.clear(); load(); });

$('#prev').addEventListener('click', ()=>{ if(PAGE>1){ PAGE--; load(); } });
$('#next').addEventListener('click', ()=>{ if(PAGE*PAGE_SIZE < LAST_TOTAL){ PAGE++; load(); } });

$('#dryRun').addEventListener('click', ()=>{
  const picked = selectedRows();
  const bytes = picked.reduce((a,r)=> a + (r.size_bytes||0), 0);
  showResult({ selection: picked.length, wouldFree: bytes, human: fmtBytes(bytes) }, true);
});

$('#downloadLinks').addEventListener('click', async ()=>{
  const picked = selectedRows();
  if(picked.length===0) return toast('Nada seleccionado');
  const file_paths = picked.map(r=> r.file_path).filter(Boolean);
  const j = await action({ action: 'signed_urls', file_paths, expiresInSec: 600 });
  if(!j) return;
  // Mostrar lista simple de links
  const links = (j.links||[]).map(x=> x.signedUrl || x.error || '').filter(Boolean);
  showResult({ count: links.length, links }, true);
});

$('#archiveOnly').addEventListener('click', async ()=>{
  const picked = selectedRows(); if(picked.length===0) return toast('Nada seleccionado');
  if(!confirm(`Marcar approved=false en ${picked.length} filas (no borra archivos). ¿Continuar?`)) return;
  const ids = picked.map(r=> r.id);
  await action({ action: 'disapprove_only', ids });
  await load(); await refreshUsage();
});

$('#deleteAndDisapprove').addEventListener('click', async ()=>{
  const picked = selectedRows(); if(picked.length===0) return toast('Nada seleccionado');
  if(!confirm(`Borrar del Storage y poner approved=false en ${picked.length} filas. ¿Continuar?`)) return;
  const ids = picked.map(r=> r.id);
  const file_paths = picked.map(r=> r.file_path).filter(Boolean);
  await action({ action: 'delete_storage_and_disapprove', ids, file_paths });
  SELECTED.clear();
  await load(); await refreshUsage();
});

$('#saveAdminKey').addEventListener('click', saveAdminKey);

// Init
(async ()=>{
  const saved = sessionStorage.getItem('ADMIN_KEY'); if(saved) $('#adminKeyInput').value = saved;
  await refreshUsage();
  await load();
})();
