const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
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

async function getUserFromBearer(event, admin){
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if(!token) return { token:null, user:null };
  const { data, error } = await admin.auth.getUser(token);
  if(error) throw error;
  return { token, user: data?.user || null };
}

async function getRole(admin, userId){
  if(!userId) return null;
  const { data } = await admin.from('admin_profiles').select('role').eq('user_id', userId).maybeSingle();
  return String(data?.role || '').toLowerCase() || null;
}

function parseBody(event){
  try{ return JSON.parse(event.body||'{}'); }catch(e){ return {}; }
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod !== 'POST') return json(405,{error:'Method not allowed'});
    const body = parseBody(event);
    const room = String(body.room||body.code||'').trim().toUpperCase();
    const requestedRole = String(body.role||'subscriber').toLowerCase(); // publisher|subscriber
    if(!room) throw new Error('Missing room');
    if(!['publisher','subscriber'].includes(requestedRole)) throw new Error('Invalid role');

    const LK_URL = must('LIVEKIT_URL'); // e.g. wss://xxx.livekit.cloud
    const LK_KEY = must('LIVEKIT_API_KEY');
    const LK_SECRET = must('LIVEKIT_API_SECRET');

    const admin = getSupabaseAdmin();
    const { user } = await getUserFromBearer(event, admin);
    const userId = user?.id || null;

    // Authorization:
    // - subscriber: allow anonymous
    // - publisher: require signed-in and role in admin_profiles
    if(requestedRole === 'publisher'){
      if(!userId) throw new Error('Publisher requires login');
      const role = await getRole(admin, userId);
      if(!['owner','admin','streamer'].includes(role)) throw new Error('Not allowed');
      // Optional subscription gating via app_metadata
      const meta = user?.app_metadata || {};
      const exp = meta.expires_at ? Date.parse(meta.expires_at) : null;
      if(exp && Date.now() > exp) throw new Error('Access expired');
    }

    // Max viewers enforcement (best-effort): if publisher has max_viewers in app_metadata,
    // reject new subscriber tokens when the room is full.
    if(requestedRole === 'subscriber'){
      // find publisher max if provided via request body (ownerId) - not available.
      // We instead allow a global MAX_VIEWERS (env) and per-room max via optional body.maxViewers for future.
      const maxEnv = process.env.MAX_VIEWERS ? Number(process.env.MAX_VIEWERS) : null;
      const max = (Number(body.maxViewers)||0) > 0 ? Number(body.maxViewers) : maxEnv;
      if(max && Number.isFinite(max) && max > 0){
        const rs = new RoomServiceClient(LK_URL, LK_KEY, LK_SECRET);
        try{
          const list = await rs.listParticipants(room);
          const count = Array.isArray(list) ? list.length : (list?.participants?.length || 0);
          if(count >= max + 1) { // +1 for publisher (approx)
            return json(403,{error:`Room full (max ${max})`});
          }
        }catch(e){
          // if list fails, don't block viewers
        }
      }
    }

    // identity
    const identity = requestedRole === 'publisher'
      ? `pub_${userId}`
      : `view_${Math.random().toString(36).slice(2,10)}`;

    const at = new AccessToken(LK_KEY, LK_SECRET, {
      identity,
      name: requestedRole === 'publisher' ? (user?.email || 'Streamer') : 'Zuschauer',
      ttl: 60 * 60 * 6,
    });

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: requestedRole === 'publisher',
      canSubscribe: true,
      canPublishData: requestedRole === 'publisher',
    });

    const token = await at.toJwt();
    return json(200, { token, url: LK_URL, room, identity, role: requestedRole });
  }catch(e){
    return json(400, { error: String(e?.message||e) });
  }
};
