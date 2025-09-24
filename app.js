/***** CONFIGURACIÓN *****/
const SUPABASE_URL = 'https://kozwtpgopvxrvkbvsaeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtvend0cGdvcHZ4cnZrYnZzYWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgwNDU0NDAsImV4cCI6MjA3MzYyMTQ0MH0.VhF49ygm9y5LN5Fkd1INGJB9aqJjbn8cd3LjaRiT5o8';

const MAX_SECONDS = 30;
const EMOJI_INTERVAL_MS = 2000;
const MIN_REC_MS = 600;                      // evita blobs vacíos por taps ultracortos
const HOLD_THRESHOLD_MS = 350;               // umbral para considerar "hold"
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const TAIL_PAD_MS        = isIOS() ? 400 : 200;  // colita breve al soltar
const STOP_FLUSH_WAIT_MS = isIOS() ? 250 : 150;  // espera último chunk
const FORCE_NEW_STREAM_EVERY_TIME = false;       // reusar stream si está vivo

/***** SUPABASE *****/
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/***** UI HELPERS *****/
const $ = (s)=>document.querySelector(s);
const showToast = (m)=>{ const t=$('#toast'); if(!t) return; t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2600); };
const showSpinner = (on=true)=>{ const s=$('#spinner'); if(!s) return; s.classList.toggle('hidden',!on); };

/***** EMOJIS *****/
const EMOJIS=[": D",": )",": |",": (",":’(",": S"];
const pickEmoji=(prev=null)=>{ let e=EMOJIS[Math.floor(Math.random()*EMOJIS.length)]; if(prev&&e===prev) e=EMOJIS[(EMOJIS.indexOf(e)+1)%EMOJIS.length]; return e; };

/***** GEO IP *****/
const IP_PROVIDERS=['https://ipapi.co/json/','https://ipwho.is/'];
async function getGeoByIP(){
  for(const url of IP_PROVIDERS){
    try{ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) continue;
      const j=await r.json();
      if(j&&(j.city||j.country||j.region||j.ip)){
        return { ip:j.ip||j.query||null, city:j.city||null, region:j.region||j.regionName||null, country:j.country||j.country_name||j.countryCode||null };
      }
    }catch(_){}
  }
  return { ip:null, city:null, region:null, country:null };
}

/***** MIME *****/
function pickSupportedMime(){
  const iosFirst=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'];
  const generic =['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'];
  const cands=isIOS()?iosFirst:generic;
  for(const t of cands){ if(window.MediaRecorder?.isTypeSupported?.(t)) return t; }
  return isIOS()?'audio/mp4':'audio/webm';
}
function extensionFromMime(m){
  if(!m) return isIOS()?'m4a':'webm';
  if(m.includes('mp4'))  return 'm4a';
  if(m.includes('webm')) return 'webm';
  if(m.includes('m4a'))  return 'm4a';
  if(m.includes('mpeg')) return 'mp3';
  if(m.includes('ogg'))  return 'ogg';
  if(m.includes('wav'))  return 'wav';
  return isIOS()?'m4a':'webm';
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

  // Emojis (cada 2s con disolver; se pausan en grabación/preview)
  let currentEmoji=pickEmoji(); emojiDisplay.textContent=currentEmoji;
  let emojiTimer=null;
  const startEmojiLoop=()=>{ stopEmojiLoop(); emojiTimer=setInterval(()=>{ emojiDisplay.classList.add('fading'); setTimeout(()=>{ currentEmoji=pickEmoji(currentEmoji); emojiDisplay.textContent=currentEmoji; emojiDisplay.classList.remove('fading'); },150); },EMOJI_INTERVAL_MS); };
  const stopEmojiLoop =()=>{ if(emojiTimer){ clearInterval(emojiTimer); emojiTimer=null; } };
  startEmojiLoop();

  // Estado de grabación
  let stream=null, mediaRecorder=null, chunks=[];
  let startTs=0, durationMs=0, blob=null, mimeType=pickSupportedMime();
  let stopTimer=null, counterInt=null;
  let state='idle'; // idle | starting | recording | stopping | preview

  // Estado de gestos
  let holdTimer=null, isHolding=false;
  let toggleArmed=false;       // ← si true, el próximo tap detiene
  let pendingStop=false;       // ← si presionan para parar mientras aún está “starting”

  const updateCounter=()=>{ if(state!=='recording') return;
    const secs=Math.min(MAX_SECONDS, Math.floor((Date.now()-startTs)/1000));
    const s=(n)=> n<10?('0'+n):(''+n);
    counter.textContent=`0:${s(secs)} / 0:${s(MAX_SECONDS)}`;
  };

    // === PREWARM: pedir micrófono al abrir (y reusar el stream) ===
  let prewarmed = false; // evita pedirlo dos veces

  async function prewarmMicAtLoad() {
    if (prewarmed) return;
    prewarmed = true;
    try {
      // 1) Si el permiso ya está concedido, abre el stream y déjalo listo
      if (navigator.permissions?.query) {
        try {
          const st = await navigator.permissions.query({ name: 'microphone' });
          if (st.state === 'granted') {
            // usa las variables 'stream' ya definidas en initRecordPage
            stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            return;
          }
        } catch (_) { /* Safari puede no soportar bien permissions */ }
      }

      // 2) Intenta pedirlo inmediatamente al cargar
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // Si llega aquí, ya no habrá prompt al tocar el botón
    } catch (e) {
      // 3) Fallback iOS/UA: algunos requieren un gesto del usuario.
      //    Pídelo en el PRIMER toque en cualquier parte (no en el botón).
      const firstTouchAsk = async () => {
        document.removeEventListener('pointerdown', firstTouchAsk, true);
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch (_) {
          // Si aún falla, el permiso será pedido al tocar "Grabar" como último recurso
        }
      };
      document.addEventListener('pointerdown', firstTouchAsk, true);
    }
  }

  // Lánzalo apenas entra a la pantalla de grabar (no bloquea la UI):
  setTimeout(prewarmMicAtLoad, 100);
//hsta aqui codigo generado por mi
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
    toggleArmed=false; pendingStop=false; isHolding=false; clearTimeout(holdTimer); holdTimer=null;
    startEmojiLoop();
  }
  resetUI();

  function releaseStream(){ try{ stream?.getTracks?.().forEach(t=>{ try{ t.stop(); }catch(_){ } }); }catch(_){ } stream=null; }
  async function acquireStreamFresh(){ try{ return await navigator.mediaDevices.getUserMedia({audio:true}); }catch(_){ showToast('No hay permiso de micrófono'); return null; } }

  async function ensureStreamForStart(){
    if(FORCE_NEW_STREAM_EVERY_TIME){
      releaseStream();
      stream=await acquireStreamFresh();
      return !!stream;
    }
    const tr=stream?.getAudioTracks?.()[0];
    if(tr && tr.readyState==='live' && tr.enabled) return true;
    stream=await acquireStreamFresh(); return !!stream;
  }

  async function startRecording(){
    if(state!=='idle' && state!=='preview') return false;
    state='starting';

    // UI INMEDIATA (rojo) para feedback visual
    recordBtn.setAttribute('aria-pressed','true');
    recordBtn.classList.add('btn-recording','is-pressed');
    recordBtnText.textContent='Grabando…';
    stopEmojiLoop();

    const ok=await ensureStreamForStart();
    if(!ok){
      recordBtn.setAttribute('aria-pressed','false');
      recordBtn.classList.remove('btn-recording','is-pressed');
      recordBtnText.textContent='Grabar';
      startEmojiLoop();
      state='idle';
      return false;
    }

    chunks=[]; blob=null;
    try{ mediaRecorder=new MediaRecorder(stream,{mimeType}); }
    catch(_){ mediaRecorder=new MediaRecorder(stream); mimeType=mediaRecorder.mimeType||mimeType; }

    mediaRecorder.addEventListener('dataavailable',(e)=>{ if(e.data && e.data.size>0){ chunks.push(e.data); } });

    if (isIOS()){
      mediaRecorder.start(); // single-blob en iOS
    } else {
      mediaRecorder.start(250); // timeslice regular
      mediaRecorder.addEventListener('start',()=>{ try{ setTimeout(()=>mediaRecorder.requestData(),200); }catch(_){ } });
      setTimeout(()=>{ try{ mediaRecorder.requestData(); }catch(_){ } },800);
    }

    startTs=Date.now();
    state='recording';
    counterInt = setInterval(updateCounter, 200);
    stopTimer  = setTimeout(()=> stopRecording(true), MAX_SECONDS*1000);

    // Si alguien ya “pulsó para detener” mientras estaba en starting:
    if(pendingStop){ pendingStop=false; await stopRecording(false); }

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

    // Reset de gestos
    toggleArmed=false; isHolding=false; clearTimeout(holdTimer); holdTimer=null;
  }

  // ── GESTOS: dual (tap/toggle + hold) ─────────────────────────────
  recordBtn.addEventListener('contextmenu', e=> e.preventDefault());

  recordBtn.addEventListener('pointerdown', async (e)=>{
    e.preventDefault();
    recordBtn.classList.add('is-pressed');

    // si estamos idle/preview → iniciar y armar toggle para el PRÓXIMO tap
    if(state==='idle' || state==='preview'){
      isHolding=false;
      clearTimeout(holdTimer);
      holdTimer=setTimeout(()=>{ isHolding=true; }, HOLD_THRESHOLD_MS);

      const started = await startRecording();
      if(started){
        toggleArmed = true;       // próximo tap detiene
      }
      return;
    }

    // si ya estaba arrancando y el usuario quiere parar con un tap:
    if(state==='starting'){
      // marca el stop como pendiente: detendremos en cuanto entre a "recording"
      pendingStop = true;
      return;
    }

    // si ya estaba grabando:
    if(state==='recording'){
      // Si está armado toggle → este tap detiene inmediatamente
      if(toggleArmed){
        toggleArmed = false;
        await stopRecording(false);
        return;
      }
      // si no estaba armado (caso raro), permite hold para detener al soltar
      isHolding=false;
      clearTimeout(holdTimer);
      holdTimer=setTimeout(()=>{ isHolding=true; }, HOLD_THRESHOLD_MS);
    }
  });

  function clearHoldVisual(){ recordBtn.classList.remove('is-pressed'); clearTimeout(holdTimer); holdTimer=null; }

  async function onPointerRelease(){
    // No hacer nada especial en tap corto del inicio: ya quedó armado toggleArmed=true
    if(state==='starting'){ /* esperar a toggle en pointerdown siguiente */ clearHoldVisual(); return; }

    // Si se mantuvo (hold) y estamos grabando → soltar detiene
    if(isHolding && state==='recording'){
      clearHoldVisual();
      await stopRecording(false);
      return;
    }

    // Tap corto mientras grababa: no hacer nada aquí (detiene en el siguiente pointerdown vía toggleArmed)
    clearHoldVisual();
  }

  recordBtn.addEventListener('pointerup',     (e)=>{ e.preventDefault(); onPointerRelease(); });
  recordBtn.addEventListener('pointercancel', (e)=>{ e.preventDefault(); onPointerRelease(); });
  recordBtn.addEventListener('pointerleave',  (e)=>{ e.preventDefault(); onPointerRelease(); });

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
 * ESCUCHAR (igual que tu versión actual)
 ***********************/
function initListenPage(){
  const list=$('#audioList');
  const loading=$('#loadingAudios');
  const moreBtn=$('#moreBtn');
  const testAud=document.createElement('audio');

  const isIOSLoc=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream;

  const isPlayableRow=(row)=>{
    const mime=(row.mime_type||'').toLowerCase();
    const path=(row.file_path||'').toLowerCase();
    if(isIOSLoc()) return mime.includes('mp4')||path.endsWith('.m4a')||path.endsWith('.mp4');
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
      const playable=batch.filter(isPlayableRow);
      picked = sampleRandomUnique(playable, 6, r=>r.file_path);
      tries++;
      limit += 40;
    }
    renderAudios(picked);
    loading.classList.add('hidden');
  }

  loadSixReplace();
  moreBtn?.addEventListener('click', loadSixReplace);
}
