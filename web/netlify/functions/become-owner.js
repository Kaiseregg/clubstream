const { createClient } = require('@supabase/supabase-js');

function json(status, obj){
  return { statusCode: status, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(obj) };
}

function getEnv(){
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;
  if(!url) throw new Error('Missing SUPABASE URL env (VITE_SUPABASE_URL or SUPABASE_URL)');
  if(!service) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in Netlify env');
  if(!ownerEmail) throw new Error('Missing OWNER_EMAIL in Netlify env');
  return { url, service, ownerEmail };
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod !== 'POST') return json(405,{error:'Method not allowed'});
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if(!token) throw new Error('Missing Authorization Bearer token');

    const { url, service, ownerEmail } = getEnv();
    const admin = createClient(url, service, { auth: { persistSession:false } });

    const { data: u, error: uErr } = await admin.auth.getUser(token);
    if(uErr) throw uErr;
    const user = u?.user;
    if(!user?.id) throw new Error('Invalid token');

    const email = String(user.email||'').toLowerCase();
    if(email !== String(ownerEmail).toLowerCase()){
      throw new Error('Not allowed (email mismatch)');
    }

    const { error: pErr } = await admin
      .from('admin_profiles')
      .upsert({ user_id: user.id, role: 'owner' }, { onConflict:'user_id' });
    if(pErr) throw pErr;

    return json(200, { ok:true });
  }catch(e){
    return json(400, { error: String(e?.message||e) });
  }
};
