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

async function requireOwnerOrAdmin(event){
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if(!token) throw new Error('Missing Authorization Bearer token');
  const { url, service } = getEnv();
  const admin = createClient(url, service, { auth: { persistSession:false } });
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if(uErr) throw uErr;
  const userId = u?.user?.id;
  if(!userId) throw new Error('Invalid token');
  const { data: prof, error: pErr } = await admin
    .from('admin_profiles')
    .select('role')
    .eq('user_id', userId)
    .maybeSingle();
  if(pErr) throw pErr;
  const role = String(prof?.role || '').toLowerCase();
  if(role !== 'owner' && role !== 'admin') throw new Error('Not allowed (owner/admin only)');
  return admin;
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod !== 'POST') return json(405,{error:'Method not allowed'});
    const admin = await requireOwnerOrAdmin(event);
    const body = JSON.parse(event.body||'{}');
    const id = body.id;
    if(!id) throw new Error('Missing id');

    const { error } = await admin.from('admin_requests').update({ status:'denied' }).eq('id', id);
    if(error) throw error;
    return json(200, { ok:true });
  }catch(e){
    return json(400, { error: String(e?.message||e) });
  }
};
