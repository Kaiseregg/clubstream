# Stream Live – Deploy Guide

## Architektur
- **Web (Vite/React)**: Netlify
- **Signaling (Node + ws)**: Render (Web Service)

## 1) Signaling auf Render
1. Repo/ZIP auf GitHub pushen (Render braucht Git)
2. Render → New → Web Service → Repo auswählen
3. RootDir: `signaling`
4. Build: `npm ci`
5. Start: `node src/index.js`
6. Port: Render setzt `PORT` automatisch

Nach Deploy: du bekommst z.B. `https://stream-live-signaling.onrender.com`
→ WebSocket URL wird: `wss://stream-live-signaling.onrender.com`

## 2) Web auf Netlify
Netlify → New site from Git
- Base directory: `web`
- Build command: `npm run build`
- Publish: `web/dist`

Env Vars in Netlify:
- `VITE_SIGNALING_URL` = `wss://DEIN-RENDER-SERVICE.onrender.com`
- `VITE_STREAMER_KEY` = `demo` (oder eigener Key)

## 3) Admin-Login (Supabase)
1. Supabase Projekt erstellen
2. SQL Editor: `SUPABASE_SETUP.sql` ausführen
3. Auth → Users: Admin User erstellen (E-Mail+Passwort) oder Invite
4. admin_profiles setzen (für den User):
   - in SQL Editor:
     ```sql
     insert into public.admin_profiles (user_id, role)
     values ('<USER_UUID>', 'admin');
     ```

Web Env Vars (Netlify **und** lokal `.env`):
- `VITE_SUPABASE_URL` = `https://xxxx.supabase.co`
- `VITE_SUPABASE_ANON_KEY` = `…`

## 4) Admin Requests
Im Web: `/admin/request` schreibt in `admin_requests`.
Freigabe machst du in Supabase (Table) + User anlegen + admin_profiles insert.
