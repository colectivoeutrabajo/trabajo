/***** CONFIGURACIÓN *****/
const SUPABASE_URL = 'https://kozwtpgopvxrvkbvsaeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9....iLCJpYXQiOjE3NTgwNDU0NDAsImV4cCI6MjA3MzYyMTQ0MH0.VhF49ygm9y5LN5F...'; // <-- tu anon key

const MAX_SECONDS = 30;
const EMOJI_INTERVAL_MS = 2000;
const MIN_REC_MS = 650;                          // evita blobs vacíos por taps ultracortos
const HOLD_THRESHOLD_MS = 550;                   // ↑ umbral: tap normal ≠ hold
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const TAIL_PAD_MS        = isIOS() ? 350 : 150;  // colita breve al soltar
const STOP_FLUSH_WAIT_MS = isIOS() ? 300 : 150;  // espera para último chunk

// 👉 IMPORTANTE: reusar el stream entre intentos (evita que el tap falle en el 2º intento)
const FORCE_NEW_STREAM_EVERY_TIME = false;

/***** SUPABASE *****/
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/***** HELPERS UI *****/
const $ = (s)=>document.querySelector(s);
const showToast = (m)=>{
  const t=$('#toast'); if(!t) return;
  t.textContent=m; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2600);
};
const showSpinner = (on=true)=>{ const s=$('#spinner'); if(!s) return; s.classList.toggle('hidden',!on); };

/***** EMOJIS *****/
const EMOJIS=[": D",": )",": |",": (",":’(",": S"];
const pickEmoji=(prev=null)=>{
  let e=EMOJIS[Math.floor(Math.random()*EMOJIS.length)];
  if(prev && e===prev) e=EMOJIS[(EMOJIS.indexOf(e)+1)%EMOJIS.length];
  return e;
};

/***** GEO IP *****/
async function getGeoByIP(){
  const providers=['https://ipapi.co/json/','https://ipwho.is/'];
  for(const url of providers){
    try{
      const r=await fetch(url,{cache:'no-store'});
      if(!r.ok) continue;
      const j=await r.json();
      if(j&&(j.city||j.country||j.region||j.ip)){
        return {
          ip:j.ip||j.query||null,
          city:j.city||null,
          region:j.region||j.regionName||null,
          country:j.country||j.country_name||j.countryCode||null
        };
      }
    }catch(_){}
  }
  return { ip:null, city:null, region:null, country:null };
}

/****************
 * GRABAR (index)
 *****************/
function extensionFromMime(m){
  if(!m) return isIOS()?'m4a':'webm';
  if(m.includes('mp4'))  return 'm4a';
  if(m.includes('webm')) return 'webm';
  if(m.includes('m4a'))  return 'm4a';
  if(m.includes('mpeg')) return 'mp3';
  if(m.includes('ogg'))  return 'ogg';
  return isIOS() ? 'm4a' : 'webm';
}
function pickSupportedMime(){
  const prefs = isIOS()
    ? ['audio/mp4','audio/aac','audio/webm;codecs=opus','audio/webm']
    : ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/aac'];
  for(const t of prefs){ if(window.MediaRecorder?.isTypeSupported?.(t)) return t; }
  return isIOS()? 'audio/mp4' : 'audio/webm';
}

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
  const startEmojiLoop=()=>{
    stopEmojiLoop();
    emojiTimer=setInterval(()=>{
      emojiDisplay.classList.add('fading');
      setTimeout(()=>{
        currentEmoji=pickEmoji(currentEmoji);
        emojiDisplay.textContent=currentEmoji;
        emojiDisplay.classList.remove('fading');
      },150);
    },EMOJI_INTERVAL_MS);
  };
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

  function releaseStream(){
    try{ stream?.getTracks?.().forEach(t=>{ try{ t.stop(); }catch(_){ } }); }catch(_){}
    stream=null;
  }
  async function acquireStreamFresh(){
    try{ return await navigator.mediaDevices.getUserMedia({audio:true, video:false}); }
    catch(_){ showToast('No hay permiso de micrófono'); return null; }
  }

  async function startRecording(){
    if(state!=='idle' && state!=='preview') return false;
    state='starting';

    // UI feedback INMEDIATO
    recordBtn.setAttribute('aria-pressed','true');
    recordBtn.classList.add('btn-recording','is-pressed');
    recordBtnText.textContent='Grabando…';
    stopEmojiLoop();

    // stream fresco solo si forzamos (por defecto: reusar)
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
      // iOS: sin timeslice, un solo blob al stop (más estable)
      mediaRecorder.start();
    } else {
      // Desktop: timeslice moderado para asegurar flush periódico
      mediaRecorder.start(250);
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
    if(state!=='recording' && state!=='starting') return;
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

    const built = (chunks && chunks.length)
      ? new Blob(chunks,{type: mimeType || mediaRecorder?.mimeType || (isIOS()?'audio/mp4':'audio/webm')})
      : null;

    if(!built || built.size===0){
      showToast('No se capturó audio. Intenta de nuevo.');
      // OJO: NO liberamos stream aquí; lo reusamos en el siguiente intento
      resetUI();
      return;
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
    // 👇 Importante: en iOS NO usar pointer capture
    if(!isIOS()){ try{ e.target.setPointerCapture(e.pointerId); }catch(_){ } }
    downAt = Date.now();
    startedByThisDown = (state==='idle' || state==='preview');
    if (startedByThisDown){
      await startRecording(); // inicio inmediato
    } else {
      // si ya estaba grabando, solo marcamos visual “presionado”
      recordBtn.classList.add('is-pressed');
    }
  });

  async function waitForRecording(timeout=800){
    const t0=Date.now();
    while(Date.now()-t0<timeout){
      if(state==='recording') return true;
      await new Promise(r=>setTimeout(r,10));
    }
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

  // Grabar de nuevo (NO cerramos el stream; así el siguiente tap funciona)
  $('#redoBtn')?.addEventListener('click',()=>{
    try{ mediaRecorder && mediaRecorder.state==='recording' && mediaRecorder.stop(); }catch(_){}
    // releaseStream();  <-- eliminado a propósito
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
      const fileName = `${crypto.randomUUID?.()||('rec-'+Date.now())}.${ext}`;
      const path = `recordings/${fileName}`;
      const geo = await getGeoByIP();

      const { data:up, error:upErr } = await sb.storage.from('audios').upload(path, blob, {
        contentType: blob.type || (isIOS()? 'audio/mp4' : 'audio/webm'),
        upsert: false
      });
      if(upErr) throw upErr;

      const { error:insErr } = await sb.from('recordings').insert([{
        file_path: path,
        mime_type: blob.type || (isIOS()? 'audio/mp4':'audio/webm'),
        size_bytes: blob.size,
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

/****************
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
    if(mime.includes('mp4')||path.endsWith('.m4a')||path.endsWith('.mp4')) return true;
    try{ const ok=testAud.canPlayType('audio/webm;codecs=opus')||testAud.canPlayType('audio/webm')||testAud.canPlayType('audio/ogg;codecs=opus'); if(ok) return true; }catch(_){}
    return false;
  };

  const sampleRandom=(arr,k)=>{
    if(arr.length<=k) return [...arr];
    const res=[]; for(let i=0;i<k;i++){ res.push(arr[Math.floor(Math.random()*arr.length)]); }
    return res;
  };

  function renderAudios(rows){
    list.innerHTML='';
    for(const r of rows){
      const card=document.createElement('div');
      card.className='audio-card';
      const a=document.createElement('audio');
      a.controls=true; a.preload='metadata'; a.setAttribute('playsinline','true');
      // URL pública
      const url = `${SUPABASE_URL}/storage/v1/object/public/audios/${r.file_path}`;
      a.src=url;
      const meta=document.createElement('div');
      meta.className='meta';
      meta.textContent = (r.duration_seconds!=null?`${r.duration_seconds}s`:'') + (r.location_city?` · ${r.location_city}`:'');
      card.appendChild(a); card.appendChild(meta);
      list.appendChild(card);
    }
  }

  async function fetchRecent(limit=60){
    const { data, error } = await sb
      .from('recordings')
      .select('id,file_path,mime_type,size_bytes,duration_seconds,location_city,created_at')
      .eq('approved', true)
      .order('created_at', { ascending:false })
      .limit(limit);
    if(error){ console.error(error); return []; }
    return data||[];
  }

  let cache=[], shown=new Set();

  async function loadMore(k=6){
    loading.classList.remove('hidden');

    let candidates = cache.filter(r => !shown.has(r.file_path));
    if (candidates.length < k){
      const fresh = (await fetchRecent(60)).filter(isPlayableRow);
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

/************
 * ROUTER
 ************/
document.addEventListener('DOMContentLoaded', ()=>{
  const page=document.body.dataset.page;
  if(page==='record') initRecordPage();
  if(page==='listen') initListenPage();
});
