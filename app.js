/***** CONFIGURACIÓN *****/
const SUPABASE_URL = 'https://kozwtpgopvxrvkbvsaeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtvend0cGdvcHZ4cnZrYnZzYWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgwNDU0NDAsImV4cCI6MjA3MzYyMTQ0MH0.VhF49ygm9y5LN5Fkd1INGJB9aqJjbn8cd3LjaRiT5o8';

const MAX_SECONDS = 30;
const MAX_BYTES = 2.5 * 1024 * 1024; // 2.5 MB
const LONG_PRESS_MS = 250;            // Umbral long-press estilo WhatsApp
const EMOJI_INTERVAL_MS = 2000;       // ← ahora 2 s
const MIN_REC_MS = 600;               // duración mínima para evitar blobs vacíos iOS
const IGNORE_LEAVE_MS = 300;          // ignorar leave/cancel al inicio

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
const pickEmoji = (prev=null) => {
  let e = EMOJIS[Math.floor(Math.random()*EMOJIS.length)];
  if (prev && e === prev) e = EMOJIS[(EMOJIS.indexOf(e)+1)%EMOJIS.length];
  return e;
};

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

  // EMOJI: cada 2s con disolver (pausado en grabación/preview)
  let currentEmoji = pickEmoji();
  emojiDisplay.textContent = currentEmoji;
  let emojiTimer = null;
  const startEmojiLoop = ()=>{
    stopEmojiLoop();
    emojiTimer = setInterval(()=>{
      emojiDisplay.classList.add('fading');
      setTimeout(()=>{
        currentEmoji = pickEmoji(currentEmoji);
        emojiDisplay.textContent = currentEmoji;
        emojiDisplay.classList.remove('fading');
      }, 150);
    }, EMOJI_INTERVAL_MS);
  };
  const stopEmojiLoop = ()=>{ if (emojiTimer){ clearInterval(emojiTimer); emojiTimer = null; } };
  startEmojiLoop();

  let stream = null, mediaRecorder = null, chunks = [];
  let startTs = 0, durationMs = 0, blob = null;
  let mimeType = pickSupportedMime();
  let transcript = null, speechRec = null, stopTimer = null;
  let pressedAt = 0; // para ignorar leave/cancel al inicio

  function updateCounter(){
    const secs = Math.min(MAX_SECONDS, Math.floor((Date.now()-startTs)/1000));
    const s = (n)=> n<10? '0'+n : ''+n;
    counter.textContent = `0:${s(secs)} / 0:${s(MAX_SECONDS)}`;
  }

  function startSpeech(){
    const rec = createSpeechRecognition();
    speechRec = rec;
    if(!rec){ transcript = null; return; }
    transcript = '';
    rec.onresult = (ev)=>{
      for (let i = ev.resultIndex; i < ev.results.length; i++){
        const res = ev.results[i];
        if (res.isFinal) transcript += (transcript ? ' ' : '') + res[0].transcript.trim();
      }
    };
    rec.onerror = ()=>{};
    try { rec.start(); } catch(e){}
  }
  function stopSpeech(){ try{ speechRec && speechRec.stop(); }catch(e){} }

  function resetUI(){
    recordBtn.setAttribute('aria-pressed','false');
    recordBtn.classList.remove('btn-recording','is-pressed','hidden','pulsing');
    recordBtn.classList.add('btn-record');
    recordBtnText.textContent = 'Grabar';
    counter.textContent = `0:00 / 0:${MAX_SECONDS<10?'0':''}${MAX_SECONDS}`;
    preview.classList.add('hidden');
    player.removeAttribute('src'); player.load();
    blob = null; chunks = []; transcript = null; durationMs = 0;
    startEmojiLoop();
  }
  resetUI();

  function onDataAvailable(e){ if (e.data && e.data.size > 0) chunks.push(e.data); }

  async function ensureStream(){
    // Pedimos permiso SOLO en interacción de usuario
    if (stream){
      const tr = stream.getAudioTracks?.()[0];
      if (tr && tr.readyState === 'live' && tr.enabled) return true;
    }
    try{
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return true;
    }catch(e){
      showToast('No hay permiso de micrófono');
      return false;
    }
  }

  function doStopNow(){
    try{ mediaRecorder && mediaRecorder.requestData(); }catch(e){}
    // peq. respiro para que llegue el chunk final
    setTimeout(()=> { try{ mediaRecorder && mediaRecorder.stop(); }catch(e){} }, 0);
    if (stopTimer){ clearTimeout(stopTimer); stopTimer = null; }
    stopSpeech();
    durationMs = Date.now() - startTs;
  }

  function stopRecording(){
    if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
    const elapsed = Date.now() - startTs;
    if (elapsed < MIN_REC_MS){
      setTimeout(()=> doStopNow(), MIN_REC_MS - elapsed);
    } else {
      doStopNow();
    }
  }

  async function startRecordingIfNeeded(){
    const ok = await ensureStream();
    if (!ok) return false;
    if (mediaRecorder && mediaRecorder.state === 'recording') return true;

    chunks = []; blob = null;
    try{
      mediaRecorder = new MediaRecorder(stream, { mimeType });
    }catch(e){
      // fallback sin mimeType
      mediaRecorder = new MediaRecorder(stream);
      mimeType = mediaRecorder.mimeType || mimeType;
    }
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
        // Ocultar botón y pausar emojis en preview
        recordBtn.classList.add('hidden'); recordBtn.style.display = 'none';
        stopEmojiLoop();
        recordBtn.setAttribute('aria-pressed','false');
        recordBtn.classList.remove('pulsing');
        recordBtnText.textContent = 'Grabar';
      };
      player.addEventListener('canplaythrough', onReady, { once:true });
      setTimeout(()=> { if (preview.classList.contains('hidden')) onReady(); }, 800);
    };

    // Iniciar con timeslice para garantizar chunks
    mediaRecorder.start(250);
    startTs = Date.now();
    pressedAt = startTs;
    recordBtn.setAttribute('aria-pressed','true');
    recordBtn.classList.add('btn-recording','pulsing');  // pulso de grabación
    recordBtnText.textContent = 'Grabando…';
    stopEmojiLoop();
    startSpeech();

    const int = setInterval(()=>{ if (mediaRecorder?.state !== 'recording') { clearInterval(int); return; } updateCounter(); }, 200);
    stopTimer = setTimeout(()=> stopRecording(), MAX_SECONDS*1000);
    return true;
  }

  // Reintentar
  $('#redoBtn')?.addEventListener('click', ()=>{ recordBtn.style.display=''; resetUI(); });

  // Enviar
  $('#sendBtn')?.addEventListener('click', async ()=>{
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
      setTimeout(()=> { window.location.href = './escuchar.html'; }, 600);
    }catch(e){ console.error(e); showToast('Error al enviar. Reintenta.'); }
    finally{ showSpinner(false); }
  });

  /***** BOTÓN: tap y long-press + efecto 3D *****/
  let pressTimer = null, pressStartedAt = 0, longPressActive = false;
  function clearPressTimer(){ if (pressTimer){ clearTimeout(pressTimer); pressTimer = null; } }

  recordBtn.addEventListener('contextmenu', (e)=> e.preventDefault());
  recordBtn.addEventListener('pointerdown', async (e)=>{
    e.preventDefault();
    try { e.target.setPointerCapture(e.pointerId); } catch(_) {}
    recordBtn.classList.add('is-pressed');
    longPressActive = false;
    pressStartedAt = Date.now();
    clearPressTimer();
    pressTimer = setTimeout(async ()=>{
      longPressActive = true;
      await startRecordingIfNeeded();
      // mantiene el hundido mientras esté presionado
    }, LONG_PRESS_MS);
  });
  const endPress = async (type='up')=>{
    const delta = Date.now() - pressStartedAt;
    clearPressTimer();
    recordBtn.classList.remove('is-pressed');

    if (longPressActive){
      // si acaba de empezar, ignorar leaves/cancels muy tempranos
      if ((Date.now() - pressedAt) < IGNORE_LEAVE_MS && (type==='leave'||type==='cancel')) return;
      if (mediaRecorder?.state === 'recording') stopRecording();
      longPressActive = false;
    } else {
      if (delta < LONG_PRESS_MS){
        if (mediaRecorder?.state === 'recording') stopRecording();
        else await startRecordingIfNeeded();
      }
    }
  };
  recordBtn.addEventListener('pointerup', async (e)=>{ e.preventDefault(); await endPress('up'); });
  recordBtn.addEventListener('pointercancel', async (e)=>{ e.preventDefault(); await endPress('cancel'); });
  recordBtn.addEventListener('pointerleave', async (e)=>{ e.preventDefault(); await endPress('leave'); });
}

/***********************
 * ESCUCHAR
 ***********************/
function initListenPage(){
  const list = $('#audioList');
  const loading = $('#loadingAudios');
  const moreBtn = $('#moreBtn');

  const testAud = document.createElement('audio');

  function isPlayableRow(row){
    const mime = (row.mime_type || '').toLowerCase();
    const path = (row.file_path || '').toLowerCase();
    if (isIOS()){
      return mime.includes('mp4') || path.endsWith('.m4a') || path.endsWith('.mp4');
    }
    if (mime.includes('mp4') || path.endsWith('.m4a') || path.endsWith('.mp4')){
      const ok = testAud.canPlayType('audio/mp4') || testAud.canPlayType('audio/aac');
      if (ok) return true;
    }
    if (mime.includes('webm') || path.endsWith('.webm')){
      const ok = testAud.canPlayType('audio/webm; codecs="opus"') || testAud.canPlayType('audio/webm');
      if (ok) return true;
    }
    return false;
  }

  const publicUrl = (file_path)=>{
    const { data } = sb.storage.from('audios').getPublicUrl(file_path);
    return data?.publicUrl || null;
  };

  function sampleRandomUnique(arr, k, keyFn){
    const a = [...arr];
    for (let i=a.length-1; i>0; i--){ const j = Math.floor(Math.random()*(i+1)); [a[i], a[j]] = [a[j], a[i]]; }
    const seen = new Set(), out = [];
    for (const it of a){
      const key = keyFn ? keyFn(it) : JSON.stringify(it);
      if (!seen.has(key)){ seen.add(key); out.push(it); if (out.length >= k) break; }
    }
    return out;
  }

  async function fetchRecent(limit=60){
    const { data, error } = await sb
      .from('recordings')
      .select('file_path,mime_type,duration_seconds,created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error){ console.error(error); showToast('Error cargando audios'); return []; }
    return data || [];
  }

  function renderAudios(rows){
    for (const r of rows){
      const url = publicUrl(r.file_path);
      if (!url) continue;
      const wrapper = document.createElement('div');
      wrapper.style.visibility = 'hidden';
      const aud = document.createElement('audio');
      aud.controls = true;
      aud.preload = 'auto';
      aud.playsInline = true;
      aud.src = url;

      const reveal = ()=> { wrapper.style.visibility = 'visible'; };
      aud.addEventListener('canplaythrough', reveal, { once:true });
      setTimeout(reveal, 1200); // fallback

      wrapper.appendChild(aud);
      list.appendChild(wrapper);
      try { aud.load(); } catch(e){}
    }
  }

  async function loadSixReplace(){
    loading.classList.remove('hidden');
    list.innerHTML = '';
    let limit = 60, tries = 0, picked = [];
    while (picked.length < 6 && tries < 3){
      const batch = await fetchRecent(limit);
      const compatibles = batch.filter(isPlayableRow);
      picked = sampleRandomUnique(compatibles, 6, (x)=> x.file_path);
      if (picked.length >= 6) break;
      limit += 60; tries++;
    }
    if (picked.length === 0){ showToast('No hay audios compatibles aún'); }
    renderAudios(picked);
    loading.classList.add('hidden');
  }

  (async ()=>{ await loadSixReplace(); })();

  moreBtn.addEventListener('click', async ()=> { await loadSixReplace(); });
}
