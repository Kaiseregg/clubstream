let cached = null;
let cachedAt = 0;

export async function getIceConfig(){
  // Cache for 30s; credentials typically last 1h.
  if(cached && (Date.now() - cachedAt) < 30_000) return cached;
  try{
    const res = await fetch('/.netlify/functions/ice-servers');
    const json = await res.json();
    if(res.ok && json?.iceServers){
      cached = { iceServers: json.iceServers };
      cachedAt = Date.now();
      return cached;
    }
  }catch{}
  // Fallback
  cached = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
  cachedAt = Date.now();
  return cached;
}
