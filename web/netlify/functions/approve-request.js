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

function getRedirectTo(){
  return process.env.APP_INVITE_REDIRECT
    || process.env.URL
    || process.env.DEPLOY_PRIME_URL
    || process.env.DEPLOY_URL
    || undefined;
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
  if(role !== 'owner' && role !== 'admin') throw new Error('Not allowed (owner/admin only)');
  return admin;
}

async function sendAccessEmail({ to, name, link, kind }){
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;
  if(!host || !user || !pass || !from){
    return { ok:false, error:'SMTP not configured (SMTP_HOST/USER/PASS/FROM)' };
  }
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT||587);
  const secure = String(process.env.SMTP_SECURE||'').toLowerCase() === 'true' || port === 465;

  const tr = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const subject = kind === 'recovery'
    ? 'ClubStream – Passwort setzen'
    : 'ClubStream – Streamer-Zugang freigeschaltet';

  const hello = name ? `Hallo ${name}` : 'Hallo';
  const text =
`${hello}

Dein Streamer-Zugang für ClubStream wurde freigeschaltet.

Bitte klicke auf diesen Link, um dein Passwort zu setzen:
${link}

Wenn du diese Anfrage nicht gestellt hast, ignoriere diese E-Mail.

— ClubStream`;

  await tr.sendMail({ from, to, subject, text });
  return { ok:true };
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

    const redirectTo = getRedirectTo();
    let kind = 'invite';

    // Generate an invite link (creates the user) and send it via OUR SMTP.
    // If user already exists, fall back to recovery link (set/reset password).
    let linkData = await admin.auth.admin.generateLink({
      type: 'invite',
      email,
      options: redirectTo ? { redirectTo } : undefined,
    });

    if(linkData.error){
      const msg = String(linkData.error.message||'').toLowerCase();
      if(msg.includes('already')){
        kind = 'recovery';
        linkData = await admin.auth.admin.generateLink({
          type: 'recovery',
          email,
          options: redirectTo ? { redirectTo } : undefined,
        });
      }
    }

    if(linkData.error) throw linkData.error;

    const actionLink = linkData?.data?.properties?.action_link;
    const userId = linkData?.data?.user?.id;

    if(!actionLink) throw new Error('Could not generate invite link');
    if(!userId) throw new Error('Could not resolve user id');

    // profile as streamer (NOT owner)
    const { error: pErr } = await admin
      .from('admin_profiles')
      .upsert({ user_id: userId, role: 'streamer' }, { onConflict:'user_id' });
    if(pErr) throw pErr;

    const { error: upReqErr } = await admin
      .from('admin_requests')
      .update({ status:'approved', approved_at: new Date().toISOString() })
      .eq('id', id);
    if(upReqErr) throw upReqErr;

    // Send email (via SMTP vars in Netlify)
    let emailSent = false;
    let emailError = '';
    try{
      const r = await sendAccessEmail({ to: email, name: req.name, link: actionLink, kind });
      emailSent = !!r.ok;
      if(!r.ok) emailError = r.error || 'Email failed';
    }catch(e){
      emailError = String(e?.message||e);
    }

    return json(200, { email, emailSent, kind, emailError: emailError || null });
  }catch(e){
    return json(400, { error: String(e?.message||e) });
  }
};
