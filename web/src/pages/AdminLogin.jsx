import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase.js";

export default function AdminLogin(){
  const nav = useNavigate();
  const [mode,setMode]=useState("password"); // password | magic
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [msg,setMsg]=useState("");
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
    setErr(""); setMsg("");
    try{
      if(!supabase) throw new Error("Supabase ENV fehlt (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)");
      if(mode==="magic"){
        const { error } = await supabase.auth.signInWithOtp({ email, options:{ emailRedirectTo: window.location.origin + "/admin" }});
        if(error) throw error;
        setMsg("Check dein E-Mail für den Login-Link.");
        return;
      }
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
      <div className="muted">Mehrere Admin-Accounts via Supabase Auth.</div>

      <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
        <button className={"btn "+(mode==="password"?"btnPrimary":"")} onClick={()=>setMode("password")}>E-Mail + Passwort</button>
        <button className={"btn "+(mode==="magic"?"btnPrimary":"")} onClick={()=>setMode("magic")}>Magic Link</button>
      </div>

      <form onSubmit={onLogin} style={{marginTop:12,display:"grid",gap:10}}>
        <label>
          <div className="muted">E-Mail</div>
          <input className="input" value={email} onChange={e=>setEmail(e.target.value)} placeholder="admin@..." required />
        </label>

        {mode==="password" && (
          <label>
            <div className="muted">Passwort</div>
            <input className="input" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" required />
          </label>
        )}

        <button className="btn btnPrimary" type="submit">Login</button>
      </form>

      {msg && <div className="muted" style={{marginTop:10,color:"#b8ffcc"}}>{msg}</div>}
      {err && <div className="muted" style={{marginTop:10,color:"#ffb3b3"}}>{err}</div>}

      <div style={{display:"flex",gap:10,marginTop:14,flexWrap:"wrap"}}>
        <Link className="btn" to="/admin/request">Admin-Zugang anfragen</Link>
        <Link className="btn" to="/">Zur Zuschauer-Seite</Link>
      </div>
    </div>
  );
}
