/***** CONFIGURACIÓN *****/
const SUPABASE_URL = 'https://kozwtpgopvxrvkbvsaeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtvend0cGdvcHZ4cnZrYnZzYWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgwNDU0NDAsImV4cCI6MjA3MzYyMTQ0MH0.VhF49ygm9y5LN5Fkd1INGJB9aqJjbn8cd3LjaRiT5o8';

const MAX_SECONDS = 30;
const MAX_BYTES   = 2.5 * 1024 * 1024;
const LONG_PRESS_MS = 250;
const EMOJI_INTERVAL_MS = 2000;
const MIN_REC_MS = 600; // mínimo para evitar blobs vacíos

/***** DETECCIÓN DE PLATAFORMA *****/
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

// Timings específicos por plataforma
const TAIL_PAD_MS          = isIOS() ? 800 : 400; // cola previa al stop (captura el final)
const STOP_FLUSH_WAIT_MS   = isIOS() ? 350 : 200; // espera tras stop para último chunk
const FORCE_NEW_STREAM_EVERY_TIME = !isIOS();     // en iOS reusamos stream vivo para iniciar más rápido

/***** CLIENTE SUPABASE *****/
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/***** HELPERS UI *****/
const $ = (sel) => document.querySelector(sel);
const showToast = (msg) => { const t = $('#toast'); if(!t) return; t.textContent = msg; t.classList.add('show'); setTimeout(()=> t.classList.remove('show'), 2600); };
const showSpinner = (on=true) => { const s = $('#spinner'); if(!s) return; s.classList.toggle('hidden', !on); };

/***** EMOJIS *****/
const EMOJIS = [': D', ': )', ': |', ': (', ":’(", ': S'];
const pickEmoji = (prev=null) => { let e = EMOJIS[Math.floor(Math.random()*EMOJIS.length)]; if (prev && e===prev) e = EMOJIS[(EMOJIS.indexOf(e)+1)%EMOJIS.length]; return e; };

/***** GEO POR IP *****/
const IP_PROVIDERS = ['https://ipapi.co/json/', 'https://ipwho.is/'];
async function getGeoByIP() {
  for (const url of IP_PROVIDERS) {
    try { const r = await fetch(url, {cache:'no-store'}); if (!r.ok) continue;
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
  const rec = new SR(); rec.lang='es-MX'; rec.interimResults=true; rec.continuous=true; return rec;
}

/***** MIME/EXT *****/
function pickSupportedMime(){
  const iosFirst = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const generic  = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  const cands = isIOS() ? iosFirst : generic;
  for (const t of cands){ if (window.MediaRecorder?.isTypeSupported?.(t)) return t; }
  return isIOS()? 'audio/mp4' : 'audio/webm';
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
  // UI
  const emojiDisplay   = $('#emojiDisplay');
  const recordBtn      = $('#recordBtn');
  const recordBtnText  = $('#recordBtnText');
  const counter        = $('#counter');
  const preview        = $('#preview');
  const player         = $('#player');

  // Emojis (cada 2s con disolver, pausado en grabación/preview)
  let currentEmoji = pickEmoji(); emojiDisplay.textContent = currentEmoji;
  let emojiTimer = null;
  const startEmojiLoop = ()=>{ stopEmojiLoop(); emojiTimer = setInterval(()=>{ emojiDisplay.classList.add('fading'); setTimeout(()=>{ currentEmoji = pickEmoji(currentEmoji); emojiDisplay.textContent=currentEmoji; emojiDisplay.classList.remove('fading'); },150); }, EMOJI_INTERVAL_MS); };
  const stopEmojiLoop  = ()=>{ if (emojiTimer){ clearInterval(emojiTimer); emojiTimer=null; } };
  startEmojiLoop();

  // Estado
  let stream = null, mediaRecorder = null, chunks = [];
  let startTs = 0, durationMs = 0, blob = null, mimeType = pickSupportedMime();
  let transcript = null, speechRec = null, stopTimer = null;
  let pressStartedAt = 0, pressedAt = 0;
  let state = 'idle'; // idle | starting | recording | stopping | preview

  // Counter UI
  const updateCounter = ()=>{ if (state!=='recording') return;
    const secs = Math.min(MAX_SECONDS, Math.floor((Date.now()-startTs)/1000));
    const s = (n)=> n<10? '0'+n : ''+n; counter.textContent = `0:${s(secs)} / 0:${s(MAX_SECONDS)}`; };

  // STT
  function startSpeech(){
    const rec = createSpeechRecognition(); speechRec = rec;
    if(!rec){ transcript=null; return; }
    transcript=''; rec.onresult=(ev)=>{ for (let i=ev.resultIndex; i<ev.results.length; i++){ const r=ev.results[i]; if (r.isFinal) transcript += (transcript?' ':'') + r[0].transcript.trim(); } };
    rec.onerror=()=>{}; try{ rec.start(); }catch(e){}
  }
  const stopSpeech = ()=>{ try{ speechRec && speechRec.stop(); }catch(e){} };

  function releaseStream(){
    try{ stream?.getTracks?.().forEach(tr=> { try{ tr.stop(); }catch(e){} }); }catch(e){}
    stream = null;
  }

  function resetUI(){
    state='idle';
    recordBtn.setAttribute('aria-pressed','false');
    recordBtn.classList.remove('btn-recording','is-pressed','hidden','pulsing');
    recordBtn.classList.add('btn-record');
    recordBtnText.textContent='Grabar';
    counter.textContent=`0:00 / 0:${MAX_SECONDS<10?'0':''}${MAX_SECONDS}`;
    preview.classList.add('hidden');
    try{ player.pause(); }catch(e){}
    player.removeAttribute('src'); player.load();
    blob=null; chunks=[]; transcript=null; durationMs=0;
    startEmojiLoop();
  }
  resetUI();

  async function acquireStreamFresh(){
    try{ return await navigator.mediaDevices.getUserMedia({ audio:true }); }
    catch(e){ showToast('No hay permiso de micrófono'); return null; }
  }

  async function ensureStreamForStart(){
    if (FORCE_NEW_STREAM_EVERY_TIME){
      releaseStream();
      stream = await acquireStreamFresh();
      return !!stream;
    }
    // iOS: si ya está vivo, reúsalo (inicio más rápido, menos “pérdida” al principio)
    const tr = stream?.getAudioTracks?.()[0];
    if (tr && tr.readyState==='live' && tr.enabled) return true;
    stream = await acquireStreamFresh();
    return !!stream;
  }

  async function startRecording(){
    if (state!=='idle' && state!=='preview') return false;
    state='starting';

    const ok = await ensureStreamForStart();
    if (!ok){ state='idle'; return false; }

    chunks=[]; blob=null;
    try { mediaRecorder = new MediaRecorder(stream, { mimeType }); }
    catch(e){ mediaRecorder = new MediaRecorder(stream); mimeType = mediaRecorder.mimeType || mimeType; }

    let gotAnyChunk = false;
    mediaRecorder.addEventListener('dataavailable', (e)=>{ if (e.data && e.data.size>0){ gotAnyChunk = true; chunks.push(e.data); } });

    // “kick” temprano para que comience a soltar datos
    mediaRecorder.addEventListener('start', ()=>{ try{ setTimeout(()=> mediaRecorder.requestData(), 200); }catch(e){} });

    mediaRecorder.start(250); // chunks ~cada 250ms

    // UI → grabando
    startTs = Date.now(); pressedAt = startTs;
    recordBtn.setAttribute('aria-pressed','true');
    recordBtn.classList.add('btn-recording','pulsing');
    recordBtnText.textContent='Grabando…';
    stopEmojiLoop(); startSpeech(); state='recording';

    const int = setInterval(()=>{ if (state!=='recording' || mediaRecorder?.state!=='recording'){ clearInterval(int); return; } updateCounter(); }, 200);

    // Failsafe: si en 800ms no llegó ningún chunk, forzar uno
    setTimeout(()=>{ if (state==='recording' && !gotAnyChunk){ try{ mediaRecorder.requestData(); }catch(e){} } }, 800);

    stopTimer = setTimeout(()=> stopRecording(), MAX_SECONDS*1000);
    return true;
  }

  async function stopRecording(){
    if (state!=='recording' || !mediaRecorder) return;
    state='stopping';

    // Asegura duración mínima y añade "cola" para no cortar el final (iOS)
    const elapsed = Date.now() - startTs;
    const needMin = Math.max(0, MIN_REC_MS - elapsed);
    if (needMin) await new Promise(r=> setTimeout(r, needMin));
    if (TAIL_PAD_MS) await new Promise(r=> setTimeout(r, TAIL_PAD_MS));

    try { mediaRecorder.requestData(); } catch(e){}
    const stopped = new Promise(res => mediaRecorder.addEventListener('stop', res, {once:true}));
    try { mediaRecorder.stop(); } catch(e) {}
    if (stopTimer){ clearTimeout(stopTimer); stopTimer=null; }
    stopSpeech();

    await stopped;
    await new Promise(r=> setTimeout(r, STOP_FLUSH_WAIT_MS));

    const built = chunks && chunks.length ? new Blob(chunks, { type: mimeType || mediaRecorder?.mimeType || (isIOS()?'audio/mp4':'audio/webm') }) : null;
    if (!built || built.size === 0){
      showToast('No se capturó audio. Intenta de nuevo.');
      if (!isIOS()) releaseStream(); // en iOS solemos reusar; fuera de iOS soltamos para forzar fresco
      resetUI();
      return;
    }
    blob = built;
    durationMs = Date.now() - startTs;

    // Preview
    const url = URL.createObjectURL(blob);
    const reveal = ()=> {
      preview.classList.remove('hidden');
      recordBtn.classList.add('hidden'); recordBtn.style.display='none';
      recordBtn.setAttribute('aria-pressed','false');
      recordBtn.classList.remove('pulsing');
      recordBtnText.textContent='Grabar';
      state='preview';
    };
    player.setAttribute('playsinline','true');
    player.src = url;

    let revealed=false;
    player.addEventListener('loadedmetadata', ()=>{ if(!revealed){ revealed=true; reveal(); } }, {once:true});
    player.addEventListener('canplaythrough', ()=>{ if(!revealed){ revealed=true; reveal(); } }, {once:true});
    setTimeout(()=>{ if (!revealed){ revealed=true; reveal(); } }, 800);
  }

  // Reintentar
  $('#redoBtn')?.addEventListener('click', ()=>{
    try{ mediaRecorder && mediaRecorder.state==='recording' && mediaRecorder.stop(); }catch(e){}
    if (!isIOS()) { // fuera de iOS prefiero forzar stream nuevo en el siguiente intento
      try{ stream?.getTracks?.().forEach(t=>t.stop()); }catch(e){}
      stream = null;
    }
    recordBtn.style.display=''; 
    resetUI(); 
  });

  // Enviar
  $('#sendBtn')?.addEventListener('click', async ()=>{
    if (!blob){ showToast('No hay audio para enviar'); return; }
    showSpinner(true);
    try{
      const ext = extensionFromMime(mimeType);
      const id  = crypto.randomUUID();
      const path= `recordings/${id}.${ext}`;
      const geo = await getGeoByIP().catch(()=>({}));
      const { error: upErr } = await sb.storage.from('audios').upload(path, blob, { contentType: mimeType, upsert: false });
      if (upErr) throw upErr;
      const { error: insErr } = await sb.from('recordings').insert([{
        file_path: path, mime_type: mimeType, size_bytes: blob.size,
        duration_seconds: Math.min(MAX_SECONDS, Math.round(durationMs/1000)),
        transcript: null,
        ip: geo.ip || null, location_city: geo.city || null, location_region: geo.region || null, location_country: geo.country || null,
        user_agent: navigator.userAgent || null, approved: true
      }]);
      if (insErr) throw insErr;
      showToast('¡Enviado con éxito!');
      setTimeout(()=> { window.location.href = './escuchar.html'; }, 600);
    }catch(e){ console.error(e); showToast('Error al enviar. Reintenta.'); }
    finally{ showSpinner(false); }
  });

  /***** Botón: inicio inmediato + hold *****/
  let pressTimer = null;
  const clearPressTimer = ()=>{ if (pressTimer){ clearTimeout(pressTimer); pressTimer=null; } };

  recordBtn.addEventListener('contextmenu', e=> e.preventDefault());

  recordBtn.addEventListener('pointerdown', async (e)=>{
    e.preventDefault();
    try { e.target.setPointerCapture(e.pointerId); } catch(_) {}
    recordBtn.classList.add('is-pressed');
    pressStartedAt = Date.now();

    // INICIO INMEDIATO si estabas idle/preview (corrige pérdida al principio en hold)
    if (state==='idle' || state==='preview'){
      await startRecording();
    }
  });

  async function endPress(){
    const delta = Date.now() - pressStartedAt;
    recordBtn.classList.remove('is-pressed');

    if (state==='recording'){
      // Si fue hold (≥ LONG_PRESS_MS) paramos al soltar; si fue tap corto, dejamos grabando (toggle)
      if (delta >= LONG_PRESS_MS){ await stopRecording(); }
      // si fue “tap corto”, no paramos aquí (continúa grabando) — ya corregimos el inicio temprano
    } else if (state==='starting'){
      // si suelta rapidísimo mientras empezaba, esperamos a que entre a recording y paramos
      const t0 = Date.now();
      while (state==='starting' && Date.now()-t0 < 800){ await new Promise(r=>setTimeout(r,10)); }
      if (state==='recording'){ await stopRecording(); }
    }
  }

  recordBtn.addEventListener('pointerup',     async e=>{ e.preventDefault(); await endPress(); });
  recordBtn.addEventListener('pointercancel', async e=>{ e.preventDefault(); await endPress(); });
  recordBtn.addEventListener('pointerleave',  async e=>{ e.preventDefault(); await endPress(); });
}

/***********************
 * ESCUCHAR (igual)
 ***********************/
function initListenPage(){
  const list    = $('#audioList');
  const loading = $('#loadingAudios');
  const moreBtn = $('#moreBtn');
  const testAud = document.createElement('audio');

  const isIOSLoc = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

  const isPlayableRow = (row)=>{
    const mime=(row.mime_type||'').toLowerCase();
    const path=(row.file_path||'').toLowerCase();
    if (isIOSLoc()){ return mime.includes('mp4') || path.endsWith('.m4a') || path.endsWith('.mp4'); }
    if (mime.includes('mp4') || path.endsWith('.m4a') || path.endsWith('.mp4')){
      const ok = testAud.canPlayType('audio/mp4') || testAud.canPlayType('audio/aac'); if (ok) return true;
    }
    if (mime.includes('webm') || path.endsWith('.webm')){
      const ok = testAud.canPlayType('audio/webm; codecs="opus"') || testAud.canPlayType('audio/webm'); if (ok) return true;
    }
    return false;
  };

  const publicUrl = (file_path)=> sb.storage.from('audios').getPublicUrl(file_path)?.data?.publicUrl || null;

  function sampleRandomUnique(arr, k, keyFn){
    const a=[...arr]; for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
    const seen=new Set(), out=[]; for (const it of a){ const key=keyFn?keyFn(it):it.file_path; if (!seen.has(key)){ seen.add(key); out.push(it); if (out.length>=k) break; } } return out;
  }

  async function fetchRecent(limit=60){
    const { data, error } = await sb.from('recordings').select('file_path,mime_type,duration_seconds,created_at').order('created_at',{ascending:false}).limit(limit);
    if (error){ console.error(error); showToast('Error cargando audios'); return []; }
    return data||[];
  }

  function renderAudios(rows){
    for (const r of rows){
      const url = publicUrl(r.file_path); if(!url) continue;
      const wrapper=document.createElement('div'); wrapper.style.visibility='hidden';
      const aud=document.createElement('audio'); aud.controls=true; aud.preload='auto'; aud.playsInline=true; aud.src=url;
      const reveal=()=>{ wrapper.style.visibility='visible'; };
      aud.addEventListener('loadedmetadata', reveal, {once:true});
      aud.addEventListener('canplaythrough', reveal, {once:true});
      setTimeout(reveal, 1200);
      wrapper.appendChild(aud); list.appendChild(wrapper);
      try{ aud.load(); }catch(e){}
    }
  }

  async function loadSixReplace(){
    loading.classList.remove('hidden'); list.innerHTML='';
    let limit=60, tries=0, picked=[];
    while (picked.length<6 && tries<3){
      const batch = await fetchRecent(limit);
      const compatibles = batch.filter(isPlayableRow);
      picked = sampleRandomUnique(compatibles, 6, x=>x.file_path);
      if (picked.length>=6) break;
      limit += 60; tries++;
    }
    if (picked.length===0){ showToast('No hay audios compatibles aún'); }
    renderAudios(picked); loading.classList.add('hidden');
  }

  (async ()=>{ await loadSixReplace(); })();
  moreBtn.addEventListener('click', async ()=>{ await loadSixReplace(); });
}
