import React, { useEffect, useState } from "react";
import { Navigate, Link } from "react-router-dom";
import Admin from "./Admin.jsx";
import { supabase } from "../lib/supabase.js";

export default function AdminGate(){
  const [state,setState]=useState({loading:true, session:null, allowed:false, error:null});

  useEffect(()=>{
    let alive=true;
    (async()=>{
      try{
        if(!supabase){
          if(alive) setState({loading:false, session:null, allowed:false, error:"Supabase ENV fehlt"});
          return;
        }
        const { data: s1 } = await supabase.auth.getSession();
        const session = s1?.session || null;
        if(!session){
          if(alive) setState({loading:false, session:null, allowed:false, error:null});
          return;
        }
        const { data, error } = await supabase
          .from("admin_profiles")
          .select("role")
          .eq("user_id", session.user.id)
          .maybeSingle();

        if(error) throw error;
        const allowed = !!data?.role;
        if(alive) setState({loading:false, session, allowed, error:null});
      }catch(e){
        if(alive) setState({loading:false, session:null, allowed:false, error: String(e?.message||e)});
      }
    })();
    return ()=>{alive=false};
  },[]);

  if(state.loading) return <div className="card">Lade Admin…</div>;
  if(!state.session) return <Navigate to="/admin/login" replace />;
  if(!state.allowed){
    return (
      <div className="card">
        <h2 style={{marginTop:0}}>Kein Admin-Zugriff</h2>
        <div className="muted">Dein Konto ist noch nicht freigeschaltet.</div>
        <div style={{display:"flex",gap:10,marginTop:14,flexWrap:"wrap"}}>
          <Link className="btn" to="/admin/request">Admin-Zugang anfragen</Link>
          <button className="btn" onClick={()=>supabase.auth.signOut()}>Abmelden</button>
        </div>
        {state.error && <div className="muted" style={{marginTop:10,color:"#ffb3b3"}}>{state.error}</div>}
      </div>
    );
  }
  return <Admin/>;
}
