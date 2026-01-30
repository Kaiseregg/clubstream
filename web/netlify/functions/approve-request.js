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

function genPass(len=12){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let out='';
  for(let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
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
  const role = String(prof?.role||'').toLowerCase();
  if(role !== 'owner' && role !== 'admin') throw new Error('Not allowed (owner only)');
  return admin;
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod !== 'POST') return json(405,{error:'Method not allowed'});
    const admin = await requireOwnerOrAdmin(event);
    const body = JSON.parse(event.body||'{}');
    const id = body.id;
    if(!id) throw new Error('Missing id');

    const { data: req, error: rErr } = await admin.from('admin_requests').select('*').eq('id', id).maybeSingle();
    if(rErr) throw rErr;
    if(!req) throw new Error('Request not found');
    if(req.status !== 'pending') throw new Error('Request already processed');

    const email = String(req.email||'').trim();
    if(!email || !email.includes('@')) throw new Error('Invalid email in request');

    const tempPassword = genPass(12);

    // create or get user
    let userId = null;
    const created = await admin.auth.admin.createUser({ email, password: tempPassword, email_confirm: true });
    if(created.error){
      // if user exists, reset password
      if(String(created.error.message||'').toLowerCase().includes('already')){
        const { data: lu, error: luErr } = await admin.auth.admin.listUsers({ page:1, perPage:1000 });
        if(luErr) throw luErr;
        const existing = (lu?.users||[]).find(u => (u.email||'').toLowerCase() === email.toLowerCase());
        if(!existing) throw created.error;
        userId = existing.id;
        const { error: upErr } = await admin.auth.admin.updateUserById(userId, { password: tempPassword, email_confirm: true });
        if(upErr) throw upErr;
      }else{
        throw created.error;
      }
    }else{
      userId = created.data.user.id;
    }

    // profile as streamer (NOT owner)
    const { error: pErr } = await admin
      .from('admin_profiles')
      .upsert({ user_id: userId, role: 'streamer' }, { onConflict:'user_id' });
    if(pErr) throw pErr;

    const { error: upReqErr } = await admin
      .from('admin_requests')
      .update({ status:'approved' })
      .eq('id', id);
    if(upReqErr) throw upReqErr;

    return json(200, { email, tempPassword });
  }catch(e){
    return json(400, { error: String(e?.message||e) });
  }
};
