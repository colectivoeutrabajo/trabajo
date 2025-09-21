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
  BATCH_LIMIT = '20',
  LANGUAGE = 'es',
  MARK_BAD = 'true',
  DRY_RUN = 'false',
  WHISPER_BIN = './whisper.cpp/build-cache/main',
  WHISPER_MODEL = './whisper.cpp/models/ggml-small.bin',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
const isDry = DRY_RUN.toLowerCase() === 'true';
const markBad = MARK_BAD.toLowerCase() === 'true';

async function markAsBad(rows) {
  if (!rows.length) return;
  console.log(`Marcando ${rows.length} registros como approved=false (rotos)…`);
  if (isDry) { console.log('[DRY_RUN] No se actualiza DB'); return; }

  const ids = rows.map(r => r.id).filter(Boolean);
  if (ids.length) {
    const { error } = await sb.from(SUPABASE_TABLE).update({ approved: false }).in('id', ids);
    if (error) console.warn('Update por id falló, intentaré por file_path:', error);
  }
  // fallback por file_path (por si no hay id)
  const fps = rows.filter(r => !r.id).map(r => r.file_path);
  if (fps.length) {
    const { error } = await sb.from(SUPABASE_TABLE).update({ approved: false }).in('file_path', fps);
    if (error) console.warn('Update por file_path falló:', error);
  }
}

async function fetchBroken() {
  let q = sb.from(SUPABASE_TABLE)
    .select('id,file_path,size_bytes,duration_seconds,approved')
    .eq('approved', true)
    .or('duration_seconds.is.null,duration_seconds.eq.0,size_bytes.lte.1024')
    .limit(200);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function fetchCandidates(limit=20) {
  let q = sb.from(SUPABASE_TABLE)
    .select('id,file_path,mime_type,size_bytes,duration_seconds,approved,transcript,created_at')
    .eq('approved', true)
    .is('transcript', null)
    .gt('size_bytes', 1024)
    .gt('duration_seconds', 0)
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
  await exec('ffmpeg', ['-y', '-i', inFile, '-ac', '1', '-ar', '16000', '-vn', outFile]);
  return outFile;
}

async function whisperTranscribe(wavFile, lang='es') {
  // whisper.cpp genera un .txt con -otxt y prefijo dado por -of
  const outPrefix = wavFile.replace(/\.wav$/i, '');
  const args = [
    '-m', WHISPER_MODEL,
    '-f', wavFile,
    '-l', lang,
    '-otxt',
    '-of', outPrefix,
    '-np', '1',   // no-parallel, estable
  ];
  await exec(WHISPER_BIN, args, { timeout: 120000 }); // 120s por archivo (30s audio es rápido)
  const txtPath = `${outPrefix}.txt`;
  const txt = await fs.readFile(txtPath, 'utf8').catch(()=> '');
  return (txt || '').trim();
}

async function updateTranscript(row, text) {
  if (isDry) {
    console.log(`[DRY_RUN] UPDATE transcript (${row.file_path}): "${text.slice(0,80)}..."`);
    return;
  }
  const updates = { transcript: text || '' };
  if (row.id) {
    const { error } = await sb.from(SUPABASE_TABLE).update(updates).eq('id', row.id);
    if (!error) return;
    console.warn('Update por id falló, intento por file_path:', error);
  }
  const { error } = await sb.from(SUPABASE_TABLE).update(updates).eq('file_path', row.file_path);
  if (error) throw error;
}

async function run() {
  console.log('=== STT nocturno con whisper.cpp (small, es) ===');

  // 1) Marcar rotos (si procede)
  if (markBad) {
    const broken = await fetchBroken();
    const trulyBroken = (broken || []).filter(r =>
      (r.duration_seconds == null || r.duration_seconds === 0) ||
      (r.size_bytes != null && r.size_bytes <= 1024)
    );
    if (trulyBroken.length) await markAsBad(trulyBroken);
    console.log(`Rotos detectados: ${trulyBroken.length}`);
  }

  // 2) Tomar candidatos
  const batch = await fetchCandidates(parseInt(BATCH_LIMIT,10));
  console.log(`Candidatos transcript=NULL: ${batch.length}`);
  if (!batch.length) { console.log('Nada que transcribir.'); return; }

  // 3) Procesar uno a uno
  for (const row of batch) {
    console.log(`\n→ ${row.file_path}`);
    try {
      const { dir, file } = await downloadToTemp(row.file_path);
      const wav = await toWav16kMono(file);
      const text = await whisperTranscribe(wav, LANGUAGE);
      if (!text) {
        console.warn('   [Aviso] Transcripción vacía');
      } else {
        console.log(`   Texto: "${text.slice(0,80)}..."`);
      }
      await updateTranscript(row, text);
      // cleanup
      try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    } catch (e) {
      console.error('   ✗ Error:', e?.message || e);
      // NO marcamos bad aquí; solo los rotos por regla previa
    }
    await sleep(100);
  }

  console.log('\nTerminado lote nocturno.');
}

run().catch(err => {
  console.error('Fallo general:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
