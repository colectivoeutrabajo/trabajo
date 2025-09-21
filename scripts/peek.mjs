// scripts/peek.mjs
import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = 'audios',
  SUPABASE_TABLE = 'recordings',
  APPROVED_ONLY = 'true',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const isiOSIncompat = (row) => {
  const m = (row.mime_type||'').toLowerCase();
  const p = (row.file_path||'').toLowerCase();
  return p.endsWith('.webm') || m.includes('webm') ||
         p.endsWith('.ogg')  || m.includes('ogg')  ||
         p.endsWith('.wav')  || m.includes('wav');
};

async function main(){
  console.log('== Peek candidates ==');
  // Cuenta total
  let q = sb.from(SUPABASE_TABLE).select('id', { count: 'exact', head: true });
  if (APPROVED_ONLY.toLowerCase() === 'true') q = q.eq('approved', true);
  const { count, error: cntErr } = await q;
  if (cntErr) throw cntErr;
  console.log(`Filas totales${APPROVED_ONLY==='true'?' (approved=true)':''}:`, count ?? 'desconocido');

  // Trae 50 últimas
  let q2 = sb.from(SUPABASE_TABLE)
    .select('id,file_path,mime_type,created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (APPROVED_ONLY.toLowerCase() === 'true') q2 = q2.eq('approved', true);
  const { data, error } = await q2;
  if (error) throw error;

  const cand = (data||[]).filter(isiOSIncompat);
  console.log(`Candidatos incompatibles (dentro de las últimas 50): ${cand.length}`);
  cand.slice(0, 10).forEach((r,i)=>{
    console.log(`  ${i+1}. ${r.file_path}  (${r.mime_type||'?'})`);
  });

  // Probar un HEAD/list de storage (sin descargar)
  const { data: listing, error: listErr } = await sb.storage.from(SUPABASE_BUCKET).list('', { limit: 1 });
  if (listErr) throw listErr;
  console.log(`Storage OK. Ejemplo list:`, listing?.[0]?.name || '(sin datos)');

  console.log('Peek OK');
}

main().catch(e=>{
  console.error('Peek ERROR:', e);
  process.exit(1);
});
