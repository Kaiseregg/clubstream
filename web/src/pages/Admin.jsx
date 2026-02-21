import React, { useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent, Track, createLocalTracks } from "livekit-client";
import { supabase } from "../lib/supabaseClient";
import "../styles.css";

function mkCode() {
  const a = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  const b = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  return `${a}-${b}`;
}

async function postJSON(url, body, bearer) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export default function Admin() {
  // Auth / role
  const [user, setUser] = useState(null);
  const [role, setRole] = useState("");
  const [tab, setTab] = useState("stream"); // stream | requests

  // Stream state
  const [code, setCode] = useState(mkCode);
  const [codeInput, setCodeInput] = useState("");
  const [status, setStatus] = useState("idle"); // idle | connecting | live | error
  const [err, setErr] = useState("");
  const [logs, setLogs] = useState([]);
  const [sport, setSport] = useState("Unihockey");
  const [periodMode, setPeriodMode] = useState("3"); // 2,3,4
  const [period, setPeriod] = useState(1);
  const [teamA, setTeamA] = useState("Team A");
  const [teamB, setTeamB] = useState("Team B");
  const [scoreA, setScoreA] = useState(0);
  const [scoreB, setScoreB] = useState(0);

  const [paused, setPaused] = useState(false);
  const [pauseImageUrl, setPauseImageUrl] = useState("");
  const [maxViewers, setMaxViewers] = useState(40);

  const [viewerCount, setViewerCount] = useState(0);
  const [viewerList, setViewerList] = useState([]);

  const wrapRef = useRef(null);
  const localVideoRef = useRef(null);
  const roomRef = useRef(null);
  const localVideoTrackRef = useRef(null);
  const facingRef = useRef("user"); // user | environment

  const identity = useMemo(() => `admin-${Date.now()}-${Math.random().toString(16).slice(2)}`, []);

  const log = (m) => setLogs((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 200));

  // Auth bootstrap
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data?.user || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setUser(session?.user || null));
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  // Fetch role/profile
  useEffect(() => {
    (async () => {
      if (!user?.id) return;
      const { data, error } = await supabase.from("admin_profiles").select("role,max_viewers").eq("user_id", user.id).maybeSingle();
      if (!error) {
        setRole(String(data?.role || ""));
        if (data?.max_viewers) setMaxViewers(data.max_viewers);
      }
    })();
  }, [user?.id]);

  function currentOverlay() {
    return {
      type: "overlay",
      sport,
      periodMode: Number(periodMode),
      period: Number(period),
      teamA,
      teamB,
      scoreA: Number(scoreA),
      scoreB: Number(scoreB),
      paused,
      pauseImageUrl,
      code,
      ts: Date.now(),
    };
  }

  async function sendOverlay(toParticipantIdentity) {
    const room = roomRef.current;
    if (!room) return;
    const payload = new TextEncoder().encode(JSON.stringify(currentOverlay()));
    await room.localParticipant.publishData(payload, { reliable: true, destinationIdentities: toParticipantIdentity ? [toParticipantIdentity] : undefined });
  }

  function refreshViewerState(room) {
    const viewers = [];
    room.remoteParticipants.forEach((p) => {
      if (!String(p.identity || "").startsWith("admin-")) viewers.push({ identity: p.identity, name: p.name || "" });
    });
    setViewerCount(viewers.length);
    setViewerList(viewers);
  }

  async function start() {
    try {
      setErr("");
      setStatus("connecting");

      const sess = await supabase.auth.getSession();
      const bearer = sess?.data?.session?.access_token || null;
      if (!bearer) throw new Error("Bitte einloggen (AdminLogin).");

      log(`Start: room=${code} maxViewers=${maxViewers}`);

      const tok = await postJSON("/.netlify/functions/token", { room: code, identity, role: "publisher", maxViewers }, bearer);

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      room.on(RoomEvent.Connected, () => log("LIVEKIT connected"));
      room.on(RoomEvent.Disconnected, () => log("LIVEKIT disconnected"));

      room.on(RoomEvent.ParticipantConnected, () => refreshViewerState(room));
      room.on(RoomEvent.ParticipantDisconnected, () => refreshViewerState(room));

      room.on(RoomEvent.DataReceived, async (payload, participant) => {
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          if (msg?.type === "hello") {
            // send current overlay to the joining viewer
            await sendOverlay(participant?.identity);
          }
        } catch {}
      });

      await room.connect(import.meta.env.VITE_LIVEKIT_URL, tok.token);

      // Create local tracks (better quality default)
      const tracks = await createLocalTracks({
        audio: true,
        video: {
          facingMode: facingRef.current,
          width: 1280,
          height: 720,
          frameRate: 30,
        },
      });

      // publish each track (compat)
      for (const t of tracks) {
        await room.localParticipant.publishTrack(t);
        if (t.kind === "video") localVideoTrackRef.current = t;
      }

      // Local preview
      const v = tracks.find((t) => t.kind === "video");
      if (v && localVideoRef.current) {
        v.attach(localVideoRef.current);
        localVideoRef.current.muted = true;
      }

      refreshViewerState(room);
      setStatus("live");
      await sendOverlay(); // broadcast initial overlay
    } catch (e) {
      console.error(e);
      setErr(e?.message || String(e));
      setStatus("error");
      log(`ERROR: ${e?.message || String(e)}`);
    }
  }

  async function stop() {
    try {
      const room = roomRef.current;
      if (room) {
        // stop/unpublish
        const pubs = room.localParticipant?.trackPublications;
        if (pubs && typeof pubs.values === "function") {
          for (const pub of pubs.values()) {
            if (pub?.track) {
              try { room.localParticipant.unpublishTrack(pub.track); } catch {}
              try { pub.track.stop(); } catch {}
              try { pub.track.detach?.(); } catch {}
            }
          }
        }
        try { await room.disconnect(); } catch {}
      }
      roomRef.current = null;
      localVideoTrackRef.current = null;
      if (localVideoRef.current) {
        try { localVideoRef.current.srcObject = null; } catch {}
      }
      setViewerCount(0);
      setViewerList([]);
      setStatus("idle");
      setErr("");
      log("Stopped");
    } catch (e) {
      console.error(e);
      setErr(e?.message || String(e));
      setStatus("error");
      log(`ERROR stop: ${e?.message || String(e)}`);
    }
  }

  async function togglePause() {
    const next = !paused;
    setPaused(next);
    // broadcast overlay after state update (next tick)
    setTimeout(() => sendOverlay(), 0);
  }

  async function uploadPauseImage(file) {
    const sess = await supabase.auth.getSession();
    const bearer = sess?.data?.session?.access_token || null;
    if (!bearer) throw new Error("Not logged in");
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || "").split(",")[1] || "");
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    const out = await postJSON("/.netlify/functions/upload-pause-image", { room: code, base64, filename: file.name }, bearer);
    if (out?.publicUrl) {
      setPauseImageUrl(out.publicUrl);
      setTimeout(() => sendOverlay(), 0);
    }
  }

  async function switchCamera() {
    try {
      if (status !== "live") {
        facingRef.current = facingRef.current === "user" ? "environment" : "user";
        log(`Kamera gewählt: ${facingRef.current}`);
        return;
      }
      const room = roomRef.current;
      if (!room) return;

      facingRef.current = facingRef.current === "user" ? "environment" : "user";
      log(`Switch camera -> ${facingRef.current}`);

      const tracks = await createLocalTracks({
        audio: false,
        video: { facingMode: facingRef.current, width: 1280, height: 720, frameRate: 30 },
      });
      const newVideo = tracks.find((t) => t.kind === "video");
      if (!newVideo) return;

      // replace published video
      const pubs = room.localParticipant?.trackPublications;
      let oldPub = null;
      if (pubs && typeof pubs.values === "function") {
        for (const pub of pubs.values()) {
          if (pub?.track?.kind === "video") oldPub = pub;
        }
      }
      if (oldPub?.track) {
        try { room.localParticipant.unpublishTrack(oldPub.track); } catch {}
        try { oldPub.track.stop(); } catch {}
      }

      await room.localParticipant.publishTrack(newVideo);
      localVideoTrackRef.current = newVideo;

      if (localVideoRef.current) {
        newVideo.attach(localVideoRef.current);
      }
    } catch (e) {
      console.error(e);
      setErr(e?.message || String(e));
      log(`ERROR camera: ${e?.message || String(e)}`);
    }
  }

  async function goFullscreen() {
    const el = wrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (el.requestFullscreen) await el.requestFullscreen();
    } catch {}
  }

  async function logout() {
    await supabase.auth.signOut();
    location.href = "/";
  }

  // Requests (Owner/Admin)
  const [reqs, setReqs] = useState([]);
  const [reqErr, setReqErr] = useState("");
  const [approveMax, setApproveMax] = useState(40);

  async function loadRequests() {
    try {
      setReqErr("");
      const sess = await supabase.auth.getSession();
      const bearer = sess?.data?.session?.access_token || null;
      if (!bearer) throw new Error("Not logged in");
      const out = await fetch("/.netlify/functions/list-requests", { headers: { Authorization: `Bearer ${bearer}` } });
      const data = await out.json();
      if (!out.ok) throw new Error(data?.error || "Failed");
      setReqs(data?.requests || []);
    } catch (e) {
      setReqErr(e?.message || String(e));
    }
  }

  async function approveRequest(id) {
    const sess = await supabase.auth.getSession();
    const bearer = sess?.data?.session?.access_token || null;
    if (!bearer) throw new Error("Not logged in");
    await postJSON("/.netlify/functions/approve-request", { id, max_viewers: approveMax }, bearer);
    await loadRequests();
  }

  async function denyRequest(id) {
    const sess = await supabase.auth.getSession();
    const bearer = sess?.data?.session?.access_token || null;
    if (!bearer) throw new Error("Not logged in");
    await postJSON("/.netlify/functions/deny-request", { id }, bearer);
    await loadRequests();
  }

  useEffect(() => {
    if (tab === "requests") loadRequests();
  }, [tab]);

  return (
    <div className="appShell">
      <header className="topBar">
        <div className="brand">ClubStream</div>
        <div className="topBarRight">
          <div className="pill">{role || "streamer"}</div>
          <button className="btn ghost" onClick={logout}>Logout</button>
        </div>
      </header>

      <nav className="tabs">
        <button className={`tab ${tab==="stream"?"active":""}`} onClick={()=>setTab("stream")}>Stream</button>
        {(role === "owner" || role === "admin") && (
          <button className={`tab ${tab==="requests"?"active":""}`} onClick={()=>setTab("requests")}>Anfragen</button>
        )}
      </nav>

      {tab === "requests" ? (
        <main className="panel">
          <h2>Anfragen</h2>
          {reqErr ? <div className="alert">{reqErr}</div> : null}

          <div className="row">
            <label>Max. Zuschauer (bei Zustimmung)</label>
            <input className="input" type="number" min="1" max="500" value={approveMax} onChange={(e)=>setApproveMax(Number(e.target.value||0))}/>
          </div>

          <div className="cards">
            {reqs.map((r)=>(
              <div className="card" key={r.id}>
                <div className="cardTitle">{r.name} • {r.email}</div>
                <div className="muted">Plan: {r.plan || "-"} • Status: {r.status}</div>
                <div className="cardActions">
                  {r.status === "pending" ? (
                    <>
                      <button className="btn" onClick={()=>approveRequest(r.id)}>Zustimmen</button>
                      <button className="btn danger" onClick={()=>denyRequest(r.id)}>Ablehnen</button>
                    </>
                  ) : (
                    <div className="muted">Erledigt</div>
                  )}
                </div>
              </div>
            ))}
            {reqs.length === 0 ? <div className="muted">Keine Anfragen.</div> : null}
          </div>
        </main>
      ) : (
        <main className="panel">
          <div className="grid2">
            <section className="card">
              <div className="cardTitleRow">
                <h2>Live</h2>
                <div className="viewerBadge">{viewerCount} Zuschauer</div>
              </div>

              <div className="row">
                <label>Matchcode</label>
                <div className="rowInline">
                  <input className="input" value={codeInput} placeholder={code} onChange={(e)=>setCodeInput(e.target.value)} />
                  <button className="btn ghost" onClick={() => { if(codeInput.trim()) setCode(codeInput.trim().toUpperCase()); }}>Übernehmen</button>
                  <button className="btn ghost" onClick={() => setCode(mkCode())} disabled={status !== "idle"}>Neu</button>
                </div>
              </div>

              <div className="row">
                <label>Max. Zuschauer (Room)</label>
                <input className="input" type="number" min="1" max="500" value={maxViewers} onChange={(e)=>setMaxViewers(Number(e.target.value||0))} />
              </div>

              <div className="rowInline">
                <button className="btn" onClick={start} disabled={status==="connecting"||status==="live"}>Start</button>
                <button className="btn danger" onClick={stop} disabled={status!=="live"}>Stop</button>
                <button className="btn ghost" onClick={switchCamera}>Kamera wechseln</button>
                <button className="btn ghost" onClick={goFullscreen}>Fullscreen</button>
              </div>

              <div className="muted small">
                Watch-Link:{" "}
                <a href={`/watch/${code}`}>{`${location.origin}/watch/${code}`}</a>{" "}
                <button className="linkBtn" onClick={() => navigator.clipboard.writeText(`${location.origin}/watch/${code}`)}>kopieren</button>
              </div>

              {err ? <div className="alert">{err}</div> : null}

              <div ref={wrapRef} className="videoWrap">
                <video ref={localVideoRef} className="videoEl" autoPlay playsInline muted />
                <div className="overlayTop">
                  <div className="overlayLeft">
                    <div className="overlaySport">{sport}</div>
                    <div className="overlayPeriod">{period}/{periodMode}</div>
                  </div>
                  <div className="overlayCenter">
                    <div className="overlayTeams">
                      <span className="team">{teamA}</span>
                      <span className="score">{scoreA}:{scoreB}</span>
                      <span className="team">{teamB}</span>
                    </div>
                  </div>
                </div>

                {paused && pauseImageUrl ? (
                  <div className="pauseLayer">
                    <img src={pauseImageUrl} alt="Pause" />
                  </div>
                ) : null}
              </div>

              <details className="details">
                <summary>Viewer Liste</summary>
                <div className="muted small">{viewerList.map(v=>v.identity).join(", ") || "—"}</div>
              </details>

              <details className="details">
                <summary>Logs</summary>
                <pre className="logBox">{logs.join("\n")}</pre>
              </details>
            </section>

            <section className="card">
              <h2>Scoreboard</h2>
              <div className="row">
                <label>Sport</label>
                <select className="input" value={sport} onChange={(e)=>{setSport(e.target.value); setTimeout(()=>sendOverlay(),0);}}>
                  <option>Unihockey</option>
                  <option>Fussball</option>
                  <option>Eishockey</option>
                  <option>Handball</option>
                </select>
              </div>

              <div className="row">
                <label>Modus</label>
                <select className="input" value={periodMode} onChange={(e)=>{setPeriodMode(e.target.value); setPeriod(1); setTimeout(()=>sendOverlay(),0);}}>
                  <option value="2">2/2</option>
                  <option value="3">3/3</option>
                  <option value="4">4/4</option>
                </select>
              </div>

              <div className="row">
                <label>Periode</label>
                <div className="rowInline">
                  <button className="btn ghost" onClick={()=>{setPeriod((p)=>Math.max(1,p-1)); setTimeout(()=>sendOverlay(),0);}}>-</button>
                  <div className="pill">{period}/{periodMode}</div>
                  <button className="btn ghost" onClick={()=>{setPeriod((p)=>Math.min(Number(periodMode),p+1)); setTimeout(()=>sendOverlay(),0);}}>+</button>
                </div>
              </div>

              <div className="row">
                <label>Teams</label>
                <div className="rowInline">
                  <input className="input" value={teamA} onChange={(e)=>setTeamA(e.target.value)} onBlur={()=>sendOverlay()} />
                  <input className="input" value={teamB} onChange={(e)=>setTeamB(e.target.value)} onBlur={()=>sendOverlay()} />
                </div>
              </div>

              <div className="row">
                <label>Resultat</label>
                <div className="scoreGrid">
                  <div>
                    <div className="muted small">{teamA}</div>
                    <div className="rowInline">
                      <button className="btn ghost" onClick={()=>{setScoreA((s)=>Math.max(0,s-1)); setTimeout(()=>sendOverlay(),0);}}>-</button>
                      <div className="pill big">{scoreA}</div>
                      <button className="btn ghost" onClick={()=>{setScoreA((s)=>s+1); setTimeout(()=>sendOverlay(),0);}}>+</button>
                    </div>
                  </div>
                  <div>
                    <div className="muted small">{teamB}</div>
                    <div className="rowInline">
                      <button className="btn ghost" onClick={()=>{setScoreB((s)=>Math.max(0,s-1)); setTimeout(()=>sendOverlay(),0);}}>-</button>
                      <div className="pill big">{scoreB}</div>
                      <button className="btn ghost" onClick={()=>{setScoreB((s)=>s+1); setTimeout(()=>sendOverlay(),0);}}>+</button>
                    </div>
                  </div>
                </div>
              </div>

              <hr className="sep" />

              <div className="rowInline">
                <button className={`btn ${paused ? "danger" : ""}`} onClick={togglePause}>
                  {paused ? "Pause AUS" : "Pause EIN"}
                </button>
                <label className="btn ghost fileBtn">
                  Sponsorbild hochladen
                  <input type="file" accept="image/*" onChange={(e)=>{ if(e.target.files?.[0]) uploadPauseImage(e.target.files[0]).catch((er)=>setErr(er.message)); }} />
                </label>
              </div>

              <div className="muted small">Tipp: Zuschauer sehen Pause/Scoreboard auch im Fullscreen (Wrapper).</div>
            </section>
          </div>
        </main>
      )}
    </div>
  );
}
