import React, { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase.js";

export default function SetPassword(){
  const nav = useNavigate();
  const [params] = useSearchParams();
  const type = (params.get("type") || "recovery").toLowerCase(); // recovery | invite
  const token_hash = params.get("token_hash") || "";
  const next = params.get("next") || "/admin";

  const [pw1,setPw1]=useState("");
  const [pw2,setPw2]=useState("");
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState("");
  const [err,setErr]=useState("");

  const okParams = useMemo(()=> Boolean(token_hash) && (type==="recovery" || type==="invite"), [token_hash,type]);

  async function onSubmit(e){
    e.preventDefault();
    setErr(""); setMsg("");
    try{
      if(!supabase) throw new Error("Supabase ENV fehlt (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)");
      if(!okParams) throw new Error("Link ist unvollständig. Bitte neuen Link anfordern.");
      if(pw1.length < 8) throw new Error("Passwort zu kurz (min. 8 Zeichen).");
      if(pw1 !== pw2) throw new Error("Passwörter stimmen nicht überein.");
      setBusy(true);

      // IMPORTANT: verifyOtp only runs when the user submits the form.
      // This prevents mail scanners from 'consuming' the token.
      const { data: vData, error: vErr } = await supabase.auth.verifyOtp({ type, token_hash });
      if(vErr) throw vErr;

      const { error: uErr } = await supabase.auth.updateUser({ password: pw1 });
      if(uErr) throw uErr;

      setMsg("Passwort gesetzt. Du wirst weitergeleitet…");
      nav(next, { replace:true });
    }catch(e2){
      const m = String(e2?.message||e2);
      if(m.toLowerCase().includes("otp") && m.toLowerCase().includes("expired")){
        setErr("Dieser Link ist abgelaufen oder wurde bereits benutzt. Bitte Admin um einen neuen Link bitten (Freischalten erneut klicken).");
      }else{
        setErr(m);
      }
    }finally{
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{marginTop:0}}>Passwort setzen</h2>
      <div className="muted">
        {type==="invite" ? "Dein Account wurde eingeladen. Setze jetzt dein Passwort." : "Setze ein neues Passwort für deinen Streamer-Zugang."}
      </div>

      {!okParams && (
        <div className="muted" style={{marginTop:10,color:"#ffb3b3"}}>
          Ungültiger Link. Bitte Admin um einen neuen Link.
        </div>
      )}

      <form onSubmit={onSubmit} style={{marginTop:12,display:"grid",gap:10}}>
        <label>
          <div className="muted">Neues Passwort</div>
          <input className="input" type="password" value={pw1} onChange={e=>setPw1(e.target.value)} placeholder="min. 8 Zeichen" required />
        </label>

        <label>
          <div className="muted">Passwort bestätigen</div>
          <input className="input" type="password" value={pw2} onChange={e=>setPw2(e.target.value)} placeholder="wiederholen" required />
        </label>

        <button className="btn btnPrimary" type="submit" disabled={busy || !okParams}>
          {busy ? "Bitte warten..." : "Passwort setzen"}
        </button>
      </form>

      {msg && <div className="muted" style={{marginTop:10,color:"#b6ffd1"}}>{msg}</div>}
      {err && <div className="muted" style={{marginTop:10,color:"#ffb3b3"}}>{err}</div>}

      <div style={{display:"flex",gap:10,marginTop:14,flexWrap:"wrap"}}>
        <Link className="btn" to="/admin/login">Zum Login</Link>
        <Link className="btn" to="/">Zur Zuschauer-Seite</Link>
      </div>
    </div>
  );
}
