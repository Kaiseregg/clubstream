const { createClient } = require('@supabase/supabase-js');

function json(status, obj){
  return { statusCode: status, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(obj) };
}

function getEnv(){
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url) throw new Error('Missing SUPABASE URL env (VITE_SUPABASE_URL or SUPABASE_URL)');
  if(!service) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in Netlify env');
  return { url, service };
}

async function requireRole(event){
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if(!token) throw new Error('Missing Authorization Bearer token');
  const { url, service } = getEnv();
  const admin = createClient(url, service, { auth: { persistSession:false } });
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if(uErr) throw uErr;
  const userId = u?.user?.id;
  if(!userId) throw new Error('Invalid token');

  // role lookup is optional; if missing row, treat as streamer (still allowed)
  const { data: prof } = await admin.from('admin_profiles').select('role').eq('user_id', userId).maybeSingle();
  const role = String(prof?.role || 'streamer').toLowerCase();
  if(!['owner','admin','streamer'].includes(role)) throw new Error('Not allowed');
  return admin;
}

function parseDataUrl(dataUrl){
  if(typeof dataUrl !== 'string') throw new Error('Missing dataUrl');
  const m = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if(!m) throw new Error('Invalid dataUrl');
  const contentType = m[1];
  const b64 = m[2];
  const buf = Buffer.from(b64, 'base64');
  let ext = 'png';
  if(contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
  else if(contentType.includes('webp')) ext = 'webp';
  else if(contentType.includes('png')) ext = 'png';
  return { buf, contentType, ext };
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod !== 'POST') return json(405,{error:'Method not allowed'});
    const admin = await requireRole(event);
    const body = JSON.parse(event.body||'{}');
    const code = String(body.code||'').trim().toUpperCase();
    if(!code) throw new Error('Missing code');

    const { buf, contentType, ext } = parseDataUrl(body.dataUrl);

    const bucket = 'pause-images';
    const path = `${code}/${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;

    const { error: upErr } = await admin.storage.from(bucket).upload(path, buf, {
      contentType,
      upsert: true,
      cacheControl: '3600'
    });
    if(upErr) throw upErr;

    const { data } = admin.storage.from(bucket).getPublicUrl(path);
    return json(200, { ok:true, url: data?.publicUrl, path, bucket });
  }catch(e){
    return json(400, { ok:false, error: String(e?.message||e) });
  }
};
