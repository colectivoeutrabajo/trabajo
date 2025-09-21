// scripts/transcribe.mjs
import { createClient } from '@supabase/supabase-js';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

// === ENV ===
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = 'audios',
  SUPABASE_TABLE = 'recordings',
  BATCH_LIMIT = '30',
  LANGUAGE = 'es',
  MARK_BAD = 'true',
  DRY_RUN = 'false',
  TRANSCRIPT_COLUMN = 'transcript',
  WHISPER_BIN = './whisper.cpp/build/bin/whisper-cli',
  WHISPER_MODEL = './whisper.cpp/models/ggml-small.bin',
  LD_LIBRARY_PATH = '',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
const isDry = DRY_RUN.toLowerCase() === 'true';
const markBad = MARK_BAD.toLowerCase() === 'true';

function isBroken(row) {
  const sz = row.size_bytes;
  const dur = row.duration_seconds;
  return (dur == null || dur === 0) || (sz != null && sz <= 1024);
}

async function markAsBad(rows) {
  if (!rows.length) return;
  console.log(`Marcando ${rows.length} registros como approved=false (rotos)…`);
  if (isDry) { console.log('[DRY_RUN] No se actualiza DB'); return; }

  const ids = rows.map(r => r.id).filter(Boolean);
  if (ids.length) {
    const { error } = await sb.from(SUPABASE_TABLE).update({ approved: false }).in('id', ids);
    if (error) console.warn('Update por id falló, intentaré por file_path:', error);
  }
  const fps = rows.filter(r => !r.id).map(r => r.file_path);
  if (fps.length) {
    const { error } = await sb.from(SUPABASE_TABLE).update({ approved: false }).in('file_path', fps);
    if (error) console.warn('Update por file_path falló:', error);
  }
}

async function fetchBroken() {
  let q = sb.from(SUPABASE_TABLE)
    .select(`id,file_path,size_bytes,duration_seconds,approved`)
    .eq('approved', true)
    .or('duration_seconds.is.null,duration_seconds.eq.0,size_bytes.lte.1024')
    .limit(200);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function fetchCandidates(limit=30) {
  // No filtramos size/duration aquí; tratamos "rotos" aparte
  let q = sb.from(SUPABASE_TABLE)
    .select(`id,file_path,mime_type,size_bytes,duration_seconds,approved,${TRANSCRIPT_COLUMN},created_at`)
    .eq('approved', true)
    .is(TRANSCRIPT_COLUMN, null)
    .order('created_at', { ascending: true })
    .limit(parseInt(limit,10));
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function downloadToTemp(storagePath) {
  const { data, error } = await sb.storage.from(SUPABASE_BUCKET).download(storagePath);
  if (error) throw error;
  const ab = await data.arrayBuffer();
  const buf = Buffer.from(ab);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stt-'));
  const file = path.join(dir, path.basename(storagePath));
  await fs.writeFile(file, buf);
  return { dir, file };
}

async function toWav16kMono(inFile) {
  const outFile = inFile.replace(path.extname(inFile), '.wav');
  await exec('ffmpeg', ['-y', '-v', 'error', '-i', inFile, '-ac', '1', '-ar', '16000', '-vn', outFile]);
  const st = await fs.stat(outFile);
  if (!st || st.size <= 44) {
    throw new Error(`WAV inválido o vacío (${outFile}, size=${st?.size||0})`);
  }
  return outFile;
}

async function whisperTranscribe(wavFile, lang='es') {
  const outPrefix = wavFile.replace(/\.wav$/i, '');
  const args = [
    '-m', WHISPER_MODEL,
    '-f', wavFile,
    '-l', lang,
    '-otxt',
    '-of', outPrefix,
    '-np', '1',
  ];
  console.log('   Ejecutando:', WHISPER_BIN, args.join(' '));
  try {
    await exec(WHISPER_BIN, args, {
      timeout: 180000,
      env: { ...process.env, LD_LIBRARY_PATH }
    });
  } catch (e) {
    console.error('   Whisper stderr:\n', e?.stderr || '(sin stderr)');
    console.error('   Whisper stdout:\n', e?.stdout || '(sin stdout)');
    throw new Error(e?.message || e);
  }
  const txtPath = `${outPrefix}.txt`;
  const txt = await fs.readFile(txtPath, 'utf8').catch(()=> '');
  return (txt || '').trim();
}

async function updateTranscript(row, text) {
  const updates = {};
  updates[TRANSCRIPT_COLUMN] = text || '';
  if (isDry) {
    console.log(`[DRY_RUN] UPDATE ${TRANSCRIPT_COLUMN} (${row.file_path}): "${text.slice(0,80)}..."`);
    return;
  }
  if (row.id) {
    const { error } = await sb.from(SUPABASE_TABLE).update(updates).eq('id', row.id);
    if (!error) return;
    console.warn('Update por id falló, intento por file_path:', error);
  }
  const { error } = await sb.from(SUPABASE_TABLE).update(updates).eq('file_path', row.file_path);
  if (error) throw error;
}

async function verifyUpdated(row) {
  let q = sb.from(SUPABASE_TABLE).select(`id,${TRANSCRIPT_COLUMN}`).eq('file_path', row.file_path).limit(1);
  const { data, error } = await q;
  if (error) { console.warn('Verificación falló:', error); return null; }
  const got = data?.[0]?.[TRANSCRIPT_COLUMN] ?? null;
  return got;
}

async function preflight() {
  const binOk = await fs.stat(WHISPER_BIN).then(()=>true).catch(()=>false);
  const mdlOk = await fs.stat(WHISPER_MODEL).then(()=>true).catch(()=>false);
  if (!binOk) throw new Error(`No existe WHISPER_BIN en ruta: ${WHISPER_BIN}`);
  if (!mdlOk) throw new Error(`No existe WHISPER_MODEL en ruta: ${WHISPER_MODEL}`);
  console.log('Preflight OK. BIN y MODEL presentes.');
}

async function run() {
  console.log(`=== STT nocturno con whisper.cpp (small, ${LANGUAGE}) ===`);
  console.log(`Tabla=${SUPABASE_TABLE} Bucket=${SUPABASE_BUCKET} Lote=${BATCH_LIMIT} Columna=${TRANSCRIPT_COLUMN}`);
  await preflight();

  if (markBad) {
    const broken = await fetchBroken();
    const trulyBroken = (broken || []).filter(isBroken);
    if (trulyBroken.length) await markAsBad(trulyBroken);
    console.log(`Rotos detectados y marcados: ${trulyBroken.length}`);
  }

  const batch = await fetchCandidates(parseInt(BATCH_LIMIT,10));
  console.log(`Candidatos transcript=NULL: ${batch.length}`);
  batch.slice(0,10).forEach((r,i)=>{
    console.log(`  ${i+1}. id=${r.id} path=${r.file_path} bytes=${r.size_bytes ?? 'null'} dur=${r.duration_seconds ?? 'null'}`);
  });
  if (!batch.length) { console.log('Nada que transcribir.'); return; }

  for (const row of batch) {
    console.log(`\n→ ${row.file_path}`);
    try {
      if (isBroken(row)) {
        console.warn('   Archivo roto (bytes<=1024 o dur<=0). Marcando y saltando.');
        if (markBad && !isDry) await markAsBad([row]);
        continue;
      }

      const { dir, file } = await downloadToTemp(row.file_path);
      const wav = await toWav16kMono(file);
      const text = await whisperTranscribe(wav, LANGUAGE);

      if (!text) {
        console.warn('   [Aviso] Transcripción vacía (se guardará vacío)');
      } else {
        console.log(`   Texto: "${text.slice(0,80)}..."`);
      }

      await updateTranscript(row, text);

      const got = await verifyUpdated(row);
      console.log(`   Verificación post-update: ${TRANSCRIPT_COLUMN} = ${got === null ? 'NULL' : (got ? `"${String(got).slice(0,40)}..."` : '"" (vacío)')}`);

      try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    } catch (e) {
      console.error('   ✗ Error:', e?.message || e);
    }
    await sleep(100);
  }

  console.log('\nTerminado lote.');
}

run().catch(err => {
  console.error('Fallo general:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
