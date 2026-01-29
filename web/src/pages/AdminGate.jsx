import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Admin from "./Admin.jsx";
import { supabase } from "../lib/supabase.js";

export default function AdminGate(){
  const [state,setState]=useState({loading:true, session:null, role:null, allowed:false, error:null});
  const nav = useNavigate();

  useEffect(()=>{
    let alive=true;
    (async()=>{
      try{
        if(!supabase){
          if(alive) setState({loading:false, session:null, role:null, allowed:false, error:"Supabase ENV fehlt"});
          return;
        }
        const { data: s1 } = await supabase.auth.getSession();
        const session = s1?.session || null;
        if(!session){
          if(alive) setState({loading:false, session:null, role:null, allowed:false, error:null});
          return;
        }

        const { data, error } = await supabase
          .from("admin_profiles")
          .select("role")
          .eq("user_id", session.user.id)
          .maybeSingle();

        if(error) throw error;
        const role = data?.role || null;
        const allowed = role === "owner" || role === "streamer" || role === "admin"; // legacy: admin treated as streamer
        if(alive) setState({loading:false, session, role, allowed, error:null});
      }catch(e){
        if(alive) setState({loading:false, session:null, role:null, allowed:false, error:String(e?.message||e)});
      }
    })();
    return ()=>{ alive=false; };
  },[]);

  if(state.loading) return <div className="card">Lade...</div>;

  if(!state.session){
    return (
      <div className="card">
        <h2 style={{marginTop:0}}>Admin</h2>
        <div className="muted">Bitte einloggen.</div>
        <div style={{display:"flex",gap:10,marginTop:14,flexWrap:"wrap"}}>
          <Link className="btn btnPrimary" to="/admin/login">Zum Login</Link>
          <Link className="btn" to="/">Zur Zuschauer-Seite</Link>
        </div>
      </div>
    );
  }

  if(!state.allowed){
    return (
      <div className="card">
        <h2 style={{marginTop:0}}>Kein Zugriff</h2>
        <div className="muted">Dein Account ist noch nicht als Streamer/Owner freigeschaltet.</div>
        <div style={{display:"flex",gap:10,marginTop:14,flexWrap:"wrap"}}>
          <Link className="btn" to="/admin/request">Zugang anfragen</Link>
          <button className="btn" onClick={async()=>{ await supabase.auth.signOut(); nav('/admin/login',{replace:true}); }}>Abmelden</button>
        </div>
        {state.error && <div className="muted" style={{marginTop:10,color:"#ffb3b3"}}>{state.error}</div>}
      </div>
    );
  }

  return <Admin role={state.role || "streamer"} />;
}
