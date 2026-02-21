const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");

function json(status, obj){
  return { statusCode: status, headers: { "Content-Type":"application/json" }, body: JSON.stringify(obj) };
}

function must(name){
  const v = process.env[name];
  if(!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getSupabase(){
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url) throw new Error("Missing SUPABASE_URL (or VITE_SUPABASE_URL)");
  if(!service) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, service, { auth: { persistSession:false, autoRefreshToken:false } });
}

async function requireOwnerOrAdmin(event, admin){
  const auth = event.headers.authorization || event.headers.Authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if(!token) throw new Error("Missing Authorization Bearer token");

  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if(uErr) throw uErr;

  const userId = u?.user?.id;
  if(!userId) throw new Error("Invalid token");

  const { data: prof, error: pErr } = await admin
    .from("admin_profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if(pErr) throw pErr;

    // Store subscription + limits in Auth user app_metadata (no DB migration needed)
    const plan = String(request?.plan || '').toLowerCase();
    const months = plan.includes('12') ? 12 : (plan.includes('6') ? 6 : 6);
    const expires = new Date();
    expires.setMonth(expires.getMonth() + months);
    const mv = Number(max_viewers || 0) || undefined;
    const meta = { plan: request?.plan || null, expires_at: expires.toISOString() };
    if(mv) meta.max_viewers = mv;
    const { error: umErr } = await admin.auth.admin.updateUserById(userId, { app_metadata: meta });
    if(umErr) throw umErr;

  const role = String(prof?.role||"").toLowerCase();
  if(role !== "owner" && role !== "admin") throw new Error("Not allowed (owner/admin only)");
}

function getAppBase(){
  // Netlify exposes process.env.URL for the main site URL
  const url = process.env.URL || process.env.APP_BASE_URL || "";
  if(!url) throw new Error("Missing APP_BASE_URL (or Netlify URL env)");
  return url.replace(/\/$/, "");
}

function smtpTransport(){
  const host = must("SMTP_HOST");
  const port = parseInt(must("SMTP_PORT"), 10);
  const user = must("SMTP_USER");
  const pass = must("SMTP_PASS");
  const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

  return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
}

async function findUserIdByEmail(admin, email){
  // listUsers is paginated; for small projects one page is ok
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if(error) throw error;
  const u = (data?.users || []).find(x => (x.email||"").toLowerCase() === email.toLowerCase());
  return u?.id || null;
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod !== "POST") return json(405, { error:"Method not allowed" });

    const admin = getSupabase();
    await requireOwnerOrAdmin(event, admin);

    const body = JSON.parse(event.body || "{}");
    const id = body.id;
    if(!id) throw new Error("Missing id");

    const { data: req, error: rErr } = await admin
      .from("admin_requests")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if(rErr) throw rErr;
    if(!req) throw new Error("Request not found");
    if(req.status !== "pending") throw new Error("Request already processed");

    const email = String(req.email||"").trim();
    const name = String(req.name||"").trim() || "Hallo";
    if(!email || !email.includes("@")) throw new Error("Invalid email in request");

    // Determine if user exists; use invite for new users, recovery for existing.
    let userId = await findUserIdByEmail(admin, email);
    let linkType = userId ? "recovery" : "invite";

    // Ensure user exists (invite creates user)
    if(!userId){
      const invited = await admin.auth.admin.inviteUserByEmail(email);
      if(invited.error) throw invited.error;
      userId = invited.data.user.id;
    }

    // Generate a link but DO NOT send Supabase action_link directly.
    // We'll send an app-link containing token_hash, and verification happens only
    // when the user submits the password form (prevents mail scanners consuming the token).
    const appBase = getAppBase();
    const next = "/admin";
    const { data: gl, error: glErr } = await admin.auth.admin.generateLink({
      type: linkType,
      email,
    });
    if(glErr) throw glErr;

    const tokenHash = gl?.properties?.hashed_token || "";
    const appLink = tokenHash
      ? `${appBase}/set-password?type=${encodeURIComponent(linkType)}&token_hash=${encodeURIComponent(tokenHash)}&next=${encodeURIComponent(next)}`
      : (gl?.properties?.action_link || gl?.action_link);

    // Role: streamer
    const { error: pErr } = await admin
      .from("admin_profiles")
      .upsert({ user_id: userId, role: "streamer" }, { onConflict:"user_id" });
    if(pErr) throw pErr;

    // Store subscription + limits in Auth user app_metadata (no DB migration needed)
    const plan = String(request?.plan || '').toLowerCase();
    const months = plan.includes('12') ? 12 : (plan.includes('6') ? 6 : 6);
    const expires = new Date();
    expires.setMonth(expires.getMonth() + months);
    const mv = Number(max_viewers || 0) || undefined;
    const meta = { plan: request?.plan || null, expires_at: expires.toISOString() };
    if(mv) meta.max_viewers = mv;
    const { error: umErr } = await admin.auth.admin.updateUserById(userId, { app_metadata: meta });
    if(umErr) throw umErr;


    // Mark request approved
    const { error: upErr } = await admin
      .from("admin_requests")
      .update({ status:"approved", approved_at: new Date().toISOString() })
      .eq("id", id);
    if(upErr) throw upErr;

    // Send mail via SMTP
    const transporter = smtpTransport();
    const from = must("SMTP_FROM");

    const subject = "ClubStream: Streamer-Zugang freigeschaltet";
    const text =
`${name}

Dein Streamer-Zugang für ClubStream wurde freigeschaltet.

Bitte öffne diesen Link, um dein Passwort zu setzen:
${appLink}

Wenn du diese Anfrage nicht gestellt hast, ignoriere diese E-Mail.

– ClubStream
`;

    const info = await transporter.sendMail({ from, to: email, subject, text });

    return json(200, {
      ok: true,
      email,
      linkType,
      emailSent: true,
      messageId: info.messageId || null,
    });
  }catch(e){
    return json(400, { error: String(e?.message || e) });
  }
};
