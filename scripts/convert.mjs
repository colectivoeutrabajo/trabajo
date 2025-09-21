// scripts/convert.mjs
import { createClient } from '@supabase/supabase-js';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

/** === ENV ===
 * Configura estos secretos en GitHub Actions:
 * - SUPABASE_URL                 (https://xxx.supabase.co)
 * - SUPABASE_SERVICE_ROLE_KEY    (clave service_role - NUNCA en el cliente)
 * Opcionales (con defaults):
 * - SUPABASE_BUCKET=audios
 * - SUPABASE_TABLE=recordings
 * - BATCH_LIMIT=30
 * - APPROVED_ONLY=true
 * - DRY_RUN=false   (true => NO sube/borra, solo imprime qué haría)
 * - BITRATE=64k     (96k o 128k si prefieres más calidad)
 */
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

/** Utilidades **/
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function needsConversion(row) {
  const mime = (row.mime_type || '').toLowerCase();
  const fp = (row.file_path || '').toLowerCase();
  // Incompatibles con iOS/Safari:
  return (
    fp.endsWith('.webm') || mime.includes('webm') ||
    fp.endsWith('.ogg')  || mime.includes('ogg')  ||
    fp.endsWith('.wav')  || mime.includes('wav')
  );
}

function targetPath(oldPath) {
  // Reemplaza extensión por .m4a
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
  } catch {
    return null;
  }
}

async function transcodeToM4A(inFile, outFile, bitrate = '64k') {
  // AAC-LC, mono, 48kHz, faststart
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
  // Preferimos actualizar por id; si falla (no existe id), actualizamos por file_path
  if (id) {
    const { error } = await sb.from(SUPABASE_TABLE).update(updates).eq('id', id);
    if (!error) return;
    console.warn(`Update por id falló, probaré por file_path (${whereFilePath})`, error);
  }
  const { error } = await sb.from(SUPABASE_TABLE).update(updates).eq('file_path', whereFilePath);
  if (error) throw error;
}

async function fetchBatch(limit = 30) {
  // Selecciona candidatos a convertir
  let query = sb
    .from(SUPABASE_TABLE)
    .select('id,file_path,mime_type,size_bytes,duration_seconds,approved,created_at')
    .order('created_at', { ascending: true })
    .limit(parseInt(limit, 10));

  if (APPROVED_ONLY.toLowerCase() === 'true') {
    query = query.eq('approved', true);
  }
  // where mime/ext indica conversión
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
  console.log(`Tabla=${SUPABASE_TABLE}, Bucket=${SUPABASE_BUCKET}, Lote=${BATCH_LIMIT}, ApprovedOnly=${APPROVED_ONLY}, DRY_RUN=${DRY_RUN}, Bitrate=${BITRATE}`);
  const batch = await fetchBatch(BATCH_LIMIT);
  if (!batch.length) {
    console.log('No hay candidatos a convertir. Listo.');
    return;
  }
  console.log(`Candidatos: ${batch.length}`);

  for (const row of batch) {
    const oldPath = row.file_path;
    const newPath = targetPath(oldPath);
    console.log(`\n→ Procesando ${oldPath}  (id: ${row.id ?? 's/id'})`);

    try {
      // 1) Descargar original
      const { file: inFile } = await downloadToTemp(oldPath);

      // 2) Transcodificar
      const outFile = inFile.replace(path.extname(inFile), '.m4a');
      await transcodeToM4A(inFile, outFile, BITRATE);

      // 3) Verificar duración (mejor si no cae >0.8s)
      const durNew = await ffprobeDurationSeconds(outFile);
      const durOld = row.duration_seconds ?? null;
      if (durOld && durNew && Math.abs(durNew - durOld) > 1) {
        console.warn(`   Aviso: duración cambia ${durOld}s → ${durNew}s`);
      }

      // 4) Subir .m4a
      const buf = await fs.readFile(outFile);
      console.log(`   Subiendo ${newPath} (${Math.round(buf.length/1024)} KB)`);
      if (DRY_RUN.toLowerCase() !== 'true') {
        await uploadBuffer(newPath, buf);

        // 5) Actualizar fila (señalar nuevo path/mime/size/duración)
        await updateRow(row.id, oldPath, {
          file_path: newPath,
          mime_type: 'audio/mp4',
          size_bytes: buf.length,
          duration_seconds: durNew ?? row.duration_seconds ?? null
        });

        // 6) Borrar original
        await removePath(oldPath);
      } else {
        console.log('   [DRY_RUN] No se sube/actualiza/borra.');
      }

      console.log('   ✓ Listo');

    } catch (e) {
      console.error('   ✗ Error en este archivo:', e.message || e);
      // seguimos con el siguiente
    }
    // respiro pequeño
    await sleep(150);
  }

  console.log('\nTerminado lote.');
}

run().catch(err => {
  console.error('Fallo general:', err);
  process.exit(1);
});
