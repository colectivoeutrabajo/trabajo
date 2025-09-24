// ESM: funciona con "type": "module" en tu package.json
import { createClient } from '@supabase/supabase-js';

function json(res, code, data) {
  res.status(code).setHeader('content-type','application/json').end(JSON.stringify(data));
}
function bad(res, msg){ json(res, 400, { error: msg }); }
function auth(req){ return req.headers['x-admin-key'] && req.headers['x-admin-key'] === process.env.ADMIN_KEY; }
function humanBytes(n){
  if (n == null) return '—';
  const units = ['B','KB','MB','GB','TB']; let i=0, v=Number(n);
  while(v>=1024 && i<units.length-1){ v/=1024; i++; }
  return `${v.toFixed(v<10?2:1)} ${units[i]}`;
}

async function listAllFiles(storage, bucket, prefix){
  const LIMIT = 1000;
  let offset = 0, all = [];
  for(;;){
    const { data, error } = await storage.from(bucket).list(prefix, {
      limit: LIMIT, offset, sortBy: { column: 'name', order: 'asc' }
    });
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const it of data) {
      // filtra "carpetas"
      const isDir = it?.metadata?.isDirectory === true || it?.id == null && !it?.name?.includes('.');
      if (!isDir) {
        all.push({
          name: it.name,
          id: it.id,
          size: it.metadata?.size ?? it.size ?? 0,
          updated_at: it.updated_at || null
        });
      }
    }
    if (data.length < LIMIT) break;
    offset += LIMIT;
  }
  return all;
}

export default async function handler(req, res){
  // CORS simple
  if (req.method === 'OPTIONS'){
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type,x-admin-key');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    return res.status(204).end();
  }
  res.setHeader('access-control-allow-origin', '*');

  if (!auth(req)) return bad(res, 'UNAUTHORIZED');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!SUPABASE_URL || !SERVICE_KEY) return bad(res, 'Missing service credentials');

  const quotaBytes = Number(process.env.STORAGE_QUOTA_BYTES || 0) || (1 * 1024 * 1024 * 1024); // 1GB por default
  const supa = createClient(SUPABASE_URL, SERVICE_KEY);

  if (req.method === 'GET'){
    const op = String(req.query?.op || '');
    if (op === 'usage'){
      try{
        const bucket = 'audios';
        const prefix = 'recordings';
        const files = await listAllFiles(supa.storage, bucket, prefix);
        const used = files.reduce((a,f)=> a + (Number(f.size)||0), 0);
        return json(res, 200, {
          bucket, prefix, usedBytes: used, quotaBytes,
          human: { used: humanBytes(used), quota: humanBytes(quotaBytes) },
          count: files.length
        });
      }catch(e){
        return json(res, 500, { error: e.message || String(e) });
      }
    }
    return bad(res, 'Unsupported GET op');
  }

  if (req.method !== 'POST') return bad(res, 'Method not allowed');

  let body = {};
  try { body = req.body || {}; } catch {}
  const action = body.action;
  if (!action) return bad(res, 'Missing action');

  if (action === 'signed_urls'){
    const file_paths = Array.isArray(body.file_paths) ? body.file_paths : [];
    const expiresInSec = Math.max(60, Math.min(Number(body.expiresInSec || 600), 3600));
    if (file_paths.length === 0) return bad(res, 'No file_paths');

    try{
      const { data, error } = await supa.storage.from('audios').createSignedUrls(file_paths, expiresInSec);
      if (error) throw error;
      return json(res, 200, { links: data, expiresInSec });
    }catch(e){
      return json(res, 500, { error: e.message || String(e) });
    }
  }

  if (action === 'disapprove_only'){
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length === 0) return bad(res, 'No ids');
    try{
      const { error } = await supa.from('recordings').update({ approved: false }).in('id', ids);
      if (error) throw error;
      return json(res, 200, { updated: ids.length });
    }catch(e){
      return json(res, 500, { error: e.message || String(e) });
    }
  }

  if (action === 'delete_storage_and_disapprove'){
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const file_paths = Array.isArray(body.file_paths) ? body.file_paths : [];
    if (ids.length === 0 || file_paths.length === 0) return bad(res, 'Need ids & file_paths');

    try{
      // bytes estimados (para reporte)
      const { data: rows, error: qErr } = await supa
        .from('recordings')
        .select('id, size_bytes')
        .in('id', ids);
      if (qErr) throw qErr;
      const bytes = (rows||[]).reduce((a,r)=> a + (Number(r.size_bytes)||0), 0);

      // borrar del storage
      const { data: delRes, error: delErr } = await supa.storage.from('audios').remove(file_paths);
      if (delErr) throw delErr;

      // marcar approved=false
      const { error: updErr } = await supa.from('recordings').update({ approved: false }).in('id', ids);
      if (updErr) throw updErr;

      return json(res, 200, {
        deleted: delRes?.length || 0,
        updated: ids.length,
        freedBytesEstimate: bytes,
        human: { freed: humanBytes(bytes) }
      });
    }catch(e){
      return json(res, 500, { error: e.message || String(e) });
    }
  }

  return bad(res, 'Unknown action');
}
