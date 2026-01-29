import React, { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase.js";

export default function AdminRequest(){
  const [name,setName]=useState("");
  const [email,setEmail]=useState("");
  const [reason,setReason]=useState("");
  const [ok,setOk]=useState(false);
  const [err,setErr]=useState("");

  async function submit(e){
    e.preventDefault();
    setErr(""); setOk(false);
    try{
      if(!supabase) throw new Error("Supabase ENV fehlt (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)");
      const { error } = await supabase.from("admin_requests").insert({ name, email, reason });
      if(error) throw error;
      setOk(true);
    }catch(e2){
      const msg = String(e2?.message||e2||'');
      console.error(e2);
      if (msg.toLowerCase().includes('could not find the table') || msg.toLowerCase().includes('admin_requests')) {
        setErr("Anfrage-System ist noch nicht eingerichtet. Bitte Admin kontaktieren (Supabase Tabelle 'admin_requests' fehlt).");
      } else {
        setErr("Anfrage konnte nicht gesendet werden. Bitte erneut versuchen.");
      }
}
  }

  return (
    <div className="card">
      <h2 style={{marginTop:0}}>Admin-Zugang anfragen</h2>
      <div className="muted">Du bekommst nach Freigabe ein Streamer-Konto. (Die Anfrage wird gespeichert – keine automatische E-Mail.)</div>

      <form onSubmit={submit} style={{marginTop:12,display:"grid",gap:10}}>
        <label>
          <div className="muted">Name</div>
          <input className="input" value={name} onChange={e=>setName(e.target.value)} required />
        </label>
        <label>
          <div className="muted">E-Mail</div>
          <input className="input" value={email} onChange={e=>setEmail(e.target.value)} required />
        </label>
        <label>
          <div className="muted">Begründung</div>
          <textarea className="input" value={reason} onChange={e=>setReason(e.target.value)} rows={3} placeholder="z.B. Verein / Spielleiter / Kamera" />
        </label>
        <button className="btn btnPrimary" type="submit">Anfrage senden</button>
      </form>

      {ok && <div className="muted" style={{marginTop:10,color:"#b8ffcc"}}>Anfrage gesendet ✅</div>}
      {err && <div className="muted" style={{marginTop:10,color:"#ffb3b3"}}>{err}</div>}

      <div style={{display:"flex",gap:10,marginTop:14,flexWrap:"wrap"}}>
        <Link className="btn" to="/admin/login">Zum Login</Link>
        <Link className="btn" to="/">Zur Zuschauer-Seite</Link>
      </div>
    </div>
  );
}
