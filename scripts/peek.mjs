// scripts/peek-transcripts.mjs
import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_TABLE = 'recordings',
  APPROVED_ONLY = 'true',
  TRANSCRIPT_COLUMN = 'transcript',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function countApproved() {
  let q = sb.from(SUPABASE_TABLE).select('id', { count: 'exact', head: true });
  if (APPROVED_ONLY.toLowerCase() === 'true') q = q.eq('approved', true);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? null;
}

async function countTranscriptNull() {
  let q = sb.from(SUPABASE_TABLE)
    .select('id', { count: 'exact', head: true })
    .is(TRANSCRIPT_COLUMN, null);
  if (APPROVED_ONLY.toLowerCase() === 'true') q = q.eq('approved', true);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? null;
}

async function fetchSomeNull(n=10) {
  let q = sb.from(SUPABASE_TABLE)
    .select(`id,file_path,mime_type,size_bytes,duration_seconds,approved,${TRANSCRIPT_COLUMN}`)
    .is(TRANSCRIPT_COLUMN, null)
    .order('created_at', { ascending: true })
    .limit(n);
  if (APPROVED_ONLY.toLowerCase() === 'true') q = q.eq('approved', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

(async ()=>{
  console.log('== Peek transcripts ==');
  const totalAprob = await countApproved();
  console.log('Aprobados totales:', totalAprob);

  const nulls = await countTranscriptNull();
  console.log(`Con ${TRANSCRIPT_COLUMN}=NULL (aprobados):`, nulls);

  const sample = await fetchSomeNull(10);
  console.log('Ejemplos (primeros 10):');
  sample.forEach((r,i)=>{
    console.log(`${i+1}. id=${r.id} path=${r.file_path} bytes=${r.size_bytes ?? 'null'} dur=${r.duration_seconds ?? 'null'}`);
  });
  console.log('Fin peek.');
})().catch(e=>{
  console.error('Peek error:', e?.message || e);
  process.exit(1);
});
