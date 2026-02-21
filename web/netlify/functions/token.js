const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");
const { createClient } = require("@supabase/supabase-js");

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("Missing SUPABASE_URL (or VITE_SUPABASE_URL)");
  if (!service) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
}

function livekitCfg() {
  const url = must("LIVEKIT_URL");
  const apiKey = must("LIVEKIT_API_KEY");
  const apiSecret = must("LIVEKIT_API_SECRET");
  return { url, apiKey, apiSecret };
}

function roomService() {
  const { url, apiKey, apiSecret } = livekitCfg();
  // RoomServiceClient expects HTTP(s) URL, convert from wss://
  const httpUrl = url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  return new RoomServiceClient(httpUrl, apiKey, apiSecret);
}

async function getUserFromBearer(admin, event) {
  const auth = event.headers.authorization || event.headers.Authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error) return null;
  return data?.user || null;
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
    const body = JSON.parse(event.body || "{}");
    const room = String(body.room || "").trim();
    const role = String(body.role || "viewer").toLowerCase(); // viewer | publisher
    const identity = String(body.identity || "").trim() || `guest-${Date.now()}`;
    if (!room) throw new Error("Missing room");

    const admin = supabaseAdmin();
    const user = await getUserFromBearer(admin, event);

    // Determine max viewers from:
    // 1) room metadata (if room already exists)
    // 2) publisher provided maxViewers (only if authenticated publisher)
    // 3) fallback env DEFAULT_MAX_VIEWERS or 50
    const DEFAULT_MAX = clampInt(process.env.DEFAULT_MAX_VIEWERS, 50, 1, 500);

    const rs = roomService();

    // Helper: read current room metadata (if exists)
    let meta = null;
    try {
      const rooms = await rs.listRooms([room]);
      const r = (rooms || [])[0];
      meta = r?.metadata ? JSON.parse(r.metadata) : null;
    } catch (_) {}

    const metaMax = meta?.maxViewers ? clampInt(meta.maxViewers, DEFAULT_MAX, 1, 500) : null;

    if (role === "publisher") {
      if (!user) throw new Error("Publisher requires login (Bearer token)");
      const userId = user.id;
      // role check from admin_profiles (owner/admin/streamer)
      // NOTE: Some deployments may not have the max_viewers column yet. We fall back gracefully.
      let prof = null;
      {
        const { data, error } = await admin
          .from("admin_profiles")
          .select("role,max_viewers")
          .eq("user_id", userId)
          .maybeSingle();
        if (!error) {
          prof = data;
        } else {
          const msg = String(error.message || "");
          if (msg.includes("max_viewers") && msg.includes("does not exist")) {
            const { data: data2, error: error2 } = await admin
              .from("admin_profiles")
              .select("role")
              .eq("user_id", userId)
              .maybeSingle();
            if (error2) throw error2;
            prof = data2;
          } else {
            throw error;
          }
        }
      }

      const r = String(prof?.role || "").toLowerCase();
      if (!["owner", "admin", "streamer"].includes(r)) throw new Error("Not allowed");

      const requested = clampInt(body.maxViewers, clampInt(prof?.max_viewers, DEFAULT_MAX, 1, 500), 1, 500);

      // Ensure room metadata set (owner + max viewers)
      const newMeta = { ...(meta || {}), ownerUserId: userId, ownerEmail: user.email || null, maxViewers: requested };
      try {
        await rs.updateRoomMetadata(room, JSON.stringify(newMeta));
      } catch (_) {
        // room might not exist yet; metadata can be updated after first connect by client via data,
        // but we try again later in UI if needed.
      }

      const at = new AccessToken(must("LIVEKIT_API_KEY"), must("LIVEKIT_API_SECRET"), { identity });
      at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();
      return json(200, { token, maxViewers: requested });
    }

    // Viewer
    // Enforce max viewers (secure) via LiveKit room service participant count
    const effectiveMax = metaMax || DEFAULT_MAX;
    try {
      const parts = await rs.listParticipants(room);
      const viewers = (parts || []).filter((p) => !String(p.identity || "").startsWith("admin-"));
      if (viewers.length >= effectiveMax) {
        return json(403, { error: "Room full", maxViewers: effectiveMax, current: viewers.length });
      }
    } catch (_) {
      // If room doesn't exist yet, allow viewer to join (they'll wait)
    }

    const at = new AccessToken(must("LIVEKIT_API_KEY"), must("LIVEKIT_API_SECRET"), { identity });
    at.addGrant({ room, roomJoin: true, canPublish: false, canSubscribe: true });
    const token = await at.toJwt();
    return json(200, { token, maxViewers: effectiveMax });
  } catch (e) {
    return json(400, { error: String(e?.message || e) });
  }
};
