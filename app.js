/***** CONFIGURACIÓN *****/
const SUPABASE_URL = 'https://kozwtpgopvxrvkbvsaeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtvend0cGdvcHZ4cnZrYnZzYWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgwNDU0NDAsImV4cCI6MjA3MzYyMTQ0MH0.VhF49ygm9y5LN5Fkd1INGJB9aqJjbn8cd3LjaRiT5o8';

const MAX_SECONDS = 30;
const MAX_BYTES = 2.5 * 1024 * 1024; // 2.5 MB
const LONG_PRESS_MS = 250; // Umbral para long-press estilo WhatsApp

// Proveedores IP (gratis)
const IP_PROVIDERS = ['https://ipapi.co/json/', 'https://ipwho.is/'];

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

/***** EMOJIS *****/
const EMOJIS = [': D', ': )', ': |', ': (', ":’(", ': S'];
const pickEmoji = () => EMOJIS[Math.floor(Math.random()*EMOJIS.length)];

/***** PLATAFORMA *****/
function isIOS(){ return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream; }

/***** GEO POR IP *****/
async function getGeoByIP() {
  for (const url of IP_PROVIDERS) {
    try {
      const r = await fetch(url, {cache:'no-store'});
      if (!r.ok) continue;
      const j = await r.json();
      if (j && (j.city || j.country || j.region || j.ip)) {
        return { ip: j.ip || j.query || null, city: j.city || null, region: j.region || j.regionName || null, country: j.country || j.country_name || j.countryCode || null };
      }
    } catch(e){}
  }
  return { ip:null, city:null, region:null, country:null };
}

/***** TRANSCRIPCIÓN (deshabilitada en iOS) *****/
function createSpeechRecognition(){
  if (isIOS()) return null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR) return null;
  const rec = new SR();
  rec.lang = 'es-MX'; rec.interimResults = true; rec.continuous = true;
  return rec;
}

/***** MIME/EXT *****/
function pickSupportedMime(){
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
  if (mime.includes('mp4'))  return 'm4a';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('m4a'))  return 'm4a';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('ogg'))  return 'ogg';
  if (mime.includes('wav'))  return 'wav';
  return isIOS() ? 'm4a' : 'webm';
}

/***** PERMISOS MIC *****/
async function isMicGranted(){
  try{
    if (!navigator.permissions) return null;
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state === 'granted';
  }catch(e){ return null; }
}

/***** ROUTER *****/
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (page === 'record') initRecordPage();
  if (page === 'listen') initListenPage();
});

/***********************
 * GRABAR
 ***********************/
async function initRecordPage(){
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

  let stream = null, mediaRecorder = null, chunks = [];
  let startTs = 0, durationMs = 0, blob = null;
  let mimeType = pickSupportedMime();
  let transcript = null, speechRec = null, stopTimer = null;

  // Permiso mic
  const granted = await isMicGranted();
  if (granted === true) {
    try { stream = await navigator.mediaDevices.getUserMedia({audio:true}); } catch(e){}
  } else {
    try {
      if (!isIOS()) stream = await navigator.mediaDevices.getUserMedia({audio:true});
      else micOverlay.classList.remove('hidden');
    } catch (e) { micOverlay.classList.remove('hidden'); }
  }

  enableMicBtn?.addEventListener('click', async ()=>{
    try{
      if (!stream) stream = await navigator.mediaDevices.getUserMedia({audio:true});
      micOverlay.classList.add('hidden');
      showToast('Micrófono habilitado');
    }catch(e){ showToast('Permiso de micrófono rechazado'); }
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
    speechRec.onerror = ()=>{};
    try { speechRec.start(); } catch(e){}
  }
  function stopSpeech(){ try{ speechRec && speechRec.stop(); }catch(e){} }

  function resetUI(){
    recordBtn.setAttribute('aria-pressed','false');
    recordBtn.classList.remove('btn-recording');
    recordBtn.classList.add('btn-record');
    recordBtnText.textContent = 'Grabar';
    counter.textContent = `0:00 / 0:${MAX_SECONDS<10?'0':''}${MAX_SECONDS}`;
    preview.classList.add('hidden');
    player.removeAttribute('src'); player.load();
    blob = null; chunks = []; transcript = null; durationMs = 0;
    recordBtn.classList.remove('hidden'); recordBtn.style.display = '';
    resumeEmoji();
  }
  resetUI();

  function onDataAvailable(e){ if (e.data && e.data.size > 0) chunks.push(e.data); }

  function stopRecording(){
    if (!mediaRecorder) return;
    try{ mediaRecorder.stop(); }catch(e){}
    if (stopTimer){ clearTimeout(stopTimer); stopTimer = null; }
    stopSpeech();
    durationMs = Date.now() - startTs;
  }

  async function startRecordingIfNeeded(){
    if (!stream){
      try{ stream = await navigator.mediaDevices.getUserMedia({audio:true}); }
      catch(e){ showToast('No hay permiso de micrófono'); micOverlay.classList.remove('hidden'); return false; }
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') return true;

    chunks = []; blob = null;
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = onDataAvailable;
    mediaRecorder.onstop = ()=>{
      blob = new Blob(chunks, { type: mimeType });
      if (!blob || blob.size === 0){ showToast('No se capturó audio. Intenta de nuevo.'); resetUI(); return; }
      if (blob.size > MAX_BYTES){ showToast('El archivo excede el tamaño permitido'); resetUI(); return; }
      const url = URL.createObjectURL(blob);
      player.setAttribute('playsinline','true');
      player.src = url;
      const onReady = () => {
        player.removeEventListener('canplaythrough', onReady);
        preview.classList.remove('hidden');
        recordBtn.classList.add('hidden'); recordBtn.style.display = 'none';
        recordBtn.setAttribute('aria-pressed','false');
        recordBtnText.textContent = 'Grabar';
      };
      player.addEventListener('canplaythrough', onReady, { once:true });
      setTimeout(()=> { if (preview.classList.contains('hidden')) onReady(); }, 800);
    };
    mediaRecorder.start();
    startTs = Date.now();
    recordBtn.setAttribute('aria-pressed','true');
    recordBtn.classList.add('btn-recording');
    recordBtnText.textContent = 'Grabando…';
    pauseEmoji(); startSpeech();

    const int = setInterval(()=>{ if (mediaRecorder?.state !== 'recording') { clearInterval(int); return; } updateCounter(); }, 200);
    stopTimer = setTimeout(()=> stopRecording(), MAX_SECONDS*1000);
    return true;
  }

  redoBtn.addEventListener('click', ()=>{ resetUI(); });

  sendBtn.addEventListener('click', async ()=>{
    if (!blob){ showToast('No hay audio para enviar'); return; }
    showSpinner(true);
    try{
      const ext = extensionFromMime(mimeType);
      const id = crypto.randomUUID();
      const path = `recordings/${id}.${ext}`;
      const geo = await getGeoByIP().catch(()=>({}));
      const { error: upErr } = await sb.storage.from('audios').upload(path, blob, { contentType: mimeType, upsert: false });
      if (upErr) throw upErr;
      const { error: insErr } = await sb.from('recordings').insert([{
        file_path: path, mime_type: mimeType, size_bytes: blob.size,
        duration_seconds: Math.min(MAX_SECONDS, Math.round(durationMs/1000)),
        transcript: transcript || null,
        ip: geo.ip || null, location_city: geo.city || null, location_region: geo.region || null, location_country: geo.country || null,
        user_agent: navigator.userAgent || null, approved: true
      }]);
      if (insErr) throw insErr;
      showToast('¡Enviado con éxito!');
      resumeEmoji();
      setTimeout(()=> { window.location.href = './escuchar.html'; }, 600);
    }catch(e){ console.error(e); showToast('Error al enviar. Reintenta.'); }
    finally{ showSpinner(false); }
  });

  /***** BOTÓN: tap y long-press *****/
  let pressTimer = null, pressStartedAt = 0, longPressActive = false;
  function clearPressTimer(){ if (pressTimer){ clearTimeout(pressTimer); pressTimer = null; } }

  recordBtn.addEventListener('contextmenu', (e)=> e.preventDefault()); // evitar menú iOS
  recordBtn.addEventListener('pointerdown', async (e)=>{
    e.preventDefault();
    try { e.target.setPointerCapture(e.pointerId); } catch(_) {}
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
      if (mediaRecorder?.state === 'recording') stopRecording();
      longPressActive = false;
    } else {
      if (delta < LONG_PRESS_MS){
        if (mediaRecorder?.state === 'recording') stopRecording();
        else await startRecordingIfNeeded();
      }
    }
  };
  recordBtn.addEventListener('pointerup', async (e)=>{ e.preventDefault(); await endPress(); });
  recordBtn.addEventListener('pointercancel', async (e)=>{ e.preventDefault(); await endPress(); });
  recordBtn.addEventListener('pointerleave', async (e)=>{ if (longPressActive){ await endPress(); }
