import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase.js";
import { Room, RoomEvent, createLocalTracks } from "livekit-client";

const API_TOKEN_FN = "/.netlify/functions/livekit-token";
const API_ROOM_FN = "/.netlify/functions/livekit-room";
const API_UPLOAD_PAUSE = "/.netlify/functions/upload-pause-image";
const API_LIST_REQ = "/.netlify/functions/list-requests";
const API_APPROVE_REQ = "/.netlify/functions/approve-request";
const API_DENY_REQ = "/.netlify/functions/deny-request";

function randCode(){
  const a = Math.random().toString(36).slice(2,6).toUpperCase();
  const b = Math.random().toString(36).slice(2,6).toUpperCase();
  return `${a}-${b}`;
}

export default function Admin(){
  const [role,setRole]=useState("streamer");
  const [status,setStatus]=useState("idle"); // idle|connecting|live|error
  const [err,setErr]=useState("");
  const [code,setCode]=useState(()=> (localStorage.getItem("clubstream_code")||randCode()).toUpperCase());
  const [codeInput,setCodeInput]=useState("");
  const [paused,setPaused]=useState(false);
  const [pauseUrl,setPauseUrl]=useState("");
  const [viewerCount,setViewerCount]=useState(0);
  const [viewerList,setViewerList]=useState([]);
  const [showLogs,setShowLogs]=useState(false);
  const [logs,setLogs]=useState([]);
  const [requests,setRequests]=useState([]);
  const [maxViewersInput,setMaxViewersInput]=useState({}); // requestId -> number

  // Scoreboard (basic overlay, like older versions)
  const [sport,setSport]=useState("Unihockey");
  const [period,setPeriod]=useState("1/3");
  const [teamA,setTeamA]=useState("Team A");
  const [teamB,setTeamB]=useState("Team B");
  const [scoreA,setScoreA]=useState(0);
  const [scoreB,setScoreB]=useState(0);
  const localVideoRef = useRef(null);

  const roomRef = useRef(null);
  const tracksRef = useRef([]); // local tracks for cleanup

  const enc = useMemo(()=>new TextEncoder(),[]);

  async function sendData(obj){
    try{
      const room = roomRef.current;
      if(!room) return;
      const bytes = enc.encode(JSON.stringify(obj));
      await room.localParticipant.publishData(bytes,{reliable:true});
    }catch{}
  }

  async function sendState(){
    await sendData({
      type:"state",
      paused,
      pauseUrl,
      scoreboard:{ sport, period, teamA, teamB, scoreA, scoreB },
    });
  }

  const watchLink = useMemo(()=> `${window.location.origin}/watch/${code}`, [code]);

  function log(msg){
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    setLogs(prev => [line, ...prev].slice(0,200));
    // keep console for debugging
    // eslint-disable-next-line no-console
    console.log(line);
  }

  async function loadRole(){
    try{
      if(!supabase) return;
      const { data } = await supabase.auth.getSession();
      const u = data?.session?.user;
      if(!u) { setRole("streamer"); return; }
      const { data: prof } = await supabase.from("admin_profiles").select("role").eq("user_id", u.id).maybeSingle();
      const r = String(prof?.role||"streamer").toLowerCase();
      setRole(["owner","admin","streamer"].includes(r)? r : "streamer");
    }catch(e){
      // ignore
    }
  }

  async function refreshRequests(){
    try{
      if(!supabase) return;
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if(!token) return;
      const res = await fetch(API_LIST_REQ, { headers: { Authorization: `Bearer ${token}` } });
      const js = await res.json();
      if(js?.ok) setRequests(js.requests||[]);
    }catch(e){
      // ignore
    }
  }

  useEffect(()=>{
    loadRole();
  },[]);

  useEffect(()=>{
    localStorage.setItem("clubstream_code", code);
  },[code]);

  // viewer count poll (only when live)
  useEffect(()=>{
    let t=null;
    async function poll(){
      try{
        if(status!=="live") return;
        if(!supabase) return;
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token;
        if(!token) return;
        const res = await fetch(`${API_ROOM_FN}?room=${encodeURIComponent(code)}`, { headers: { Authorization: `Bearer ${token}` } });
        if(!res.ok){
          // Avoid endless 400 spam if function is misconfigured
          return;
        }
        const js = await res.json();
        if(js?.counts){
          setViewerCount(js.counts.viewers||0);
          setViewerList(js.viewers||[]);
        }
      }catch(e){
        // ignore
      }
    }
    if(status==="live"){
      poll();
      t = setInterval(poll, 2500);
    }
    return ()=> { if(t) clearInterval(t); };
  },[status, code]);

  async function getToken(role){
    if(!supabase) throw new Error("Supabase not configured");
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    const res = await fetch(API_TOKEN_FN, {
      method:"POST",
      headers: {
        "Content-Type":"application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ role, room: code })
    });
    const js = await res.json();
    if(!res.ok) throw new Error(js?.error || "Token failed");
    return js; // {token,url}
  }

  async function start(){
    setErr("");
    setStatus("connecting");
    try{
      log(`START clicked (code ${code})`);
      const { token, url } = await getToken("publisher");

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        publishDefaults: {
          simulcast: true,
          videoCodec: "vp8",
        },
      });
      roomRef.current = room;

      room
        .on(RoomEvent.Connected, () => log("LIVEKIT connected"))
        .on(RoomEvent.Disconnected, () => log("LIVEKIT disconnected"))
        .on(RoomEvent.ParticipantConnected, async () => {
          log("Participant connected");
          // send current pause/overlay state to late-joining viewers
          await sendState();
        })
        .on(RoomEvent.ParticipantDisconnected, () => log("Participant disconnected"))
        .on(RoomEvent.DataReceived, (payload, participant) => {
          try{
            const msg = new TextDecoder().decode(payload);
            log(`Data from ${participant?.identity||"?"}: ${msg}`);
            try{
              const obj = JSON.parse(msg);
              if(obj?.type === "hello") sendState();
            }catch{}
          }catch{}
        });

      await room.connect(url, token);

      const tracks = await createLocalTracks({
        audio:true,
        video:{
          width:{ideal:1280},
          height:{ideal:720},
          frameRate:{ideal:30, max:30},
        }
      });
      tracksRef.current = tracks;

      // publish compat: publishTracks might not exist on some versions
      if(room.localParticipant?.publishTracks){
        await room.localParticipant.publishTracks(tracks);
      }else{
        for(const t of tracks){
          await room.localParticipant.publishTrack(t);
        }
      }
      log("Published local tracks");

      // local preview
      const v = tracks.find(t => t.kind === "video");
      if(v && localVideoRef.current){
        v.attach(localVideoRef.current);
      }

      setStatus("live");
      setPaused(false);
      setPauseUrl("");

      // initial state
      await sendState();
    }catch(e){
      setStatus("error");
      setErr(String(e?.message||e));
      log(`ERROR start: ${String(e?.message||e)}`);
    }
  }

  async function stop(){
    setErr("");
    try{
      log("STOP clicked");
      setPaused(false);
      setPauseUrl("");

      // notify viewers (best-effort)
      try{
        if(roomRef.current?.localParticipant){
          const data1 = new TextEncoder().encode(JSON.stringify({ type:"pause", on:false }));
          const data2 = new TextEncoder().encode(JSON.stringify({ type:"ended" }));
          roomRef.current.localParticipant.publishData(data1, { reliable:true });
          roomRef.current.localParticipant.publishData(data2, { reliable:true });
        }
      }catch{}

      // cleanup tracks
      try{
        const tracks = tracksRef.current || [];
        for(const t of tracks){
          try{ t.stop(); }catch{}
          try{ t.detach(); }catch{}
        }
      }catch{}
      tracksRef.current = [];

      // disconnect room
      try{
        if(roomRef.current){
          roomRef.current.disconnect();
        }
      }catch{}
      roomRef.current = null;

      // clear preview
      try{
        if(localVideoRef.current) localVideoRef.current.srcObject = null;
      }catch{}
      setStatus("idle");
    }catch(e){
      setErr(String(e?.message||e));
      setStatus("error");
    }
  }

  async function togglePause(){
    try{
      if(status!=="live" || !roomRef.current?.localParticipant) return;
      const next = !paused;
      setPaused(next);

      const payload = next
        ? { type:"pause", on:true, url: pauseUrl || "" }
        : { type:"pause", on:false };

      roomRef.current.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify(payload)),
        { reliable:true }
      );
      log(`Pause ${next ? "ON" : "OFF"} sent`);
    }catch(e){
      setErr(String(e?.message||e));
    }
  }

  async function uploadPauseImage(file){
    try{
      if(!file) return;
      if(!supabase) throw new Error("Supabase not configured");
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if(!token) throw new Error("Not logged in");
      const dataUrl = await new Promise((resolve,reject)=>{
        const r = new FileReader();
        r.onload = ()=> resolve(String(r.result||""));
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const res = await fetch(API_UPLOAD_PAUSE, {
        method:"POST",
        headers: { "Content-Type":"application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code, dataUrl })
      });
      const js = await res.json();
      if(!res.ok || !js?.ok) throw new Error(js?.error || "Upload failed");
      setPauseUrl(js.url);
      log("Pause image uploaded");
    }catch(e){
      setErr(String(e?.message||e));
    }
  }

  async function approveRequest(req){
    try{
      if(!supabase) return;
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if(!token) return;
      const maxViewers = Number(maxViewersInput[req.id]||0) || undefined;
      const res = await fetch(API_APPROVE_REQ, {
        method:"POST",
        headers: { "Content-Type":"application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: req.id, max_viewers: maxViewers })
      });
      const js = await res.json();
      if(!res.ok || !js?.ok) throw new Error(js?.error || "Approve failed");
      await refreshRequests();
      alert("Freigegeben");
    }catch(e){
      alert(String(e?.message||e));
    }
  }

  async function denyRequest(req){
    try{
      if(!supabase) return;
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if(!token) return;
      const res = await fetch(API_DENY_REQ, {
        method:"POST",
        headers: { "Content-Type":"application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: req.id })
      });
      const js = await res.json();
      if(!res.ok || !js?.ok) throw new Error(js?.error || "Deny failed");
      await refreshRequests();
      alert("Abgelehnt");
    }catch(e){
      alert(String(e?.message||e));
    }
  }

  useEffect(()=>{
    if(role==="owner" || role==="admin"){
      refreshRequests();
    }
  },[role]);

  return (
    <div className="page">
      <div className="card">
        <div className="topbar">
          <div>
            <h2>Admin (Live)</h2>
            <div className="muted">Signaling: ok • Status: <b>{status}</b> • Role: <b>{role}</b></div>
          </div>
          <div className="actions">
            <a className="btn" href="/watch/demo" onClick={(e)=>e.preventDefault()}>{viewerCount ? `Zuschauer: ${viewerCount}` : "Zuschauer"}</a>
          </div>
        </div>

        <div className="row">
          <div className="field">
            <div className="label">Code</div>
            <div className="inline">
              <div className="codebox">{code}</div>
              <button className="btn" onClick={()=>setCode(randCode())}>Neuer Code</button>
              <input
                className="input"
                style={{width:140}}
                value={codeInput}
                onChange={(e)=>setCodeInput(e.target.value.toUpperCase())}
                placeholder="Code manuell"
                disabled={status==="live"}
              />
              <button
                className="btn"
                disabled={status==="live" || !codeInput.trim()}
                onClick={()=>{ setCode(codeInput.trim().toUpperCase()); localStorage.setItem("clubstream_code", codeInput.trim().toUpperCase()); }}
              >
                Übernehmen
              </button>
              {status!=="live" ? (
                <button className="btn primary" onClick={start}>Start</button>
              ) : (
                <button className="btn danger" onClick={stop}>Stop</button>
              )}
              <button className="btn" onClick={async ()=>{ await supabase.auth.signOut(); nav("/admin"); }}>
                Logout
              </button>
              <button className="btn" onClick={()=>{
                navigator.clipboard.writeText(watchLink);
                log("Watch-Link kopiert");
              }}>Watch-Link kopieren</button>
            </div>
            <div className="muted small">Zuschauer-Link: <a href={watchLink}>{watchLink}</a></div>
          </div>
        </div>

        {/* Scoreboard overlay */}
        <div className="row">
          <div className="field">
            <div className="label">Overlay / Resultat</div>
            <div className="inline" style={{flexWrap:"wrap"}}>
              <select className="input" value={sport} onChange={(e)=>setSport(e.target.value)}>
                <option>Unihockey</option>
                <option>Fussball</option>
                <option>Eishockey</option>
                <option>Basketball</option>
              </select>
              <select className="input" value={period} onChange={(e)=>setPeriod(e.target.value)}>
                <option>1/3</option><option>2/3</option><option>3/3</option>
                <option>1/4</option><option>2/4</option><option>3/4</option><option>4/4</option>
                <option>1/2</option><option>2/2</option>
              </select>
              <input className="input" value={teamA} onChange={(e)=>setTeamA(e.target.value)} />
              <button className="btn" onClick={()=>setScoreA(s=>Math.max(0,s-1))}>-</button>
              <div className="pill">{scoreA}</div>
              <button className="btn" onClick={()=>setScoreA(s=>s+1)}>+</button>
              <input className="input" value={teamB} onChange={(e)=>setTeamB(e.target.value)} />
              <button className="btn" onClick={()=>setScoreB(s=>Math.max(0,s-1))}>-</button>
              <div className="pill">{scoreB}</div>
              <button className="btn" onClick={()=>setScoreB(s=>s+1)}>+</button>
            </div>
            <div className="muted small">Wird live an alle Zuschauer gesendet.</div>
          </div>
        </div>

        {/* Pause / Sponsor overlay */}
        <div className="row">
          <div className="field">
            <div className="label">Pause / Sponsor</div>
            <div className="inline">
              <button className="btn" disabled={status!=="live"} onClick={togglePause}>
                {paused ? "Pause aus" : "Pause an"}
              </button>
              <input
                type="file"
                accept="image/*"
                onChange={(e)=>uploadPauseImage(e.target.files?.[0])}
              />
              {pauseUrl ? <a className="btn" href={pauseUrl} target="_blank" rel="noreferrer">Bild öffnen</a> : null}
            </div>
            <div className="muted small">Tipp: Bild hochladen → dann "Pause an" (Viewer sehen das Bild als Overlay).</div>
          </div>
        </div>

        {err ? <div className="error">Fehler: {err}</div> : null}

        <div className="videoWrap">
          <video ref={localVideoRef} autoPlay playsInline muted className="video" />
          {paused && pauseUrl ? (
            <div className="pauseOverlay">
              <img src={pauseUrl} alt="Pause" />
              <div className="pauseText">PAUSE</div>
            </div>
          ) : null}
          {!paused && viewerCount ? <div className="viewerBadge">{viewerCount} Zuschauer</div> : null}
        </div>

        <div className="row">
          <button className="btn" onClick={()=>setShowLogs(v=>!v)}>{showLogs ? "Logs ausblenden" : "Logs"}</button>
        </div>
        {showLogs ? (
          <pre className="logs">{logs.join("\n")}</pre>
        ) : null}

        {(role==="owner" || role==="admin") ? (
          <div className="adminPanel">
            <h3>Streamer-Anfragen</h3>
            <div className="muted small">Hier kannst du Zugänge freigeben/ablehnen. Optional: Max Zuschauer festlegen.</div>

            <div className="reqList">
              {requests.length===0 ? <div className="muted">Keine offenen Anfragen.</div> : null}
              {requests.map(r=>(
                <div key={r.id} className="reqCard">
                  <div className="reqInfo">
                    <div><b>{r.full_name}</b> • {r.email}</div>
                    <div className="muted small">{r.club} • {r.plan} • {r.status}</div>
                  </div>
                  <div className="reqActions">
                    <input
                      className="input"
                      placeholder="Max Zuschauer"
                      value={maxViewersInput[r.id] ?? ""}
                      onChange={(e)=>setMaxViewersInput(prev=>({ ...prev, [r.id]: e.target.value }))}
                      style={{ width: 130 }}
                    />
                    <button className="btn primary" onClick={()=>approveRequest(r)}>Freigeben</button>
                    <button className="btn danger" onClick={()=>denyRequest(r)}>Ablehnen</button>
                  </div>
                </div>
              ))}
            </div>

            <h3 style={{ marginTop: 18 }}>Zuschauer (aktueller Code)</h3>
            <div className="muted small">LiveKit-Teilnehmerliste (Viewer).</div>
            {viewerList.length===0 ? <div className="muted">Noch keine Zuschauer.</div> : (
              <ul className="viewerList">
                {viewerList.map(v=>(
                  <li key={v.identity}>{v.name || v.identity}</li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

      </div>
    </div>
  );
}
