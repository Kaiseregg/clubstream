// Returns short-lived Cloudflare TURN credentials as WebRTC iceServers JSON.
// Keep CF credentials server-side.

function json(status, obj){
  return { statusCode: status, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(obj) };
}

const cache = { ts: 0, body: null };

exports.handler = async () => {
  try{
    const keyId = process.env.CF_TURN_KEY_ID;
    const token = process.env.CF_TURN_API_TOKEN;
    const ttl = Number(process.env.CF_TURN_TTL_SECONDS || 3600);

    if(!keyId || !token){
      // Fallback to optional static JSON, if provided.
      const raw = process.env.VITE_ICE_SERVERS_JSON || process.env.ICE_SERVERS_JSON;
      if(raw){
        try{ return json(200, { iceServers: JSON.parse(raw) }); }catch{}
      }
      return json(200, { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
    }

    // Tiny cache to avoid hitting API too often.
    if(cache.body && (Date.now() - cache.ts) < 30_000){
      return json(200, cache.body);
    }

    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ttl })
    });
    const bodyText = await res.text();
    let data = null;
    try{ data = bodyText ? JSON.parse(bodyText) : null; }catch{}
    if(!res.ok){
      return json(400, { error: `Cloudflare TURN error (${res.status})`, details: data || bodyText });
    }

    // Optional: filter out known-problematic port 53 URLs for browsers.
    try{
      if(data?.iceServers?.length){
        for(const s of data.iceServers){
          if(Array.isArray(s.urls)){
            s.urls = s.urls.filter(u => !String(u).includes(':53'));
          }
        }
      }
    }catch{}

    cache.ts = Date.now();
    cache.body = data;
    return json(200, data);
  }catch(e){
    return json(400, { error: String(e?.message||e) });
  }
};
