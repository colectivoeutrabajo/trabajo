/***** CONFIGURACIÓN *****/
const SUPABASE_URL = 'https://kozwtpgopvxrvkbvsaeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtvend0cGdvcHZ4cnZrYnZzYWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgwNDU0NDAsImV4cCI6MjA3MzYyMTQ0MH0.VhF49ygm9y5LN5Fkd1INGJB9aqJjbn8cd3LjaRiT5o8';

const MAX_SECONDS = 30;
const EMOJI_INTERVAL_MS = 2000;
const MIN_REC_MS = 650;                    // evita taps ultra cortos
const TAIL_PAD_MS = /iPad|iPhone|iPod/.test(navigator.userAgent) ? 600 : 300;      // “colita” antes de parar (iOS más larga)
const STOP_FLUSH_WAIT_MS = /iPad|iPhone|iPod/.test(navigator.userAgent) ? 320 : 180; // espera del último chunk tras stop
const FORCE_NEW_STREAM_EVERY_TIME = true;  // stream fresco en cada intento

/***** CLIENTE SUPABASE *****/
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/***** HELPERS UI *****/
const $ = (s)=>document.querySelector(s);
const showToast = (m)=>{ const t=$('#toast'); if(!t) return; t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2600); };
const showSpinner = (on=true)=>{ const s=$('#spinner'); if(!s) return; s.classList.toggle('hidden',!on); };

/***** EMOJIS *****/
const EMOJIS=[": D",": )",": |",": (",":’(",": S"];
const pickEmoji=(prev=null)=>{ let e=EMOJIS[Math.floor(Math.random()*EMOJIS.length)]; if(prev&&e===prev) e=EMOJIS[(EMOJIS.indexOf(e)+1)%EMOJIS.length]; return e; };

/***** GEO IP (ligero) *****/
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
const isIOS = ()=> /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
function pickSupportedMime(){
  const prefs = isIOS()
    ? ['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus']
    : ['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'];
  for (const t of prefs){ if (window.MediaRecorder?.isTypeSupported?.(t)) return t; }
  return isIOS() ? 'audio/mp4' : 'audio/webm';
}
function extensionFromMime(m){
  if(!m) return isIOS()?'m4a':'webm';
  if(m.includes('mp4')) return 'm4a';
  if(m.includes('webm'))return 'webm';
  if(m.includes('m4a')) return 'm4a';
  if(m.includes('mpeg'))return 'mp3';
  if(m.includes('ogg')) return 'ogg';
  if(m.includes('wav')) return 'wav';
  return isIOS()?'m4a':'webm';
}

/***** ROUTER *****/
document.addEventListener('DOMContentLoaded',()=>{
  const page=document.body.dataset.page;
  if(page==='record') initRecordPage();
  if(page==='listen') initListenPage();
});

/***********************
 * PÁGINA: GRABAR
 ***********************/
async function initRecordPage(){
  const emojiDisplay=$('#emojiDisplay');
  const recordBtn=$('#recordBtn');
  const recordBtnText=$('#recordBtnText');
  const counter=$('#counter');
  const preview=$('#preview');
  const player=$('#player');

  // Emojis cada 2s con disolver
  let currentEmoji=pickEmoji(); emojiDisplay.textContent=currentEmoji;
  let emojiTimer=null;
  const startEmojiLoop=()=>{ stopEmojiLoop(); emojiTimer=setInterval(()=>{ emojiDisplay.classList.add('fading'); setTimeout(()=>{ currentEmoji=pickEmoji(currentEmoji); emojiDisplay.textContent=currentEmoji; emojiDisplay.classList.remove('fading'); },150); },EMOJI_INTERVAL_MS); };
  const stopEmojiLoop =()=>{ if(emojiTimer){ clearInterval(emojiTimer); emojiTimer=null; } };
  startEmojiLoop();

  // Estado de grabación
  let stream=null, mediaRecorder=null, chunks=[];
  let startTs=0, durationMs=0, blob=null, mimeType=pickSupportedMime();
  let speechRec=null, stopTimer=null, counterInt=null;
  let state='idle'; // idle | starting | recording | stopping | preview

  const updateCounter=()=>{ if(state!=='recording') return;
    const secs=Math.min(MAX_SECONDS, Math.floor((Date.now()-startTs)/1000));
    const s=(n)=> n<10?('0'+n):(''+n);
    counter.textContent=`0:${s(secs)} / 0:${s(MAX_SECONDS)}`;
  };

  function resetUI(){
    state='idle';
    recordBtn.setAttribute('aria-pressed','false');
    recordBtn.classList.remove('btn-recording','hidden');
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

  function startSpeech(){
    if (isIOS()) return; // deshabilitado en iOS para no mostrar avisos extra
    const SR = window.SpeechRecognition||window.webkitSpeechRecognition; if(!SR) return;
    const rec=new SR(); rec.lang='es-MX'; rec.interimResults=true; rec.continuous=true;
    rec.onerror=()=>{}; try{ rec.start(); speechRec=rec; }catch(_){}
  }
  function stopSpeech(){ try{ speechRec&&speechRec.stop(); }catch(_){} speechRec=null; }

  async function startRecording(){
    if(state!=='idle' && state!=='preview') return false;
    state='starting';

    // stream fresco siempre (no vuelve a pedir permiso si ya está concedido)
    releaseStream();
    stream=await acquireStreamFresh();
    if(!stream){ state='idle'; return false; }

    // MediaRecorder
    chunks=[]; blob=null;
    try{ mediaRecorder=new MediaRecorder(stream,{mimeType}); }
    catch(_){ mediaRecorder=new MediaRecorder(stream); mimeType=mediaRecorder.mimeType||mimeType; }

    let gotAny=false;
    mediaRecorder.addEventListener('dataavailable',(e)=>{ if(e.data && e.data.size>0){ gotAny=true; chunks.push(e.data); } });
    mediaRecorder.addEventListener('start',()=>{ try{ setTimeout(()=>mediaRecorder.requestData(), 200); }catch(_){ } });

    mediaRecorder.start(250); // chunks ~250ms

    // UI ← grabando (sin pulso)
    startTs=Date.now();
    recordBtn.setAttribute('aria-pressed','true');
    recordBtn.classList.add('btn-recording');
    recordBtnText.textContent='Grabando…';
    stopEmojiLoop(); startSpeech(); state='recording';

    // contador
    counterInt = setInterval(updateCounter, 200);

    // si no llegó nada en 800ms, pedir un chunk
    setTimeout(()=>{ if(state==='recording' && !gotAny){ try{ mediaRecorder.requestData(); }catch(_){ } } }, 800);

    // límite duro a 30s
    stopTimer=setTimeout(()=> stopRecording(), MAX_SECONDS*1000);
    return true;
  }

  async function stopRecording(){
    if(state!=='recording' || !mediaRecorder) return;
    state='stopping';

    // duración mínima + colita para no cortar el final (más larga en iOS)
    const elapsed=Date.now()-startTs;
    const needMin=Math.max(0, MIN_REC_MS - elapsed);
    if(needMin) await new Promise(r=>setTimeout(r,needMin));
    if(TAIL_PAD_MS) await new Promise(r=>setTimeout(r,TAIL_PAD_MS));

    try{ mediaRecorder.requestData(); }catch(_){ }
    const stopped=new Promise(res=> mediaRecorder.addEventListener('stop',res,{once:true}));
    try{ mediaRecorder.stop(); }catch(_){ }
    if(stopTimer){ clearTimeout(stopTimer); stopTimer=null; }
    if(counterInt){ clearInterval(counterInt); counterInt=null; }
    stopSpeech();

    await stopped;
    await new Promise(r=>setTimeout(r, STOP_FLUSH_WAIT_MS)); // esperar último chunk

    const built = (chunks && chunks.length) ? new Blob(chunks,{type: mimeType || mediaRecorder?.mimeType || (isIOS()?'audio/mp4':'audio/webm')}) : null;
    if(!built || built.size===0){
      showToast('No se capturó audio. Intenta de nuevo.');
      releaseStream();
      resetUI(); 
      return;
    }
    blob=built; durationMs=Date.now()-startTs;

    // Preview
    const url=URL.createObjectURL(blob);
    const reveal=()=>{
      preview.classList.remove('hidden');
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

  // BOTÓN: toggle simple (click = iniciar / click = parar)
  recordBtn.addEventListener('click', async ()=>{
    if (state==='idle' || state==='preview') { await startRecording(); return; }
    if (state==='recording') { await stopRecording(); return; }
  });

  // Grabar de nuevo → reset limpio
  $('#redoBtn')?.addEventListener('click',()=>{
    try{ mediaRecorder && mediaRecorder.state==='recording' && mediaRecorder.stop(); }catch(_){}
    releaseStream();
    recordBtn.classList.remove('hidden');
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
 * PÁGINA: ESCUCHAR (igual que la tuya)
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
      const compatibles=batch.filter(isPlayableRow);
      picked=sampleRandomUnique(compatibles,6,x=>x.file_path);
      if(picked.length>=6) break;
      limit+=60; tries++;
    }
    if(picked.length===0){ showToast('No hay audios compatibles aún'); }
    renderAudios(picked); loading.classList.add('hidden');
  }

  (async()=>{ await loadSixReplace(); })();
  moreBtn.addEventListener('click', async()=>{ await loadSixReplace(); });
}
