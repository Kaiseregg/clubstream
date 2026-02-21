const { RoomServiceClient } = require('livekit-server-sdk');
const { createClient } = require('@supabase/supabase-js');

function json(status, obj){
  return { statusCode: status, headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' }, body: JSON.stringify(obj) };
}
function must(name){
  const v = process.env[name];
  if(!v) throw new Error(`Missing env ${name}`);
  return v;
}
function getSupabaseAdmin(){
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url) throw new Error('Missing SUPABASE_URL (or VITE_SUPABASE_URL)');
  if(!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession:false } });
}
async function requireLogin(event, admin){
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if(!token) throw new Error('Missing Authorization Bearer token');
  const { data, error } = await admin.auth.getUser(token);
  if(error) throw error;
  const user = data?.user;
  if(!user?.id) throw new Error('Invalid token');
  const { data: prof } = await admin.from('admin_profiles').select('role').eq('user_id', user.id).maybeSingle();
  const role = String(prof?.role||'').toLowerCase();
  if(!['owner','admin','streamer'].includes(role)) throw new Error('Not allowed');
  return user;
}

exports.handler = async (event) => {
  try{
    const room = String((event.queryStringParameters||{}).room||'').trim().toUpperCase();
    if(!room) throw new Error('Missing room');

    const LK_URL = must('LIVEKIT_URL');
    const LK_KEY = must('LIVEKIT_API_KEY');
    const LK_SECRET = must('LIVEKIT_API_SECRET');

    const admin = getSupabaseAdmin();
    await requireLogin(event, admin);

    const rs = new RoomServiceClient(LK_URL, LK_KEY, LK_SECRET);
    const list = await rs.listParticipants(room);
    const participants = Array.isArray(list) ? list : (list?.participants || []);
    const viewers = participants
      .filter(p => String(p?.identity||'').startsWith('view_'))
      .map(p => ({ identity: p.identity, name: p.name, joinedAt: p.joinedAt }));
    const publishers = participants
      .filter(p => String(p?.identity||'').startsWith('pub_'))
      .map(p => ({ identity: p.identity, name: p.name, joinedAt: p.joinedAt }));
    return json(200, {
      room,
      counts: { total: participants.length, viewers: viewers.length, publishers: publishers.length },
      viewers,
      publishers,
    });
  }catch(e){
    return json(400, { error: String(e?.message||e) });
  }
};
