import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase.js";

export default function AdminLogin(){
  const nav = useNavigate();
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [err,setErr]=useState("");

  useEffect(()=>{
    (async()=>{
      if(!supabase) return;
      const { data } = await supabase.auth.getSession();
      if(data?.session) nav("/admin", {replace:true});
    })();
  },[]);

  async function onLogin(e){
    e.preventDefault();
    setErr("");
    try{
      if(!supabase) throw new Error("Supabase ENV fehlt (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)");
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if(error) throw error;
      nav("/admin", {replace:true});
    }catch(e2){
      setErr(String(e2?.message||e2));
    }
  }

  return (
    <div className="card">
      <h2 style={{marginTop:0}}>Admin Login</h2>
      <div className="muted">Login für Streamer/Owner (Supabase Auth).</div>

      <form onSubmit={onLogin} style={{marginTop:12,display:"grid",gap:10}}>
        <label>
          <div className="muted">E-Mail</div>
          <input className="input" value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@email..." required />
        </label>

        <label>
          <div className="muted">Passwort</div>
          <input className="input" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" required />
        </label>

        <button className="btn btnPrimary" type="submit">Login</button>
      </form>

      {err && <div className="muted" style={{marginTop:10,color:"#ffb3b3"}}>{err}</div>}

      <div style={{display:"flex",gap:10,marginTop:14,flexWrap:"wrap"}}>
        <Link className="btn" to="/admin/request">Admin-Zugang anfragen</Link>
        <Link className="btn" to="/">Zur Zuschauer-Seite</Link>
      </div>
    </div>
  );
}
