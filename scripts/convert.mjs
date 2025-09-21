// scripts/convert.mjs
import { createClient } from '@supabase/supabase-js';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = 'audios',
  SUPABASE_TABLE = 'recordings',
  BATCH_LIMIT = '30',
  APPROVED_ONLY = 'true',
  DRY_RUN = 'false',
  BITRATE = '64k',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function needsConversion(row) {
  const mime = (row.mime_type || '').toLowerCase();
  const fp = (row.file_path || '').toLowerCase();
  return (
    fp.endsWith('.webm') || mime.includes('webm') ||
    fp.endsWith('.ogg')  || mime.includes('ogg')  ||
    fp.endsWith('.wav')  || mime.includes('wav')
  );
}
function targetPath(oldPath) {
  const ext = path.extname(oldPath);
  return oldPath.slice(0, -ext.length) + '.m4a';
}

async function ffprobeDurationSeconds(file) {
  try {
    const { stdout } = await exec('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file
    ]);
    const sec = parseFloat(stdout.trim());
    return isFinite(sec) ? Math.round(sec) : null;
  } catch (e) {
    console.warn('ffprobe fallo (dur):', e?.message || e);
    return null;
  }
}

async function transcodeToM4A(inFile, outFile, bitrate = '64k') {
  const args = [
    '-y',
    '-i', inFile,
    '-vn',
    '-acodec', 'aac',
    '-b:a', bitrate,
    '-ac', '1',
    '-ar', '48000',
    '-movflags', '+faststart',
    outFile
  ];
  await exec('ffmpeg', args);
}

async function downloadToTemp(storagePath) {
  const { data, error } = await sb.storage.from(SUPABASE_BUCKET).download(storagePath);
  if (error) throw error;
  const ab = await data.arrayBuffer();
  const buf = Buffer.from(ab);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conv-'));
  const file = path.join(dir, path.basename(storagePath));
  await fs.writeFile(file, buf);
  return { dir, file, size: buf.length };
}

async function uploadBuffer(newPath, buffer) {
  const { error } = await sb.storage
    .from(SUPABASE_BUCKET)
    .upload(newPath, buffer, { contentType: 'audio/mp4', upsert: true });
  if (error) throw error;
}

async function removePath(oldPath) {
  const { error } = await sb.storage.from(SUPABASE_BUCKET).remove([oldPath]);
  if (error) throw error;
}

async function updateRow(id, whereFilePath, updates) {
  // primero por id
  if (id) {
    const { error } = await sb.from(SUPABASE_TABLE).update(updates).eq('id', id);
    if (!error) return;
    console.warn(`Update por id falló:`, error);
  }
  // fallback por file_path
  const { error } = await sb.from(SUPABASE_TABLE).update(updates).eq('file_path', whereFilePath);
  if (error) throw error;
}

async function fetchBatch(limit = 30) {
  let query = sb
    .from(SUPABASE_TABLE)
    .select('id,file_path,mime_type,size_bytes,duration_seconds,approved,created_at')
    .order('created_at', { ascending: true })
    .limit(parseInt(limit, 10));

  if (APPROVED_ONLY.toLowerCase() === 'true') {
    query = query.eq('approved', true);
  }
  query = query.or(
    "mime_type.ilike.%webm%,file_path.ilike.%.webm%," +
    "mime_type.ilike.%ogg%,file_path.ilike.%.ogg%," +
    "mime_type.ilike.%wav%,file_path.ilike.%.wav%"
  );

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).filter(needsConversion);
}

async function run() {
  console.log('=== Conversión a M4A (reemplazo in-place) ===');
  console.log(`Tabla=${SUPABASE_TABLE} Bucket=${SUPABASE_BUCKET} Lote=${BATCH_LIMIT} ApprovedOnly=${APPROVED_ONLY} DRY_RUN=${DRY_RUN} Bitrate=${BITRATE}`);

  // Comprobación básica de Storage
  const { data: listing, error: listErr } = await sb.storage.from(SUPABASE_BUCKET).list('', { limit: 1 });
  if (listErr) {
    console.error('No pude listar el bucket. ¿Nombre correcto? ¿Permisos? Error:', listErr);
    process.exit(1);
  }

  const batch = await fetchBatch(BATCH_LIMIT);
  console.log(`Candidatos a convertir: ${batch.length}`);
  if (!batch.length) { console.log('Nada que hacer.'); return; }

  for (const row of batch) {
    const oldPath = row.file_path;
    const newPath = targetPath(oldPath);
    console.log(`\n→ ${oldPath}  (id: ${row.id ?? 's/id'})`);

    try {
      const { file: inFile, size: oldSize } = await downloadToTemp(oldPath);
      console.log(`   Descargado (${Math.round(oldSize/1024)} KB)`);

      const outFile = inFile.replace(path.extname(inFile), '.m4a');
      await transcodeToM4A(inFile, outFile, BITRATE);

      const newBuf = await fs.readFile(outFile);
      const durNew = await ffprobeDurationSeconds(outFile);
      const durOld = row.duration_seconds ?? null;

      if (durOld && durNew && Math.abs(durNew - durOld) > 1) {
        console.warn(`   Aviso: duración ${durOld}s → ${durNew}s`);
      }
      console.log(`   Subiendo ${newPath} (${Math.round(newBuf.length/1024)} KB)`);

      if (DRY_RUN.toLowerCase() !== 'true') {
        await uploadBuffer(newPath, newBuf);
        await updateRow(row.id, oldPath, {
          file_path: newPath,
          mime_type: 'audio/mp4',
          size_bytes: newBuf.length,
          duration_seconds: durNew ?? row.duration_seconds ?? null
        });
        await removePath(oldPath);
        console.log('   ✓ Reemplazado y original borrado');
      } else {
        console.log('   [DRY_RUN] Solo simulación (no se sube/actualiza/borra)');
      }

    } catch (e) {
      console.error('   ✗ Error en este archivo:', e?.message || e);
      if (e?.stack) console.error(e.stack);
      // seguimos con el siguiente
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
