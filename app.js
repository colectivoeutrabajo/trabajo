/***** CONFIGURACIÓN *****/
const SUPABASE_URL = 'https://kozwtpgopvxrvkbvsaeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtvend0cGdvcHZ4cnZrYnZzYWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgwNDU0NDAsImV4cCI6MjA3MzYyMTQ0MH0.VhF49ygm9y5LN5Fkd1INGJB9aqJjbn8cd3LjaRiT5o8';

const MAX_SECONDS = 30;
const MAX_BYTES = 2.5 * 1024 * 1024; // 2.5 MB
const LONG_PRESS_MS = 250; // Umbral para long-press estilo WhatsApp

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

/***** DETECCIÓN DE PLATAFORMA *****/
function isIOS(){
  // iPhone/iPad/iPod
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

/***** GEO POR IP *****/
async function getGeoByIP() {
  for (const url of IP_PROVIDERS) {
    try {
      const r = await fetch(url, {cache:'no-store'});
      if (!r.ok) continue;
      const j = await r.json();
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
  // Deshabilitar en iOS por UX (evitar prompts extra del sistema)
  if (isIOS()) return null;
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
  // Priorizar audio/mp4 en iOS; webm opus en otros
  const iosFirst = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const generic  = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  const candidates = isIOS() ? iosFirst : generic;
  for (const t of candidates){
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
  }
  return isIOS() ? 'audio/mp4' : 'audio/webm';
}

function extensionFromMime(mime){
  if(!mime) return isIOS() ? 'm4a' : 'webm';
  if (mime.includes('mp4'))  return 'm4a';   // audio/mp4 -> .m4a
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('m4a'))  return 'm4a';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('ogg'))  return 'ogg';
  if (mime.includes('wav'))  return 'wav';
  return isIOS() ? 'm4a' : 'webm';
}

/***** PERMISOS DE MICRÓFONO *****/
async function isMicGranted(){
  try{
    if (!navigator.permissions) return null; // no soportado (iOS Safari)
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state === 'granted';
  }catch(e){ return null; }
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
  // Emoji inicial + rotación cada 4s
  const emojiDisplay = $('#emojiDisplay');
  const recordBtn = $('#recordBtn');
  const recordBtnText = $('#recordBtnText');
  const counter = $('#counter');
  const preview = $('#preview');
  const player = $('#player');
  const redoBtn = $('#redoBtn');
  const sendBtn = $('#sendBtn');
  const micOverlay = $('#micOverlay');
  const enableMicBtn = $('#enableMicBtn');

  emojiDisplay.textContent = pickEmoji();
  let emojiTimer = setInterval(()=> { emojiDisplay.textContent = pickEmoji(); }, 4000);
  const pauseEmoji = ()=> { if (emojiTimer){ clearInterval(emojiTimer); emojiTimer=null; } };
  const resumeEmoji = ()=> { if (!emojiTimer){ emojiTimer = setInterval(()=> { emojiDisplay.textContent = pickEmoji(); }, 4000); } };

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

  // Intento de permiso: si ya está granted no pedimos otra vez
  const granted = await isMicGranted();
  if (granted === true) {
    try { stream = await navigator.mediaDevices.getUserMedia({audio:true}); } catch(e){}
  } else {
    // En iOS mostramos overlay para gesto de usuario; en otros intentamos al cargar
    try {
      if (!isIOS()) {
        stream = await navigator.mediaDevices.getUserMedia({audio:true});
      } else {
        micOverlay.classList.remove('hidden');
      }
    } catch (e) {
      micOverlay.classList.remove('hidden');
    }
  }

  enableMicBtn?.addEventListener('click', async ()=>{
    try{
      if (!stream) stream = await navigator.mediaDevices.getUserMedia({audio:true});
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
    player.load();
    blob = null; chunks = [];
    transcript = null; durationMs = 0;
    // Mostrar botón grabar
    recordBtn.classList.remove('hidden');
    recordBtn.style.display = '';
    // Reanudar emojis
    resumeEmoji();
    // Restablecer hint de playsinline (no visible, pero ok)
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

  async function startRecordingIfNeeded(){
    if (!stream){
      try{
        stream = await navigator.mediaDevices.getUserMedia({audio:true});
      }catch(e){
        showToast('No hay permiso de micrófono');
        micOverlay.classList.remove('hidden');
        return false;
      }
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') return true;

    // Iniciar grabación
    chunks = [];
    blob = null;
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = onDataAvailable;
    mediaRecorder.onstop = ()=>{
      blob = new Blob(chunks, { type: mimeType });
      // Manejar blob vacío (bug ocasional iOS)
      if (!blob || blob.size === 0) {
        showToast('No se capturó audio. Intenta de nuevo.');
        resetUI();
        return;
      }
      if (blob.size > MAX_BYTES){
        showToast('El archivo excede el tamaño permitido');
        resetUI();
        return;
      }
      // Previsualización: mostrar cuando el audio esté listo
      const url = URL.createObjectURL(blob);
      player.setAttribute('playsinline','true'); // iOS
      player.src = url;
      const onReady = () => {
        player.removeEventListener('canplaythrough', onReady);
        preview.classList.remove('hidden');
        // Ocultar botón Grabar hasta "Grabar de nuevo"
        recordBtn.classList.add('hidden');
        recordBtn.style.display = 'none';
        recordBtn.setAttribute('aria-pressed','false');
        recordBtnText.textContent = 'Grabar';
      };
      player.addEventListener('canplaythrough', onReady, { once:true });
      // En caso de que nunca dispare canplaythrough, mostramos tras un fallback corto
      setTimeout(()=> {
        if (preview.classList.contains('hidden')) onReady();
      }, 800);
    };
    mediaRecorder.start();
    startTs = Date.now();
    recordBtn.setAttribute('aria-pressed','true');
    recordBtn.classList.add('btn-recording');
    recordBtnText.textContent = 'Grabando…';

    // Pausar emoji durante grabación
    pauseEmoji();

    startSpeech();

    // contador
    const int = setInterval(()=>{
      if (mediaRecorder?.state !== 'recording') { clearInterval(int); return; }
      updateCounter();
    }, 200);

    // corte automático a 30s
    stopTimer = setTimeout(()=> stopRecording('auto'), MAX_SECONDS*1000);
    return true;
  }

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
      // Reanudar emoji por si el usuario regresa
      resumeEmoji();
      // Redirige a escuchar
      setTimeout(()=> { window.location.href = './escuchar.html'; }, 600);
    }catch(e){
      console.error(e);
      showToast('Error al enviar. Reintenta.');
    }finally{
      showSpinner(false);
    }
  });

  /***** BOTÓN con TAP y LONG-PRESS estilo WhatsApp *****/
  let pressTimer = null;
  let pressStartedAt = 0;
  let longPressActive = false;

  function clearPressTimer(){
    if (pressTimer){ clearTimeout(pressTimer); pressTimer = null; }
  }

  recordBtn.addEventListener('pointerdown', async (e)=>{
    e.preventDefault();
    longPressActive = false;
    pressStartedAt = Date.now();
    clearPressTimer();
    pressTimer = setTimeout(async ()=>{
      longPressActive = true;
      await startRecordingIfNeeded();
    }, LONG_PRESS_MS);
  });

  const endPress = async ()=>{
    const delta = Date.now() - pressStartedAt;
    clearPressTimer();
    if (longPressActive){
      // long-press: detener al soltar
      if (mediaRecorder?.state === 'recording') stopRecording('hold');
      longPressActive = false;
    } else {
      // tap corto
      if (delta < LONG_PRESS_MS){
        if (mediaRecorder?.state === 'recording') {
          stopRecording('tap');
        } else {
          await startRecordingIfNeeded();
        }
      }
    }
  };

  recordBtn.addEventListener('pointerup', async (e)=>{ e.preventDefault(); await endPress(); });
  recordBtn.addEventListener('pointercancel', async (e)=>{ e.preventDefault(); await endPress(); });
  recordBtn.addEventListener('pointerleave', async (e)=>{ if (longPressActive){ await endPress(); } });

}

/***********************
 * PÁGINA: ESCUCHAR
 ***********************/
function initListenPage(){
  const list = $('#audioList');
  const loading = $('#loadingAudios');
  const moreBtn = $('#moreBtn');

  // Siempre cargaremos 6 por lote, permitiendo repetidos entre lotes
  const BATCH_FETCH = 30; // traemos 30 recientes y muestreamos 6 al azar

  const publicUrl = (file_path)=>{
    const { data } = sb.storage.from('audios').getPublicUrl(file_path);
    return data?.publicUrl || null;
  };

  function sampleRandomUnique(arr, k, keyFn){
    // Barajar y tomar los primeros k con clave única dentro del mismo lote
    const a = [...arr];
    for (let i=a.length-1; i>0; i--){
      const j = Math.floor(Math.random()*(i+1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    const seen = new Set();
    const out = [];
    for (const it of a){
      const key = keyFn ? keyFn(it) : JSON.stringify(it);
      if (!seen.has(key)){
        seen.add(key);
        out.push(it);
        if (out.length >= k) break;
      }
    }
    return out;
  }

  async function fetchBatch(){
    // Cargar recientes (cliente hará el muestreo aleatorio)
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
      const url = publicUrl(r.file_path);
      if (!url) continue;
      const wrapper = document.createElement('div');
      const aud = document.createElement('audio');
      aud.controls = true;
      aud.preload = 'auto';   // precargar al entrar
      aud.playsInline = true; // iOS
      aud.src = url;
      wrapper.appendChild(aud);
      list.appendChild(wrapper);
      // Fuerza el inicio de la carga
      try { aud.load(); } catch(e){}
    }
  }

  async function loadSix(){
    loading.classList.remove('hidden');
    const batch = await fetchBatch();
    const pick = sampleRandomUnique(batch, 6, (x)=> x.file_path);
    renderAudios(pick);
    loading.classList.add('hidden');
  }

  // Init
  (async ()=>{ await loadSix(); })();

  moreBtn.addEventListener('click', async ()=> { await loadSix(); });
}
