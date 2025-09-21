/***** CONFIGURACIÓN SUPABASE *****/
const SUPABASE_URL = 'https://kozwtpgopvxrvkbvsaeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtvend0cGdvcHZ4cnZrYnZzYWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgwNDU0NDAsImV4cCI6MjA3MzYyMTQ0MH0.VhF49ygm9y5LN5Fkd1INGJB9aqJjbn8cd3LjaRiT5o8';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/***** PARÁMETROS DE RADIO *****/
const INITIAL_POOL_LIMIT = 500;   // cuántos metadatos traemos inicialmente
const QUEUE_TARGET = 10;          // tamaño objetivo de la cola
const REFILL_AT = 2;              // cuando queden <=2, pedimos más
const FETCH_BATCH = 10;           // cuántos agregamos por recarga
const PRELOAD_AHEAD = 2;          // cuántos pre-cargamos por delante
const RECENT_WINDOW = 20;         // no repetir dentro de los últimos 20
const KEEPALIVE_MINUTES = 12;     // ping periódico a Supabase
const QUERY_RETRY_MS = 2500;      // sleep ante error y reintenta

/***** UI *****/
const $ = (s)=>document.querySelector(s);
const playBtn = $('#playBtn');
const skipBtn = $('#skipBtn');
const statusEl = $('#status');
const queueInfo = $('#queueInfo');
const playedInfo = $('#playedInfo');
const preloadInfo = $('#preloadInfo');
const audioEl = $('#radioAudio');

/***** ESTADO *****/
let metaPool = [];           // metadatos (candidatos reproducibles)
let queue = [];              // cola actual: [{path, mime, url, duration_seconds}, ...]
let preloaded = [];          // audios precargados (Audio objects alineados con cola)
let recently = [];           // file_paths de últimos reproducidos
let playing = false;         // bandera general
let playedCount = 0;         // cuántos hemos reproducido en total
let wakeLock = null;         // wake lock handler
let isAdvancing = false;     // evita carreras al saltar/terminar

/***** UTILIDADES *****/
function updateBadges(){
  queueInfo.textContent = `Cola: ${queue.length}`;
  playedInfo.textContent = `Reproducidos: ${playedCount}`;
  preloadInfo.textContent = `Precargados: ${preloaded.length}`;
}
function setStatus(t){ statusEl.textContent = t; }

function canPlayRow(row){
  const mime = (row.mime_type||'').toLowerCase();
  const path = (row.file_path||'').toLowerCase();
  const test = document.createElement('audio');

  // iOS solo m4a/mp4 generalmente
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  if (isiOS){
    if (mime.includes('mp4') || path.endsWith('.m4a') || path.endsWith('.mp4')) {
      return !!(test.canPlayType('audio/mp4') || test.canPlayType('audio/aac'));
    }
    return false;
  }

  // Desktop Chrome/Edge aceptan m4a/mp4 y webm
  if (mime.includes('mp4') || path.endsWith('.m4a') || path.endsWith('.mp4')){
    if (test.canPlayType('audio/mp4') || test.canPlayType('audio/aac')) return true;
  }
  if (mime.includes('webm') || path.endsWith('.webm')){
    if (test.canPlayType('audio/webm; codecs="opus"') || test.canPlayType('audio/webm')) return true;
  }
  return false;
}

function shuffleInPlace(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
}

function rememberRecently(path){
  recently.push(path);
  if (recently.length > RECENT_WINDOW) recently.shift();
}

function notRecently(path){
  return !recently.includes(path);
}

function publicUrlFor(path){
  const { data } = sb.storage.from('audios').getPublicUrl(path);
  return data?.publicUrl || null;
}

/***** SUPABASE QUERIES *****/
async function fetchMeta(limit = INITIAL_POOL_LIMIT){
  // Solo aprobados
  const { data, error } = await sb
    .from('recordings')
    .select('file_path,mime_type,duration_seconds,created_at,approved')
    .eq('approved', true)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function refillMetaPoolIfNeeded(minNeeded = FETCH_BATCH){
  if (metaPool.length >= minNeeded) return;
  try{
    setStatus('Cargando catálogo…');
    const incoming = await fetchMeta(INITIAL_POOL_LIMIT);
    const playable = incoming.filter(canPlayRow);
    shuffleInPlace(playable);
    // añadimos al pool (no pasa nada si hay duplicados, filtramos por ventana luego)
    metaPool = metaPool.concat(playable);
    setStatus('Catálogo listo.');
  }catch(e){
    console.error(e);
    setStatus('Error cargando catálogo. Reintentando…');
    await new Promise(r=>setTimeout(r, QUERY_RETRY_MS));
    return refillMetaPoolIfNeeded(minNeeded);
  }
}

/***** COLA *****/
function pickRandomFromPool(n){
  const picked = [];
  let tries = 0;
  // Primero intentamos respetar ventana anti-repetición
  while (picked.length < n && tries < metaPool.length*2){
    const item = metaPool[Math.floor(Math.random()*metaPool.length)];
    if (!item) break;
    if (notRecently(item.file_path)) picked.push(item);
    tries++;
  }
  // Si no alcanzó, permitimos repetidos
  while (picked.length < n){
    const item = metaPool[Math.floor(Math.random()*metaPool.length)];
    if (!item) break;
    picked.push(item);
  }
  return picked;
}

async function ensureQueueHas(target = QUEUE_TARGET){
  if (queue.length >= target) return;

  // Asegura pool
  await refillMetaPoolIfNeeded(FETCH_BATCH);

  // Selecciona candidatos
  const add = pickRandomFromPool(Math.min(FETCH_BATCH, target - queue.length));

  // Mapea a objetos de cola con URL pública
  for (const row of add){
    const url = publicUrlFor(row.file_path);
    if (!url) continue;
    queue.push({
      path: row.file_path,
      mime: row.mime_type,
      url,
      duration_seconds: row.duration_seconds || null,
    });
  }
  updateBadges();
}

/***** PRELOAD *****/
function clearPreloaded(){
  for (const a of preloaded){
    try{ a.src=''; a.removeAttribute('src'); a.load(); }catch(_){}
  }
  preloaded = [];
}
function preloadAhead(){
  clearPreloaded();
  for (let i=0; i<Math.min(PRELOAD_AHEAD, queue.length); i++){
    const tr = queue[i];
    try{
      const a = new Audio();
      a.preload = 'auto';
      a.src = tr.url;
      a.load();
      preloaded.push(a);
    }catch(_){}
  }
  updateBadges();
}

/***** CONTROL DE REPRODUCCIÓN *****/
async function acquireWakeLock(){
  try{
    if ('wakeLock' in navigator){
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', ()=>{ /* opcional log */ });
    }
  }catch(_){}
}
function releaseWakeLock(){
  try{ wakeLock && wakeLock.release && wakeLock.release(); }catch(_){}
  wakeLock = null;
}

// Re-solicitar wake lock al volver a primer plano
document.addEventListener('visibilitychange', ()=>{
  if (document.visibilityState === 'visible' && playing){
    acquireWakeLock();
  }
});

async function playNext(auto=false){
  if (isAdvancing) return;
  isAdvancing = true;

  try{
    if (queue.length === 0){
      await ensureQueueHas(QUEUE_TARGET);
      if (queue.length === 0){
        setStatus('No hay audios disponibles.');
        isAdvancing = false;
        return;
      }
    }

    // Si estamos bajos, recargar en background
    if (queue.length <= REFILL_AT){
      ensureQueueHas(QUEUE_TARGET).catch(()=>{/* background */});
    }

    // Toma siguiente
    const track = queue.shift();
    updateBadges();

    // Preload siguientes
    preloadAhead();

    // Asignar y reproducir
    audioEl.src = track.url;
    audioEl.preload = 'auto';

    // Intento de autoplay tras gesto inicial
    await audioEl.play();

    // Contadores / estado
    setStatus('Reproduciendo…');
    skipBtn.disabled = false;
    playing = true;

    // Registrar como “recently”
    rememberRecently(track.path);
    playedCount++;
    updateBadges();

  }catch(e){
    console.error('Error al reproducir, saltando…', e);
    setStatus('Error en pista, saltando…');
    // Saltar tras breve pausa
    setTimeout(()=> playNext(true), 300);
  }finally{
    isAdvancing = false;
  }
}

function pauseRadio(){
  try{ audioEl.pause(); }catch(_){}
  playing = false;
  setStatus('Pausado.');
  skipBtn.disabled = true;
  releaseWakeLock();
}

/***** EVENTOS UI *****/
playBtn.addEventListener('click', async ()=>{
  if (!playing){
    playBtn.textContent = '⏸︎ Pause';
    playBtn.setAttribute('aria-pressed','true');
    await acquireWakeLock();
    await ensureQueueHas(QUEUE_TARGET);
    preloadAhead();
    await playNext();
    // keep alive
    scheduleKeepAlive();
  } else {
    playBtn.textContent = '▶︎ Play';
    playBtn.setAttribute('aria-pressed','false');
    pauseRadio();
  }
});

skipBtn.addEventListener('click', ()=>{
  // Saltar inmediatamente
  try{ audioEl.pause(); }catch(_){}
  playNext(true);
});

/***** ENCADENADO *****/
audioEl.addEventListener('ended', ()=> playNext(true));
audioEl.addEventListener('error', ()=> playNext(true));

/***** KEEP-ALIVE SUPABASE *****/
let keepAliveTimer = null;
function scheduleKeepAlive(){
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(async ()=>{
    try{
      // consulta HEAD con count, rápida y ligera
      await sb.from('recordings').select('file_path', { count: 'exact', head: true }).eq('approved', true);
    }catch(_){}
  }, KEEPALIVE_MINUTES * 60 * 1000);
}

/***** ARRANQUE *****/
document.addEventListener('DOMContentLoaded', async ()=>{
  updateBadges();
  setStatus('Listo. Presiona Play para iniciar.');
  skipBtn.disabled = true;
});
