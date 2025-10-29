// gestionar.js — pantalla independiente para listar, descargar ZIP y borrar (lógico+storage)
/* CONFIG (se reutilizan las mismas constantes que ya usas en app.js si están en window) */
const SUPABASE_URL = window.SUPABASE_URL || 'https://TU-PROYECTO.supabase.co';
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || 'TU-ANON-KEY';
const BUCKET = 'audios';
const PREFIX = 'recordings/'; // limitar deletes y construir rutas

// Clave de acceso (se valida contra querystring ?key=...)
const EXPECTED_KEY = 'CAMBIA_ESTA_CLAVE'; // <- cámbiala

// Cliente supabase
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helpers UI
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const toast = (m)=>{const t=$('#toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200);};

// Estado
let state = {
  page: 1,
  pageSize: 50,
  sortBy: 'created_at.desc',
  total: 0,
  rows: [],
  withStorageState: 'skip', // skip | present | missing
  selection: new Set(),
};

function getQS(key){ return new URLSearchParams(location.search).get(key); }

function humanFile(bytes){
  if(bytes==null) return '—';
  const units=['B','KB','MB','GB']; let i=0, n=bytes;
  while(n>=1024 && i<units.length-1){ n/=1024; i++; }
  return `${n.toFixed( (i>=2)?2:0 )} ${units[i]}`;
}

function fmtDur(s){
  if(s==null) return '—';
  return `${Math.round(s)} s`;
}

function fmtDate(iso){
  if(!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

function buildPublicURL(file_path){
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${file_path}`;
}

async function signedUrl(file_path, expires=180){
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(file_path, expires);
  if(error) return { url:null, error };
  return { url: data.signedUrl };
}

// --- Acceso con clave ---
function gate(){
  const urlKey = getQS('key');
  if(urlKey && urlKey===EXPECTED_KEY){
    $('#app').classList.remove('hidden');
    $('#gate').style.display='none';
    $('#accessKey').value = urlKey;
    return true;
  }
  $('#gate').style.display='flex';
  $('#app').classList.add('hidden');
  $('#keyBtn').onclick = ()=>{
    const k = $('#keyInput').value.trim();
    if(k===EXPECTED_KEY){
      const u = new URL(location.href);
      u.searchParams.set('key', k);
      location.href = u.toString();
    }else{
      $('#gateMsg').textContent='Clave incorrecta';
    }
  };
  return false;
}

// --- Carga / filtros ---
function readFilters(){
  const fs = {
    text: $('#fText').value.trim() || null,
    dateFrom: $('#fDateFrom').value || null,
    dateTo: $('#fDateTo').value || null,
    approved: $('#fApproved').value,
    mime: $('#fMime').value.trim() || null,
    durMin: $('#fDurMin').value ? Number($('#fDurMin').value) : null,
    durMax: $('#fDurMax').value ? Number($('#fDurMax').value) : null,
    sizeMin: $('#fSizeMin').value ? Math.round(Number($('#fSizeMin').value)*1024) : null,
    sizeMax: $('#fSizeMax').value ? Math.round(Number($('#fSizeMax').value)*1024) : null,
    country: $('#fCountry').value.trim() || null,
    city: $('#fCity').value.trim() || null,
    hasTranscript: $('#fHasTranscript').value,
    storageState: $('#fStorageState').value,
    sortBy: $('#sortBy').value,
    pageSize: Number($('#pageSize').value || 50),
    accessKey: $('#accessKey').value.trim()
  };
  state.sortBy = fs.sortBy;
  state.pageSize = fs.pageSize;
  state.withStorageState = fs.storageState;
  return fs;
}

async function loadPage(page=1){
  const fs = readFilters();
  state.page = page;
  state.selection.clear();

  let query = sb.from('recordings').select('*', { count: 'exact' });

  // texto en transcript
  if(fs.text){
    query = query.ilike('transcript', `%${fs.text}%`);
  }
  // fecha
  if(fs.dateFrom){ query = query.gte('created_at', fs.dateFrom); }
  if(fs.dateTo){ 
    // sumar un día para incluir "hasta"
    const dt = new Date(fs.dateTo);
    dt.setDate(dt.getDate()+1);
    query = query.lt('created_at', dt.toISOString());
  }
  // approved
  if(fs.approved==='true') query = query.eq('approved', true);
  else if(fs.approved==='false') query = query.eq('approved', false);
  // mime
  if(fs.mime){ query = query.eq('mime_type', fs.mime); }
  // duración
  if(fs.durMin!=null) query = query.gte('duration_seconds', fs.durMin);
  if(fs.durMax!=null) query = query.lte('duration_seconds', fs.durMax);
  // tamaño
  if(fs.sizeMin!=null) query = query.gte('size_bytes', fs.sizeMin);
  if(fs.sizeMax!=null) query = query.lte('size_bytes', fs.sizeMax);
  // ubicación
  if(fs.country){ query = query.eq('location_country', fs.country); }
  if(fs.city){ query = query.eq('location_city', fs.city); }
  // transcript present/absent
  if(fs.hasTranscript==='with') query = query.not('transcript','is',null);
  if(fs.hasTranscript==='without') query = query.is('transcript', null);

  // orden
  const [col, dir] = state.sortBy.split('.');
  query = query.order(col, { ascending: dir==='asc' });

  // paginación
  const from = (state.page-1)*state.pageSize;
  const to = from + state.pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if(error){ toast('Error al cargar'); console.error(error); return; }
  state.rows = data || [];
  state.total = count || 0;

  // Opcional: calcular estado de archivo (presente/ausente)
  if(state.withStorageState !== 'skip'){
    await annotateStorageState(state.rows);
  }

  renderTable();
  updatePager();
}

async function annotateStorageState(rows){
  // Hacemos GET con Range 0-0 (más compatible que HEAD en algunos entornos)
  await Promise.all(rows.map(async r=>{
    if(!r.file_path){ r._file='miss'; return; }
    const url = buildPublicURL(r.file_path);
    try{
      const resp = await fetch(url, { method:'GET', headers:{'Range':'bytes=0-0'}, cache:'no-store' });
      r._file = resp.ok ? 'ok' : 'miss';
    }catch{
      r._file = 'miss';
    }
  }));
}

function updatePager(){
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  $('#pageInfo').textContent = `Página ${state.page} / ${pages} — ${state.total} resultados`;
  $('#prevPage').disabled = state.page<=1;
  $('#nextPage').disabled = state.page>=pages;
}

function rowCheckbox(id, checked){ return `<input type="checkbox" class="rowchk" data-id="${id}" ${checked?'checked':''}>`; }

function renderTable(){
  const tb = $('#tbody');
  const rows = state.rows.map(r=>{
    const sel = state.selection.has(r.id);
    const where = [r.location_city, r.location_country].filter(Boolean).join(', ') || '—';
    const tShort = r.transcript ? (r.transcript.length>160 ? r.transcript.slice(0,160)+'…' : r.transcript) : '—';
    const fileBadge = r._file==='miss' ? '<span class="badge miss">ausente</span>' 
                     : r._file==='ok' ? '<span class="badge ok">presente</span>'
                     : '<span class="badge">—</span>';
    const dlBtn = `<button class="btn btn-ghost act-dl" data-id="${r.id}">Descargar</button>`;
    const delBtn = `<button class="btn btn-danger act-del" data-id="${r.id}">Marcar y borrar</button>`;
    return `<tr>
      <td>${rowCheckbox(r.id, sel)}</td>
      <td>${fmtDate(r.created_at)}</td>
      <td>${fmtDur(r.duration_seconds)}</td>
      <td>${humanFile(r.size_bytes)}</td>
      <td>${where}</td>
      <td>${tShort}</td>
      <td>${fileBadge}</td>
      <td class="actions">${dlBtn} ${delBtn}</td>
    </tr>`;
  }).join('');
  tb.innerHTML = rows || `<tr><td colspan="8" style="text-align:center;color:#64748b;padding:16px">Sin resultados</td></tr>`;

  // Eventos por fila
  $$('#tbody .rowchk').forEach(el=> el.addEventListener('change', (e)=>{
    const id = e.target.dataset.id;
    if(e.target.checked) state.selection.add(id); else state.selection.delete(id);
    $('#selectAll').checked = state.selection.size === state.rows.length && state.rows.length>0;
  }));
  $$('#tbody .act-dl').forEach(el=> el.addEventListener('click', (e)=>{
    const id = e.target.dataset.id;
    const row = state.rows.find(r=>r.id===id);
    if(row) downloadOne(row);
  }));
  $$('#tbody .act-del').forEach(el=> el.addEventListener('click', (e)=>{
    const id = e.target.dataset.id;
    const row = state.rows.find(r=>r.id===id);
    if(row) markAndDelete([row]);
  }));
}

function updateSelectAll(){
  $('#selectAll').addEventListener('change', (e)=>{
    state.selection.clear();
    if(e.target.checked){
      state.rows.forEach(r=> state.selection.add(r.id));
    }
    renderTable();
  });
}

// --- CSV ---
function exportCSV(rows){
  const header = ['id','created_at','file_path','mime_type','size_bytes','duration_seconds','approved','location_city','location_country','user_agent'];
  const lines = [header.join(',')];
  for(const r of rows){
    const vals = [
      r.id, r.created_at, r.file_path, r.mime_type, r.size_bytes, r.duration_seconds, r.approved,
      r.location_city, r.location_country, r.user_agent ? r.user_agent.replaceAll(',',';') : ''
    ].map(v=> v==null ? '' : String(v).replaceAll('\n',' ').replaceAll('\r',' '));
    lines.push(vals.join(','));
  }
  const blob = new Blob([lines.join('\n')], {type:'text/csv;charset=utf-8'});
  saveAs(blob, `recordings_${Date.now()}.csv`);
}

// --- Descargas ---
async function downloadOne(row){
  if(!row.file_path){ toast('Sin archivo'); return; }
  const { url } = await signedUrl(row.file_path, 300);
  const res = await fetch(url);
  if(!res.ok){ toast('No se pudo descargar'); return; }
  const blob = await res.blob();
  const name = row.file_path.split('/').pop() || `audio_${row.id}`;
  saveAs(blob, name);
}

async function zipSelected(){
  const ids = Array.from(state.selection);
  if(ids.length===0){ toast('No hay seleccionados'); return; }
  const rows = state.rows.filter(r=> ids.includes(r.id) && r.file_path);
  if(rows.length===0){ toast('Los seleccionados no tienen archivo'); return; }

  // Advertencia tamaño estimado
  const total = rows.reduce((a,r)=> a+(r.size_bytes||0), 0);
  if(total > 200*1024*1024){
    const ok = confirm('Estás por descargar más de 200 MB. ¿Continuar?');
    if(!ok) return;
  }

  const zip = new JSZip();
  for(const r of rows){
    try{
      const { url } = await signedUrl(r.file_path, 360);
      const res = await fetch(url);
      if(!res.ok) continue;
      const blob = await res.blob();
      const name = r.file_path.split('/').pop() || `audio_${r.id}`;
      zip.file(name, blob);
    }catch(e){ console.warn('fallo descargando', r.file_path, e); }
  }
  const out = await zip.generateAsync({type:'blob'});
  saveAs(out, `audios_${Date.now()}.zip`);
}

// --- Marcar (approved=false) y borrar del Storage ---
async function markAndDelete(rows){
  if(rows.length===0){ toast('Nada seleccionado'); return; }
  const msg = `Vas a MARCAR (approved=false) y BORRAR del storage ${rows.length} audio(s).\n`+
              `Esta acción libera espacio y es irreversible.\n\n`+
              `Confirma escribiendo: SI, QUIERO BORRAR`;
  const conf = prompt(msg);
  if(conf!=='SI, QUIERO BORRAR'){ toast('Cancelado'); return; }

  const ids = rows.map(r=>r.id);
  const files = rows.map(r=>r.file_path).filter(Boolean).map(p=> p.startsWith(PREFIX)?p:`${PREFIX}${p}`);

  // 1) marcar en DB
  const { error: e1 } = await sb.from('recordings').update({ approved:false }).in('id', ids);
  if(e1){ toast('Error al marcar'); console.error(e1); return; }

  // 2) borrar en storage (tu policy exige approved=false)
  let delErr = null;
  if(files.length){
    const { error: e2 } = await sb.storage.from(BUCKET).remove(files);
    delErr = e2 || null;
  }

  if(delErr){
    toast('Marcados, pero algunos archivos NO se borraron');
    console.warn('delete errors', delErr);
  }else{
    toast('Marcados y borrados');
  }
  loadPage(state.page);
}

// --- Acciones masivas ---
function rowsFromSelection(){
  const ids = new Set(Array.from(state.selection));
  return state.rows.filter(r=> ids.has(r.id));
}

function wire(){
  $('#btnApply').onclick = ()=> loadPage(1);
  $('#btnClear').onclick = ()=>{
    ['fText','fDateFrom','fDateTo','fMime','fDurMin','fDurMax','fSizeMin','fSizeMax','fCountry','fCity'].forEach(id=> $('#'+id).value='');
    $('#fApproved').value='all';
    $('#fHasTranscript').value='all';
    $('#fStorageState').value='skip';
    $('#sortBy').value='created_at.desc';
    $('#pageSize').value='50';
    loadPage(1);
  };
  $('#prevPage').onclick = ()=> loadPage(Math.max(1, state.page-1));
  $('#nextPage').onclick = ()=> loadPage(state.page+1);
  updateSelectAll();

  $('#btnZip').onclick = ()=> zipSelected();
  $('#btnExportCSV').onclick = ()=> exportCSV(rowsFromSelection().length ? rowsFromSelection() : state.rows);
  $('#btnMarkDelete').onclick = ()=>{
    const rows = rowsFromSelection();
    if(rows.length===0){ toast('Primero selecciona filas'); return; }
    markAndDelete(rows);
  };
}

window.addEventListener('DOMContentLoaded', ()=>{
  if(gate()){
    wire();
    loadPage(1);
  }else{
    // Si pasa por el gate con clave mala, wire se arma al entrar
  }
});
