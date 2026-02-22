import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Room, RoomEvent, Track } from "livekit-client";
import "../styles.css";

function isIOS() {
  const ua = navigator.userAgent || "";
  return /iphone|ipad|ipod/i.test(ua);
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export default function Watch() {
  const { code } = useParams();
  const [status, setStatus] = useState("idle"); // idle | connecting | playing | error
  const [err, setErr] = useState("");
  const [muted, setMuted] = useState(true);
  const [viewerCount, setViewerCount] = useState(0);

  const [overlay, setOverlay] = useState({
    sport: "",
    periodMode: 3,
    period: 1,
    teamA: "Team A",
    teamB: "Team B",
    scoreA: 0,
    scoreB: 0,
    paused: false,
    pauseImageUrl: "",
  });

  const wrapRef = useRef(null);
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const roomRef = useRef(null);

  // iOS Safari often doesn't support the Fullscreen API on arbitrary elements.
  // We use a CSS "fullscreen" fallback so overlays (score/pause) keep working.
  const [fakeFs, setFakeFs] = useState(false);

  const identity = useMemo(() => `viewer-${Date.now()}-${Math.random().toString(16).slice(2)}`, []);

  function updateViewerCount(room) {
    const viewers = [];
    room.remoteParticipants.forEach((p) => {
      if (!String(p.identity || "").startsWith("admin-")) viewers.push(p.identity);
    });
    setViewerCount(viewers.length + 1); // + me
  }

  async function play() {
    try {
      setErr("");
      setStatus("connecting");

      const tok = await postJSON("/.netlify/functions/token", { room: code, identity, role: "viewer" });

      const room = new Room({ adaptiveStream: true });
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Video && videoRef.current) {
          track.attach(videoRef.current);
          videoRef.current.playsInline = true;
          videoRef.current.setAttribute("playsinline", "true");
          videoRef.current.setAttribute("webkit-playsinline", "true");
          setStatus("playing");
        }
        if (track.kind === Track.Kind.Audio && audioRef.current) {
          track.attach(audioRef.current);
        }
      });

      room.on(RoomEvent.ParticipantConnected, () => updateViewerCount(room));
      room.on(RoomEvent.ParticipantDisconnected, () => updateViewerCount(room));

      room.on(RoomEvent.DataReceived, (payload) => {
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          if (msg?.type === "overlay") {
            setOverlay((o) => ({ ...o, ...msg }));
          }
        } catch {}
      });

      await room.connect(import.meta.env.VITE_LIVEKIT_URL, tok.token);
      updateViewerCount(room);

      // ask for overlay state
      const hello = new TextEncoder().encode(JSON.stringify({ type: "hello", ts: Date.now() }));
      await room.localParticipant.publishData(hello, { reliable: true });

      // default muted due to autoplay restrictions; user can enable
      if (audioRef.current) audioRef.current.muted = true;
      setMuted(true);
    } catch (e) {
      console.error(e);
      setErr(e?.message || String(e));
      setStatus("error");
    }
  }

  async function stop() {
    try {
      if (roomRef.current) await roomRef.current.disconnect();
      roomRef.current = null;
      setStatus("idle");
      setViewerCount(0);
      if (videoRef.current) {
        try { videoRef.current.srcObject = null; } catch {}
      }
      if (audioRef.current) {
        try { audioRef.current.srcObject = null; } catch {}
      }
    } catch {}
  }

  async function toggleMute() {
    const next = !muted;
    setMuted(next);
    if (audioRef.current) audioRef.current.muted = next;
    // iOS: user gesture unlock
    if (!next) {
      try { await audioRef.current.play(); } catch {}
    }
  }

  async function fullscreen() {
    const el = wrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (el.requestFullscreen) await el.requestFullscreen();
    } catch {}

    // Fallback: if fullscreen wasn't entered, toggle CSS fullscreen
    if (!document.fullscreenElement) {
      setFakeFs((v) => !v);
    }
  }

  useEffect(() => {
    document.body.style.overflow = fakeFs ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [fakeFs]);

  useEffect(() => () => roomRef.current?.disconnect(), []);

  return (
    <div className="appShell">
      <header className="topBar">
        <Link className="brand" to="/">ClubStream</Link>
        <div className="topBarRight">
          <div className="viewerBadge">{viewerCount} Zuschauer</div>
        </div>
      </header>

      <main className="panel">
        <div className="watchHeader">
          <div className="muted">Matchcode</div>
          <div className="pill big">{code}</div>
        </div>

        {err ? <div className="alert">{err}</div> : null}

        <div className="rowInline">
          {status === "idle" ? (
            <button className="btn" onClick={play}>Play</button>
          ) : (
            <button className="btn danger" onClick={stop}>Stop</button>
          )}
          <button className="btn ghost" onClick={toggleMute}>{muted ? "Ton an" : "Ton aus"}</button>
          <button className="btn ghost" onClick={fullscreen}>Fullscreen</button>
        </div>

        <div ref={wrapRef} className={"videoWrap large" + (fakeFs ? " fakeFs" : "")}> 
          <video ref={videoRef} className="videoEl" autoPlay playsInline />
          <audio ref={audioRef} autoPlay />

          <div className="overlayTop">
            <div className="overlayLeft">
              <div className="overlaySport">{overlay.sport || ""}</div>
              <div className="overlayPeriod">{overlay.period}/{overlay.periodMode}</div>
            </div>
            <div className="overlayCenter">
              <div className="overlayTeams">
                <span className="team">{overlay.teamA}</span>
                <span className="score">{overlay.scoreA}:{overlay.scoreB}</span>
                <span className="team">{overlay.teamB}</span>
              </div>
            </div>
          </div>

          {overlay.paused && overlay.pauseImageUrl ? (
            <div className="pauseLayer">
              <img src={overlay.pauseImageUrl} alt="Pause" />
            </div>
          ) : null}
        </div>

        <div className="muted small" style={{ marginTop: 10 }}>
          iOS Hinweis: Fullscreen ist App-Fullscreen (Overlay bleibt sichtbar).
        </div>
      </main>
    </div>
  );
}
