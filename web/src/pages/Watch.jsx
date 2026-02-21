import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase.js";
import { Room, RoomEvent, Track } from "livekit-client";
import { useParams, useNavigate } from "react-router-dom";

const API_TOKEN_FN = "/.netlify/functions/livekit-token";

export default function Watch(){
  const { code: rawCode } = useParams();
  const code = String(rawCode||"").toUpperCase();
  const navigate = useNavigate();

  const [status,setStatus]=useState("idle"); // idle|connecting|live|error
  const [err,setErr]=useState("");
  const [muted,setMuted]=useState(true);
  const [paused,setPaused]=useState(false);
  const [pauseUrl,setPauseUrl]=useState("");
  const [viewerCount,setViewerCount]=useState(null);
  const [scoreboard,setScoreboard]=useState(null);

  const roomRef = useRef(null);
  const videoRef = useRef(null);

  const watchTitle = useMemo(()=>`Live`,[]);

  async function getToken(){
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    const res = await fetch(API_TOKEN_FN, {
      method:"POST",
      headers: {
        "Content-Type":"application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ role:"subscriber", room: code })
    });
    const js = await res.json();
    if(!res.ok) throw new Error(js?.error || "Token failed");
    return js;
  }

  async function connect(){
    setErr("");
    setStatus("connecting");
    try{
      const { token, url } = await getToken();
      const room = new Room({ adaptiveStream:true, dynacast:true });
      roomRef.current = room;

      room
        .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
          if(track.kind === Track.Kind.Video){
            if(videoRef.current){
              track.attach(videoRef.current);
            }
          }
          if(track.kind === Track.Kind.Audio){
            // audio will be played automatically when unmuted; attach to a hidden audio element if needed
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => {
          try{ track.detach(); }catch{}
        })
        .on(RoomEvent.DataReceived, (payload) => {
          try{
            const msg = new TextDecoder().decode(payload);
            const obj = JSON.parse(msg);
            if(obj?.type === "pause"){
              setPaused(!!obj.on);
              setPauseUrl(obj.url || "");
            }
            if(obj?.type === "state"){
              setPaused(!!obj.paused);
              setPauseUrl(obj.pauseUrl || "");
              setScoreboard(obj.scoreboard || null);
            }
            if(obj?.type === "scoreboard"){
              setScoreboard(obj.data || null);
            }
            if(obj?.type === "viewers"){
              setViewerCount(Number(obj.count||0));
            }
            if(obj?.type === "ended"){
              disconnect();
            }
          }catch{}
        })
        .on(RoomEvent.Disconnected, () => {
          setStatus("idle");
        });

      await room.connect(url, token);

      // Ask admin for current state (pause + scoreboard) so late joiners still see it.
      try{
        const enc = new TextEncoder();
        room.localParticipant.publishData(enc.encode(JSON.stringify({type:"hello"})), {reliable:true});
      }catch{}

      setStatus("live");
    }catch(e){
      setStatus("error");
      setErr(String(e?.message||e));
    }
  }

  async function disconnect(){
    try{
      if(roomRef.current){
        roomRef.current.disconnect();
      }
    }catch{}
    roomRef.current = null;
    setStatus("idle");
  }

  useEffect(()=>{
    return ()=> { disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  return (
    <div className={"watchPage"}>
      <div className="sidebar">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="brandTitle">Stream Live</div>
            <div className="brandSub">Live Sport • ohne Replay</div>
          </div>
        </div>

        <div className="section">
          <div className="big">Live</div>
          <div className="muted">Signaling: ok</div>
          <div className="muted">Code: {code}</div>
          {viewerCount!=null ? <div className="muted">Zuschauer: {viewerCount}</div> : null}
        </div>

        <div className="section">
          <button className="btn" onClick={()=>navigate(-1)}>Zurück</button>
        </div>

        <div className="section">
          {status!=="live" ? (
            <button className="btn primary" onClick={connect}>Play</button>
          ) : (
            <button className="btn danger" onClick={disconnect}>Stop</button>
          )}
          <button className="btn" onClick={()=>setMuted(v=>!v)}>{muted ? "Ton an" : "Ton aus"}</button>
          <button className="btn" onClick={()=>{
            const el = videoRef.current;
            if(el?.requestFullscreen) el.requestFullscreen();
          }}>Fullscreen</button>
        </div>

        {err ? <div className="error">Fehler: {err}</div> : null}

        <div className="tip">
          Tipp: Wenn kein Bild kommt → Admin muss im gleichen Code live sein.
        </div>
      </div>

      <div className="main">
        <div className="videoWrap">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={muted}
            className="video"
          />
          {scoreboard ? (
            <div className="scoreOverlay">
              <div className="scoreLine">
                <span className="scoreMeta">{scoreboard.sport || ""} {scoreboard.period ? `• ${scoreboard.period}` : ""}</span>
              </div>
              <div className="scoreLine">
                <span className="team">{scoreboard.teamA || ""}</span>
                <span className="score">{Number(scoreboard.scoreA||0)} : {Number(scoreboard.scoreB||0)}</span>
                <span className="team">{scoreboard.teamB || ""}</span>
              </div>
            </div>
          ) : null}
          {paused ? (
            <div className="pauseOverlay">
              {pauseUrl ? <img src={pauseUrl} alt="Pause" /> : null}
              <div className="pauseText">PAUSE</div>
            </div>
          ) : null}
          <div className="cornerBadge">{watchTitle}{viewerCount!=null ? ` • ${viewerCount} Zuschauer` : ""}</div>
        </div>
      </div>
    </div>
  );
}
