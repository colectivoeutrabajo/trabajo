/***** CONFIG *****/
const SUPABASE_URL = 'https://kozwtpgopvxrvkbvsaeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtvend0cGdvcHZ4cnZrYnZzYWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgwNDU0NDAsImV4cCI6MjA3MzYyMTQ0MH0.VhF49ygm9y5LN5Fkd1INGJB9aqJjbn8cd3LjaRiT5o8';

const MAX_SECONDS = 30;
const EMOJI_INTERVAL_MS = 2000;
const MIN_REC_MS = 650;                          // evita blobs vacíos por taps ultracortos
const HOLD_THRESHOLD_MS = 550;                   // ↑ umbral: tap normal ≠ hold
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const TAIL_PAD_MS        = isIOS() ? 350 : 150;  // colita breve al soltar
const STOP_FLUSH_WAIT_MS = isIOS() ? 300 : 150;  // espera para último chunk
const FORCE_NEW_STREAM_EVERY_TIME = true;

/***** SUPABASE *****/
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/***** HELPERS UI *****/
const $ = (s)=>document.querySelector(s);
const showToast = (m)=>{ const t=$('#toast'); if(!t) return; t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2600); };
const showSpinner = (on=true)=>{ const s=$('#spinner'); if(!s) return; s.classList.toggle('hidden',!on); };

/***** EMOJIS *****/
const EMOJIS=[": D",": )",": |",": (",":’(",": S"];
const pickEmoji=(prev=null)=>{ let e=EMOJIS[Math.floor(Math.random()*EMOJIS.length)]; if(prev&&e===prev) e=EMOJIS[(EMOJIS.indexOf(e)+1)%EMOJIS.length]; return e; };

/***** GEO IP *****/
async function getGeoByIP(){
  const providers=['https://ipapi.co/json/','https://ipwho.is/'];
  for(const url of providers){
    try{ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) continue;
      const j=await r.json();
      if(j&&(j.city||j.country||j.region||j.ip)){
        return { ip:j.ip||j.query||null, city:j.city||null, region:j.region||j.regionName||null, country:j.country||j.country_name||j.countryCode||null };
      }
    }catch(_){}
  }
  return { ip:null, city:null, region:null, country:null };
}

/***** MIME/EXT *****/
function pickSupportedMime(){
  const prefs = isIOS()
    ? ['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus']
    : ['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'];
  for(const t of prefs){ if(window.MediaRecorder?.isTypeSupported?.(t)) return t; }
  return isIOS()? 'audio/mp4' : 'audio/webm';
}
function extensionFromMime(m){
  if(!m) return isIOS()?'m4a':'webm';
  if(m.includes('mp4'))  return 'm4a';
  if(m.includes('webm')) return 'webm';
  if(m.includes('m4a'))  return 'm4a';
  if(m.includes('mpeg')) return 'mp3';
  if(m.includes('ogg'))  return 'ogg';
  if(m.includes('wav'))  return 'wav';
  return isIOS()? 'm4a' : 'webm';
}

/***** ROUTER *****/
document.addEventListener('DOMContentLoaded',()=>{
  const page=document.body.dataset.page;
  if(page==='record') initRecordPage();
  if(page==='listen') initListenPage();
});

/***********************
 * GRABAR — DUAL: TAP (toggle) + HOLD
 ***********************/
async function initRecordPage(){
  const emojiDisplay=$('#emojiDisplay');
  const recordBtn=$('#recordBtn');
  const recordBtnText=$('#recordBtnText');
  const counter=$('#counter');
  const preview=$('#preview');
  const player=$('#player');

  // Emojis c/2s con disolver (pausados en grabación/preview)
  let currentEmoji=pickEmoji(); emojiDisplay.textContent=currentEmoji;
  let emojiTimer=null;
  const startEmojiLoop=()=>{ stopEmojiLoop(); emojiTimer=setInterval(()=>{ emojiDisplay.classList.add('fading'); setTimeout(()=>{ currentEmoji=pickEmoji(currentEmoji); emojiDisplay.textContent=currentEmoji; emojiDisplay.classList.remove('fading'); },150); },EMOJI_INTERVAL_MS); };
  const stopEmojiLoop =()=>{ if(emojiTimer){ clearInterval(emojiTimer); emojiTimer=null; } };
  startEmojiLoop();

  // Estado
  let stream=null, mediaRecorder=null, chunks=[];
  let startTs=0, durationMs=0, blob=null, mimeType=pickSupportedMime();
  let stopTimer=null, counterInt=null;
  let state='idle'; // idle | starting | recording | stopping | preview
  let downAt=0, startedByThisDown=false;

  const updateCounter=()=>{ if(state!=='recording') return;
    const secs=Math.min(MAX_SECONDS, Math.floor((Date.now()-startTs)/1000));
    const s=(n)=> n<10?('0'+n):(''+n);
    counter.textContent=`0:${s(secs)} / 0:${s(MAX_SECONDS)}`;
  };

  function resetUI(){
    state='idle';
    recordBtn.setAttribute('aria-pressed','false');
    recordBtn.classList.remove('btn-recording','hidden','is-pressed');
    recordBtnText.textContent='Grabar';
    counter.textContent=`0:00 / 0:${MAX_SECONDS<10?'0':''}${MAX_SECONDS}`;
    preview.classList.add('hidden');
    try{ player.pause(); }catch(_){}
    player.removeAttribute('src'); player.load();
    blob=null; chunks=[]; durationMs=0;
    startEmojiLoop();
  }
  resetUI();

  function releaseStream(){ try{ stream?.getTracks?.().forEach(t=>{ try{ t.stop(); }catch(_){ } }); }catch(_){ } stream=null; }
  async function acquireStreamFresh(){ try{ return await navigator.mediaDevices.getUserMedia({audio:true}); }catch(_){ showToast('No hay permiso de micrófono'); return null; } }

  async function startRecording(){
    if(state!=='idle' && state!=='preview') return false;
    state='starting';

    // UI feedback INMEDIATO (se pone rojo ya)
    recordBtn.setAttribute('aria-pressed','true');
    recordBtn.classList.add('btn-recording','is-pressed');
    recordBtnText.textContent='Grabando…';
    stopEmojiLoop();

    // stream fresco (si ya concedido, no vuelve a preguntar)
    if (FORCE_NEW_STREAM_EVERY_TIME){ releaseStream(); }
    if(!stream){
      stream=await acquireStreamFresh();
      if(!stream){ // revertir UI si falló
        recordBtn.setAttribute('aria-pressed','false');
        recordBtn.classList.remove('btn-recording','is-pressed');
        recordBtnText.textContent='Grabar';
        startEmojiLoop();
        state='idle';
        return false;
      }
    }

    chunks=[]; blob=null;
    try{ mediaRecorder=new MediaRecorder(stream,{mimeType}); }
    catch(_){ mediaRecorder=new MediaRecorder(stream); mimeType=mediaRecorder.mimeType||mimeType; }

    mediaRecorder.addEventListener('dataavailable',(e)=>{ if(e.data && e.data.size>0){ chunks.push(e.data); } });

    if (isIOS()){
      mediaRecorder.start(); // single-blob
    } else {
      mediaRecorder.start(250); // time-slice
      mediaRecorder.addEventListener('start',()=>{ try{ setTimeout(()=>mediaRecorder.requestData(),200); }catch(_){ } });
      setTimeout(()=>{ try{ mediaRecorder.requestData(); }catch(_){ } },800);
    }

    startTs=Date.now();
    state='recording';
    counterInt = setInterval(updateCounter, 200);
    stopTimer  = setTimeout(()=> stopRecording(true), MAX_SECONDS*1000);
    return true;
  }

  async function stopRecording(fromAuto=false){
    if(state!=='recording' || !mediaRecorder) return;
    state='stopping';

    const elapsed=Date.now()-startTs;
    const needMin=Math.max(0, MIN_REC_MS - elapsed);
    if(needMin) await new Promise(r=>setTimeout(r,needMin));
    if(!fromAuto && TAIL_PAD_MS) await new Promise(r=>setTimeout(r,TAIL_PAD_MS));
    if (!isIOS()){ try{ mediaRecorder.requestData(); }catch(_){ } }

    const stopped=new Promise(res=> mediaRecorder.addEventListener('stop',res,{once:true}));
    try{ mediaRecorder.stop(); }catch(_){}
    if(stopTimer){ clearTimeout(stopTimer); stopTimer=null; }
    if(counterInt){ clearInterval(counterInt); counterInt=null; }

    await stopped;
    await new Promise(r=> setTimeout(r, STOP_FLUSH_WAIT_MS));

    const built = (chunks && chunks.length) ? new Blob(chunks,{type: mimeType || mediaRecorder?.mimeType || (isIOS()?'audio/mp4':'audio/webm')}) : null;
    if(!built || built.size===0){
      showToast('No se capturó audio. Intenta de nuevo.');
      releaseStream(); resetUI(); return;
    }
    blob=built; durationMs=Date.now()-startTs;

    // Preview
    const url=URL.createObjectURL(blob);
    const reveal=()=>{
      preview.classList.remove('hidden');
      recordBtn.classList.remove('is-pressed');
      recordBtn.classList.add('hidden');
      recordBtn.setAttribute('aria-pressed','false');
      recordBtnText.textContent='Grabar';
      state='preview';
    };
    player.setAttribute('playsinline','true');
    player.src=url;
    let revealed=false;
    player.addEventListener('loadedmetadata',()=>{ if(!revealed){ revealed=true; reveal(); } },{once:true});
    player.addEventListener('canplaythrough',()=>{ if(!revealed){ revealed=true; reveal(); } },{once:true});
    setTimeout(()=>{ if(!revealed){ revealed=true; reveal(); } },800);
  }

  // ---- GESTOS: dual ----
  recordBtn.addEventListener('contextmenu', e=> e.preventDefault());

  recordBtn.addEventListener('pointerdown', async (e)=>{
    e.preventDefault();
    try{ e.target.setPointerCapture(e.pointerId); }catch(_){}
    downAt = Date.now();
    startedByThisDown = (state==='idle' || state==='preview');
    if (startedByThisDown){
      await startRecording(); // inicio inmediato (captura bien el principio y da feedback visual enseguida)
    } else {
      // si ya estaba grabando, solo marcamos visual “presionado”
      recordBtn.classList.add('is-pressed');
    }
  });

  async function waitForRecording(timeout=800){
    const t0=Date.now();
    while(Date.now()-t0<timeout){ if(state==='recording') return true; await new Promise(r=>setTimeout(r,10)); }
    return false;
  }

  async function finishPress(){
    recordBtn.classList.remove('is-pressed');
    const held = Date.now() - downAt;

    if (startedByThisDown){
      // HOLD: si mantuvo ≥ umbral → soltar detiene; si fue tap (< umbral) → sigue grabando (toggle)
      if (held >= HOLD_THRESHOLD_MS){
        if (state==='starting'){ await waitForRecording(); }
        if (state==='recording'){ await stopRecording(false); }
      }
      startedByThisDown=false;
      return;
    }

    // Estaba grabando antes de este press → tratar como toggle (soltar detiene)
    if (state==='starting'){ await waitForRecording(); }
    if (state==='recording'){ await stopRecording(false); }
  }

  recordBtn.addEventListener('pointerup',     async e=>{ e.preventDefault(); await finishPress(); });
  recordBtn.addEventListener('pointercancel', async e=>{ e.preventDefault(); await finishPress(); });
  recordBtn.addEventListener('pointerleave',  async e=>{ e.preventDefault(); await finishPress(); });

  // Grabar de nuevo
  $('#redoBtn')?.addEventListener('click',()=>{
    try{ mediaRecorder && mediaRecorder.state==='recording' && mediaRecorder.stop(); }catch(_){}
    releaseStream();
    recordBtn.classList.remove('hidden','is-pressed','btn-recording');
    recordBtn.setAttribute('aria-pressed','false');
    recordBtnText.textContent='Grabar';
    resetUI();
  });

  // Enviar
  $('#sendBtn')?.addEventListener('click', async()=>{
    if(!blob){ showToast('No hay audio para enviar'); return; }
    showSpinner(true);
    try{
      const ext=extensionFromMime(mimeType);
      const id=crypto.randomUUID();
      const path=`recordings/${id}.${ext}`;
      const geo=await getGeoByIP().catch(()=>({}));

      const { error:upErr } = await sb.storage.from('audios').upload(path, blob, { contentType:mimeType, upsert:false });
      if(upErr) throw upErr;

      const { error:insErr } = await sb.from('recordings').insert([{
        file_path:path, mime_type:mimeType, size_bytes:blob.size,
        duration_seconds: Math.min(MAX_SECONDS, Math.round(durationMs/1000)),
        transcript:null,
        ip:geo.ip||null, location_city:geo.city||null, location_region:geo.region||null, location_country:geo.country||null,
        user_agent:navigator.userAgent||null, approved:true
      }]);
      if(insErr) throw insErr;

      showToast('¡Enviado con éxito!');
      setTimeout(()=>{ window.location.href='./escuchar.html'; },600);
    }catch(e){ console.error(e); showToast('Error al enviar. Reintenta.'); }
    finally{ showSpinner(false); }
  });
}

/***********************
 * ESCUCHAR (igual)
 ***********************/
function initListenPage(){
  const list=$('#audioList');
  const loading=$('#loadingAudios');
  const moreBtn=$('#moreBtn');
  const testAud=document.createElement('audio');

  const iOSLoc=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream;

  const isPlayableRow=(row)=>{
    const mime=(row.mime_type||'').toLowerCase();
    const path=(row.file_path||'').toLowerCase();
    if(iOSLoc()) return mime.includes('mp4')||path.endsWith('.m4a')||path.endsWith('.mp4');
    if(mime.includes('mp4')||path.endsWith('.m4a')||path.endsWith('.mp4')){ const ok=testAud.canPlayType('audio/mp4')||testAud.canPlayType('audio/aac'); if(ok) return true; }
    if(mime.includes('webm')||path.endsWith('.webm')){ const ok=testAud.canPlayType('audio/webm; codecs="opus"')||testAud.canPlayType('audio/webm'); if(ok) return true; }
    return false;
  };

  const publicUrl=(file_path)=> sb.storage.from('audios').getPublicUrl(file_path)?.data?.publicUrl || null;

  function sampleRandomUnique(arr,k,keyFn){ const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } const seen=new Set(),out=[]; for(const it of a){ const key=keyFn?keyFn(it):it.file_path; if(!seen.has(key)){ seen.add(key); out.push(it); if(out.length>=k) break; } } return out; }

  async function fetchRecent(limit=60){
    const {data,error}=await sb.from('recordings').select('file_path,mime_type,duration_seconds,created_at').order('created_at',{ascending:false}).limit(limit);
    if(error){ console.error(error); showToast('Error cargando audios'); return []; }
    return data||[];
  }

  function renderAudios(rows){
    for(const r of rows){
      const url=publicUrl(r.file_path); if(!url) continue;
      const wrapper=document.createElement('div'); wrapper.style.visibility='hidden';
      const aud=document.createElement('audio'); aud.controls=true; aud.preload='auto'; aud.playsInline=true; aud.src=url;
      const reveal=()=>{ wrapper.style.visibility='visible'; };
      aud.addEventListener('loadedmetadata',reveal,{once:true});
      aud.addEventListener('canplaythrough',reveal,{once:true});
      setTimeout(reveal,1200);
      wrapper.appendChild(aud); list.appendChild(wrapper);
      try{ aud.load(); }catch(_){}
    }
  }

  async function loadSixReplace(){
    loading.classList.remove('hidden'); list.innerHTML='';
    let limit=60,tries=0,picked=[];
    while(picked.length<6 && tries<3){
      const batch=await fetchRecent(limit);
      const compatibles=batch.filter(isPlayableRow);
      picked=sampleRandomUnique(compatibles,6,x=>x.file_path);
      if(picked.length>=6) break;
      limit+=60; tries++;
    }
    if(picked.length===0){ showToast('No hay audios compatibles aún'); }
    renderAudios(picked); loading.classList.add('hidden');
  }

  (async()=>{ await loadSixReplace(); })();

/* ==== PATCH: Control de grabación dual (tap-toggle + hold-to-record) ==== */
/* Este bloque puede ir al FINAL de app.js. Si ya tienes lógica de grabación,
   este patch la sustituye: "rearma" el botón #recordBtn con un manejador robusto
   que soporta AMBOS modos sin cortes a ~1s ni latencias en iPhone. */

(function(){
  const $ = (sel, root=document) => root.querySelector(sel);

  const btn = $('#recordBtn');
  if (!btn) return; // no estamos en la pantalla de grabación

  // Elementos opcionales que ya tienes
  const counterEl = $('#counter');
  const previewWrap = $('#preview');
  const player = $('#player');
  const sendBtn = $('#sendBtn');
  const recordAgainBtn = $('#recordAgainBtn');
  const consentNote = $('#consentNote'); // leyenda de consentimiento (solo en preview)

  // Flags/estado
  let stream = null;
  let mediaRecorder = null;
  let chunks = [];
  let blob = null;
  let isRecording = false;
  let gestureMode = null;   // 'toggle' | 'hold' | null
  let pointerDownAt = 0;
  let pointerIsDown = false;
  let holdTimer = null;
  let ignoreNextPointerUp = false;
  let maxTimer = null;
  let startTs = 0;

  // Ajustes (respetan los que ya tengas definidos globalmente)
  const MAX_SECONDS = (typeof window.MAX_SECONDS === 'number') ? window.MAX_SECONDS : 30;
  const HOLD_THRESHOLD_MS = (typeof window.HOLD_THRESHOLD_MS === 'number') ? window.HOLD_THRESHOLD_MS : 500;
  const MIN_REC_MS = (typeof window.MIN_REC_MS === 'number') ? window.MIN_REC_MS : 500;
  const STOP_FLUSH_WAIT_MS = (typeof window.STOP_FLUSH_WAIT_MS === 'number') ? window.STOP_FLUSH_WAIT_MS : (isIOS() ? 300 : 150);

  // UX: asegurar que el botón no seleccione texto ni dispare gestos extraños
  btn.style.touchAction = 'manipulation';
  btn.style.webkitUserSelect = 'none';
  btn.style.userSelect = 'none';
  btn.addEventListener('contextmenu', e => e.preventDefault());

  function isIOS(){
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  function canType(type){
    return (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type));
  }
  function pickMime(){
    // Safari/iOS → m4a/mp4; Chrome/Android → webm/opus
    const prefer = [
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/aac',
      'audio/webm;codecs=opus',
      'audio/webm'
    ];
    for (const t of prefer) if (canType(t)) return t;
    return ''; // dejar que el navegador escoja por defecto
  }

  function hhmmss(ms){
    const s = Math.max(0, Math.floor(ms/1000));
    const m = Math.floor(s/60);
    const r = s%60;
    const pad = (n) => String(n).padStart(2,'0');
    return `${pad(m)}:${pad(r)}`;
  }

  function setBtnState(state){
    // 'idle' | 'starting' | 'recording' | 'stopping' | 'preview'
    btn.dataset.state = state;
    if (state === 'recording') {
      btn.classList.add('is-recording');
      btn.setAttribute('aria-pressed','true');
      if (btn.querySelector('.label')) btn.querySelector('.label').textContent = 'GRABANDO…';
    } else {
      btn.classList.remove('is-recording');
      btn.setAttribute('aria-pressed','false');
      if (btn.querySelector('.label')) btn.querySelector('.label').textContent = 'GRABAR';
    }
    // Leyenda de consentimiento solo en PREVIEW
    if (consentNote) {
      if (state === 'preview') consentNote.classList.remove('hidden');
      else consentNote.classList.add('hidden');
    }
  }

  function updateCounter(){
    if (!counterEl) return;
    const elapsed = isRecording ? (Date.now() - startTs) : 0;
    const left = Math.max(0, MAX_SECONDS*1000 - elapsed);
    counterEl.textContent = `00/${String(MAX_SECONDS).padStart(2,'0')}`;
    // Si quieres mostrar avance: counterEl.textContent = `${hhmmss(elapsed)}/${hhmmss(MAX_SECONDS*1000)}`;
  }

  function tickCounter(){
    updateCounter();
    if (isRecording) requestAnimationFrame(tickCounter);
  }

  async function ensureStream(){
    if (stream && stream.active) return stream;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return stream;
  }

  function cleanupStream(){
    if (stream) {
      for (const tr of stream.getTracks()) try { tr.stop(); } catch {}
      stream = null;
    }
  }

  async function startRecording(){
    if (isRecording) return;
    setBtnState('starting');
    try {
      const st = await ensureStream();
      chunks = [];
      const mime = pickMime();
      mediaRecorder = mime ? new MediaRecorder(st, { mimeType: mime }) : new MediaRecorder(st);
      mediaRecorder.addEventListener('dataavailable', e => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      });
      mediaRecorder.addEventListener('stop', () => {
        blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/mp4' });
      }, { once:true });

      mediaRecorder.start(100); // timeslice corto para flush periódico
      startTs = Date.now();
      isRecording = true;
      setBtnState('recording');
      requestAnimationFrame(tickCounter);

      // límite duro
      clearTimeout(maxTimer);
      maxTimer = setTimeout(()=> stopRecording(), MAX_SECONDS*1000);

      // Pausar animaciones/emoji si tu UI tiene un loop global:
      document.documentElement.classList.add('rec-on');
    } catch (err) {
      console.error('No se pudo iniciar grabación:', err);
      setBtnState('idle');
    }
  }

  async function stopRecording(){
    if (!isRecording) return;
    setBtnState('stopping');
    try {
      // Asegurar duración mínima para evitar blobs vacíos
      const elapsed = Date.now() - startTs;
      if (elapsed < MIN_REC_MS) {
        await new Promise(r => setTimeout(r, MIN_REC_MS - elapsed));
      }
      // Parar recorder + esperar flush
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        const pStop = new Promise(r => mediaRecorder.addEventListener('stop', r, { once:true }));
        mediaRecorder.stop();
        await Promise.race([pStop, new Promise(r=>setTimeout(r, STOP_FLUSH_WAIT_MS))]);
      }
      cleanupStream();
      isRecording = false;
      clearTimeout(maxTimer);

      // Construir blob final si no lo hizo el 'stop'
      if (!blob || blob.size === 0) {
        if (chunks.length) blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/mp4' });
      }

      // Mostrar preview si existen elementos
      if (player && blob && blob.size) {
        player.src = URL.createObjectURL(blob);
        player.load();
      }
      if (previewWrap) previewWrap.classList.remove('hidden');
      // Ocultar botón de grabar si así lo definiste en tu flujo
      // btn.classList.add('hidden');

      setBtnState('preview');
      document.documentElement.classList.remove('rec-on');

    } catch (err) {
      console.error('Error al detener grabación:', err);
      setBtnState('idle');
      document.documentElement.classList.remove('rec-on');
    } finally {
      // Reset gestos
      gestureMode = null;
      pointerIsDown = false;
      ignoreNextPointerUp = false;
      clearTimeout(holdTimer);
    }
  }

  function resetToIdle(){
    // Limpia preview y vuelve a mostrar botón
    if (player) { try { player.pause(); URL.revokeObjectURL(player.src); } catch {} player.removeAttribute('src'); }
    if (previewWrap) previewWrap.classList.add('hidden');
    // btn.classList.remove('hidden');
    blob = null; chunks = [];
    setBtnState('idle');
    updateCounter();
  }

  // Reemplazar listeners antiguos por nuevos sin duplicar
  const freshBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(freshBtn, btn);
  const target = freshBtn;

  function onPointerDown(e){
    e.preventDefault();
    e.stopPropagation();
    target.setPointerCapture?.(e.pointerId);
    pointerIsDown = true;
    pointerDownAt = Date.now();

    if (!isRecording) {
      // Arrancamos de inmediato para no perder el inicio del audio
      startRecording().then(()=>{
        gestureMode = 'undecided'; // decidimos en función del tiempo presionado
        // Si transcurre más que el umbral, lo tratamos como HOLD
        holdTimer = setTimeout(()=>{
          if (pointerIsDown && isRecording && gestureMode === 'undecided') {
            gestureMode = 'hold';
          }
        }, HOLD_THRESHOLD_MS);
      });
    } else {
      // Ya estamos grabando
      if (gestureMode === 'toggle' || gestureMode === 'undecided') {
        // Segundo tap: detenemos en pointerdown (más responsivo y evita corte a ~1s)
        ignoreNextPointerUp = true;
        stopRecording();
      }
      // Si era 'hold', no hacemos nada aquí; se detendrá en pointerup
    }
  }

  function onPointerUp(e){
    if (ignoreNextPointerUp) {
      ignoreNextPointerUp = false;
      pointerIsDown = false;
      clearTimeout(holdTimer);
      return;
    }
    pointerIsDown = false;
    clearTimeout(holdTimer);

    if (!isRecording) return;

    const pressedMs = Date.now() - pointerDownAt;

    if (gestureMode === 'undecided') {
      // Fue un tap corto: clasificamos como TOGGLE y NO detenemos aquí.
      if (pressedMs < HOLD_THRESHOLD_MS) {
        gestureMode = 'toggle';
        // queda grabando hasta el próximo tap (que detiene en pointerdown)
        return;
      } else {
        // por si el timer no alcanzó, tratar como hold
        gestureMode = 'hold';
      }
    }

    if (gestureMode === 'hold') {
      // Soltar = detener
      stopRecording();
    }
    // Si es 'toggle', no se detiene aquí (se detiene en el próximo pointerdown)
  }

  function onPointerLeave(e){
    // En HOLD, salir del botón debe detener (similar a WhatsApp)
    if (pointerIsDown && isRecording && gestureMode === 'hold') {
      stopRecording();
    }
    pointerIsDown = false;
    clearTimeout(holdTimer);
  }

  function onPointerCancel(e){
    if (pointerIsDown && isRecording && gestureMode === 'hold') {
      stopRecording();
    }
    pointerIsDown = false;
    clearTimeout(holdTimer);
  }

  target.addEventListener('pointerdown', onPointerDown, { passive:false });
  target.addEventListener('pointerup', onPointerUp, { passive:false });
  target.addEventListener('pointerleave', onPointerLeave, { passive:true });
  target.addEventListener('pointercancel', onPointerCancel, { passive:true });
  // Ignorar click sintético (evita dobles paradas)
  target.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); }, { capture:true });

  // Botón "Grabar de nuevo"
  if (recordAgainBtn) {
    recordAgainBtn.addEventListener('click', (e)=>{
      e.preventDefault();
      if (isRecording) stopRecording();
      resetToIdle();
    });
  }

  // Inicializar UI
  setBtnState('idle');
  updateCounter();

})();

  moreBtn.addEventListener('click', async()=>{ await loadSixReplace(); });
}
