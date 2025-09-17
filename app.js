/***** CONFIGURACIÓN *****/
const SUPABASE_URL = 'https://kozwtpgopvxrvkbvsaeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtvend0cGdvcHZ4cnZrYnZzYWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgwNDU0NDAsImV4cCI6MjA3MzYyMTQ0MH0.VhF49ygm9y5LN5Fkd1INGJB9aqJjbn8cd3LjaRiT5o8';

const MAX_SECONDS = 30;
const MAX_BYTES = 2.5 * 1024 * 1024; // 2.5 MB

// Proveedores IP (gratis). Se usan sin claves (tienen límites diarios razonables).
const IP_PROVIDERS = [
  'https://ipapi.co/json/',
  'https://ipwho.is/'
];

/***** CLIENTE SUPABASE *****/
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/***** UTILIDADES UI *****/
const $ = (sel) => document.querySelector(sel);
const showToast = (msg) => {
  const t = $('#toast'); if(!t) return;
  t.textContent = msg; t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), 2600);
};
const showSpinner = (on=true) => {
  const s = $('#spinner'); if(!s) return;
  s.classList.toggle('hidden', !on);
};

/***** RANDOM EMOJIS *****/
const EMOJIS = [': D', ': )', ': |', ': (', ":’(", ': S'];
const pickEmoji = () => EMOJIS[Math.floor(Math.random()*EMOJIS.length)];

/***** GEO POR IP *****/
async function getGeoByIP() {
  for (const url of IP_PROVIDERS) {
    try {
      const r = await fetch(url, {cache:'no-store'});
      if (!r.ok) continue;
      const j = await r.json();
      // Normalizar campos
      if (j && (j.city || j.country || j.region || j.ip)) {
        return {
          ip: j.ip || j.query || null,
          city: j.city || null,
          region: j.region || j.regionName || null,
          country: j.country || j.country_name || j.countryCode || null
        };
      }
    } catch(e){ /* try next */ }
  }
  return { ip:null, city:null, region:null, country:null };
}

/***** TRANSCRIPCIÓN (Web Speech API si existe) *****/
function createSpeechRecognition(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR) return null;
  const rec = new SR();
  rec.lang = 'es-MX';
  rec.interimResults = true;
  rec.continuous = true;
  return rec;
}

/***** DETECCIÓN MIME MediaRecorder *****/
function pickSupportedMime(){
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/mp4',               // iOS Safari (varía por versión)
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mpeg'               // rara vez soportado por MediaRecorder
  ];
  for (const t of candidates){
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
  }
  // último recurso, que a veces funciona por defecto
  return 'audio/webm';
}

function extensionFromMime(mime){
  if(!mime) return 'webm';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4'))  return 'mp4';
  if (mime.includes('m4a'))  return 'm4a';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('ogg'))  return 'ogg';
  if (mime.includes('wav'))  return 'wav';
  return 'webm';
}

/***** PAGE ROUTER *****/
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (page === 'record') initRecordPage();
  if (page === 'listen') initListenPage();
});

/***********************
 * PÁGINA: GRABAR
 ***********************/
async function initRecordPage(){
  // Emoji inicial
  const emojiDisplay = $('#emojiDisplay');
  emojiDisplay.textContent = pickEmoji();

  const recordBtn = $('#recordBtn');
  const recordBtnText = $('#recordBtnText');
  const counter = $('#counter');
  const preview = $('#preview');
  const player = $('#player');
  const redoBtn = $('#redoBtn');
  const sendBtn = $('#sendBtn');
  const micOverlay = $('#micOverlay');
  const enableMicBtn = $('#enableMicBtn');

  let stream = null;
  let mediaRecorder = null;
  let chunks = [];
  let startTs = 0;
  let durationMs = 0;
  let blob = null;
  let mimeType = pickSupportedMime();
  let transcript = null;
  let speechRec = null;
  let stopTimer = null;

  // Pedir micrófono al cargar. Si el navegador exige gesto, mostramos overlay.
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:true});
  } catch (e) {
    micOverlay.classList.remove('hidden');
  }

  enableMicBtn?.addEventListener('click', async ()=>{
    try{
      stream = await navigator.mediaDevices.getUserMedia({audio:true});
      micOverlay.classList.add('hidden');
      showToast('Micrófono habilitado');
    }catch(e){
      showToast('Permiso de micrófono rechazado');
    }
  });

  function updateCounter(){
    const secs = Math.min(MAX_SECONDS, Math.floor((Date.now()-startTs)/1000));
    const s = (n)=> n<10? '0'+n : ''+n;
    counter.textContent = `0:${s(secs)} / 0:${s(MAX_SECONDS)}`;
  }

  function startSpeech(){
    speechRec = createSpeechRecognition();
    if(!speechRec){ transcript = null; return; }
    transcript = '';
    speechRec.onresult = (ev)=>{
      for (let i = ev.resultIndex; i < ev.results.length; i++){
        const res = ev.results[i];
        if (res.isFinal) transcript += (transcript ? ' ' : '') + res[0].transcript.trim();
      }
    };
    speechRec.onerror = ()=>{}; // silencioso
    try { speechRec.start(); } catch(e){}
  }
  function stopSpeech(){
    try{ speechRec && speechRec.stop(); }catch(e){}
  }

  function resetUI(){
    recordBtn.setAttribute('aria-pressed','false');
    recordBtn.classList.remove('btn-recording');
    recordBtn.classList.add('btn-record');
    recordBtnText.textContent = 'Grabar';
    counter.textContent = `0:00 / 0:${MAX_SECONDS<10?'0':''}${MAX_SECONDS}`;
    preview.classList.add('hidden');
    player.removeAttribute('src');
    blob = null; chunks = [];
    transcript = null; durationMs = 0;
    emojiDisplay.textContent = pickEmoji();
  }
  resetUI();

  function onDataAvailable(e){
    if (e.data && e.data.size > 0) chunks.push(e.data);
  }

  function stopRecording(reason='user'){
    if (!mediaRecorder) return;
    try{ mediaRecorder.stop(); }catch(e){}
    if (stopTimer){ clearTimeout(stopTimer); stopTimer = null; }
    stopSpeech();
    durationMs = Date.now() - startTs;
  }

  recordBtn.addEventListener('click', async ()=>{
    if (!stream){
      showToast('No hay permiso de micrófono');
      micOverlay.classList.remove('hidden');
      return;
    }
    if (mediaRecorder && mediaRecorder.state === 'recording'){
      stopRecording('user');
      return;
    }

    // Iniciar grabación
    chunks = [];
    blob = null;
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = onDataAvailable;
    mediaRecorder.onstop = ()=>{
      blob = new Blob(chunks, { type: mimeType });
      if (blob.size > MAX_BYTES){
        showToast('El archivo excede el tamaño permitido');
        resetUI();
        return;
      }
      // Previsualización
      const url = URL.createObjectURL(blob);
      player.src = url;
      preview.classList.remove('hidden');
      recordBtn.setAttribute('aria-pressed','false');
      recordBtnText.textContent = 'Grabar';
    };
    mediaRecorder.start();
    startTs = Date.now();
    recordBtn.setAttribute('aria-pressed','true');
    recordBtn.classList.add('btn-recording');
    recordBtnText.textContent = 'Grabando…';

    startSpeech();

    // contador
    const int = setInterval(()=>{
      if (mediaRecorder?.state !== 'recording') { clearInterval(int); return; }
      updateCounter();
    }, 200);

    // corte automático a 30s
    stopTimer = setTimeout(()=> stopRecording('auto'), MAX_SECONDS*1000);
  });

  redoBtn.addEventListener('click', ()=>{
    resetUI();
  });

  sendBtn.addEventListener('click', async ()=>{
    if (!blob){
      showToast('No hay audio para enviar');
      return;
    }
    showSpinner(true);
    try{
      const ext = extensionFromMime(mimeType);
      const id = crypto.randomUUID();
      const path = `recordings/${id}.${ext}`;

      // Geo e IP (no bloqueante si falla)
      const geo = await getGeoByIP().catch(()=>({}));

      // Subir a Storage
      const { error: upErr } = await sb.storage.from('audios')
        .upload(path, blob, { contentType: mimeType, upsert: false });
      if (upErr) throw upErr;

      // Insert en tabla
      const { error: insErr } = await sb.from('recordings').insert([{
        file_path: path,
        mime_type: mimeType,
        size_bytes: blob.size,
        duration_seconds: Math.min(MAX_SECONDS, Math.round(durationMs/1000)),
        transcript: transcript || null,
        ip: geo.ip || null,
        location_city: geo.city || null,
        location_region: geo.region || null,
        location_country: geo.country || null,
        user_agent: navigator.userAgent || null,
        approved: true
      }]);
      if (insErr) throw insErr;

      showToast('¡Enviado con éxito!');
      // Redirige a escuchar
      setTimeout(()=> { window.location.href = './escuchar.html'; }, 600);
    }catch(e){
      console.error(e);
      showToast('Error al enviar. Reintenta.');
    }finally{
      showSpinner(false);
    }
  });
}

/***********************
 * PÁGINA: ESCUCHAR
 ***********************/
function initListenPage(){
  const list = $('#audioList');
  const loading = $('#loadingAudios');
  const moreBtn = $('#moreBtn');

  const shown = new Set();
  let cache = [];    // caché local de filas traídas
  const BATCH_FETCH = 30; // traemos 30 recientes y muestreamos 6 al azar

  const publicUrl = (file_path)=>{
    const { data } = sb.storage.from('audios').getPublicUrl(file_path);
    return data?.publicUrl || null;
  };

  function sampleRandom(arr, k){
    const a = [...arr];
    for (let i=a.length-1; i>0; i--){
      const j = Math.floor(Math.random()*(i+1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, k);
  }

  async function fetchCache(){
    const { data, error } = await sb
      .from('recordings')
      .select('file_path,duration_seconds,created_at')
      .order('created_at', { ascending: false })
      .limit(BATCH_FETCH);
    if (error){ console.error(error); showToast('Error cargando audios'); return []; }
    return data || [];
  }

  function renderAudios(rows){
    for (const r of rows){
      if (shown.has(r.file_path)) continue;
      const url = publicUrl(r.file_path);
      if (!url) continue;
      const wrapper = document.createElement('div');
      const aud = document.createElement('audio');
      aud.controls = true;
      aud.preload = 'none';
      aud.src = url;
      wrapper.appendChild(aud);
      list.appendChild(wrapper);
      shown.add(r.file_path);
    }
  }

  async function loadMore(k=6){
    loading.classList.remove('hidden');

    // Asegurar caché
    if (cache.length === 0){
      cache = await fetchCache();
    }

    // Filtrar no vistos y muestrear
    let candidates = cache.filter(r => !shown.has(r.file_path));
    if (candidates.length < k){
      // refrescar caché
      const fresh = await fetchCache();
      // Merge evitando duplicados
      const map = new Map(cache.map(r => [r.file_path, r]));
      for (const r of fresh){ map.set(r.file_path, r); }
      cache = [...map.values()];
      candidates = cache.filter(r => !shown.has(r.file_path));
    }

    const pick = sampleRandom(candidates, k);
    renderAudios(pick);

    loading.classList.add('hidden');
  }

  // Init
  (async ()=>{
    await loadMore(6);
  })();

  moreBtn.addEventListener('click', async ()=> { await loadMore(6); });
}

