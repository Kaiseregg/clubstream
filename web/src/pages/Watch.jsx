import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getIceConfig } from "../lib/ice";
import { connectSignaling } from "../lib/signaling";

// Viewer: robust signaling + trickle ICE + stable overlay + fullscreen/theater

const isIOS = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iP(hone|ad|od)/.test(ua) || (ua.includes("Mac") && "ontouchend" in document);
};

export default function Watch() {
  const { code } = useParams();

  const wrapRef = useRef(null); // whole card
  const videoWrapRef = useRef(null); // video box (for fullscreen)
  const videoRef = useRef(null);

  const sigRef = useRef(null);
  const pcRef = useRef(null);
  const remoteRef = useRef(new MediaStream());

  const joinTimerRef = useRef(null);
  const lastJoinRef = useRef(0);

  const [muted, setMuted] = useState(true);
  const [theater, setTheater] = useState(false);
  const [fs, setFs] = useState(false);

  const [started, setStarted] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const [note, setNote] = useState("Tippe auf Start, um zu verbinden.");
  const [sigOk, setSigOk] = useState(false);

  const [match, setMatch] = useState(null);
  const hud = useMemo(() => {
    if (!match) return null;
    const period = match.period ?? match.phase ?? "";
    const time = match.time ?? match.clock ?? "";
    const score = `${match.home_score ?? match.homeScore ?? 0} : ${match.away_score ?? match.awayScore ?? 0}`;
    return {
      sport: match.sport || "Unihockey",
      home: match.home || match.teamA || "Team A",
      away: match.away || match.teamB || "Team B",
      period,
      time,
      score,
    };
  }, [match]);

  function cleanupPeer() {
    try {
      pcRef.current?.close?.();
    } catch {}
    pcRef.current = null;
    remoteRef.current = new MediaStream();
    if (videoRef.current) videoRef.current.srcObject = null;
    setHasVideo(false);
  }

  async function ensureAutoplay() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    try {
      await v.play();
    } catch {
      // ignore – user gesture will unlock
    }
  }

  function sendJoin(reason = "manual") {
    const now = Date.now();
    if (now - lastJoinRef.current < 800) return;
    lastJoinRef.current = now;
    sigRef.current?.send?.({ type: "viewer-join", code, reason });
  }

  async function start() {
    setStarted(true);
    setNote("Verbinde…");
    await ensureAutoplay();
    sendJoin("start");

    clearTimeout(joinTimerRef.current);
    joinTimerRef.current = setTimeout(() => {
      if (!hasVideo) setNote("Keine Verbindung – tippe erneut.");
    }, 6000);
  }

  async function handleOffer(msg) {
    cleanupPeer();
    setNote("Verbinde…");

    const pc = new RTCPeerConnection(await getIceConfig(true));
    pcRef.current = pc;

    pc.ontrack = (ev) => {
      ev.streams[0]?.getTracks()?.forEach((t) => remoteRef.current.addTrack(t));
      if (videoRef.current) {
        videoRef.current.srcObject = remoteRef.current;
        ensureAutoplay();
        setHasVideo(true);
        setNote("");
      }
    };

    // Trickle ICE (required for many mobile/4G/5G networks)
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        sigRef.current?.send?.({ type: "webrtc-ice", code, candidate: ev.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === "checking") setNote("Verbinde…");
      if (st === "connected" || st === "completed") setNote("");
      if (st === "failed" || st === "disconnected") {
        setNote("Verbindung unterbrochen – neu verbinden…");
        cleanupPeer();
        // ask host for a fresh offer
        setTimeout(() => sendJoin("ice-retry"), 500);
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed") {
        setNote("Verbindung fehlgeschlagen (Netz). Neu verbinden…");
        cleanupPeer();
        setTimeout(() => sendJoin("pc-failed"), 500);
      }
    };

    await pc.setRemoteDescription(msg.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sigRef.current?.send?.({ type: "webrtc-answer", code, sdp: pc.localDescription });
  }

  function handleIce(msg) {
    const pc = pcRef.current;
    if (!pc || !msg?.candidate) return;
    try {
      pc.addIceCandidate(msg.candidate);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    // (re)connect signaling
    sigRef.current?.close?.();
    sigRef.current = connectSignaling(
      async (msg) => {
        if (!msg?.type) return;
        if (msg.type === "webrtc-offer") return handleOffer(msg);
        if (msg.type === "webrtc-ice") return handleIce(msg);
        if (msg.type === "match") return setMatch(msg);
      },
      (status) => {
        setSigOk(!!status?.ok);
        if (status?.ok) {
          // auto re-join after reconnect
          if (started) sendJoin("sig-reconnect");
        }
      }
    );

    return () => {
      clearTimeout(joinTimerRef.current);
      cleanupPeer();
      sigRef.current?.close?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  useEffect(() => {
    const onFs = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  async function toggleFullscreen() {
    if (isIOS()) {
      setTheater((v) => !v);
      setTimeout(ensureAutoplay, 0);
      return;
    }
    const el = videoWrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen({ navigationUI: "hide" });
      setTimeout(ensureAutoplay, 0);
    } catch {
      // fallback
      setTheater((v) => !v);
      setTimeout(ensureAutoplay, 0);
    }
  }

  function closeTheater() {
    setTheater(false);
    setTimeout(ensureAutoplay, 0);
  }

  return (
    <div className={theater ? "theater" : ""} ref={wrapRef}>
      <div className="card">
        <div className="topbar">
          <div className="title">Live</div>
          <div className="meta">
            Signaling: {sigOk ? "ok" : "…"} • <Link to="/">← Zurück</Link>
          </div>
          <div className="codeBadge">Code: {code}</div>
        </div>

        <div className="video" ref={videoWrapRef}>
          <video
            ref={videoRef}
            playsInline
            autoPlay
            muted={muted}
            controls={false}
          />

          {/* HUD overlay (inside video) */}
          {hud && (
            <div className="hud">
              <div className="hudLeft">
                <div className="hudSport">{hud.sport}</div>
                <div className="hudTeams">
                  {hud.home} <span className="hudVs">vs</span> {hud.away}
                </div>
              </div>
              <div className="hudCenter">
                <span className="hudPeriod">{hud.period}</span>
                {hud.time ? <span className="hudTime">{hud.time}</span> : null}
                <span className="hudScore">{hud.score}</span>
              </div>
            </div>
          )}

          {/* Play overlay */}
          {!hasVideo && (
            <button className="playOverlay" onClick={start}>
              <div className="playTop">▶ Start</div>
              <div className="playSub">{note || "Tippe um zu starten."}</div>
            </button>
          )}

          <button className="fsBtn" onClick={toggleFullscreen} title="Fullscreen">
            ⤢
          </button>
          {theater && (
            <button className="xBtn" onClick={closeTheater} title="Schliessen">
              ✕
            </button>
          )}
        </div>

        <div className="bottombar">
          <div className="hint">Keine Wiederholung • nur live</div>
          <button
            className="muteBtn"
            onClick={() => {
              setMuted((m) => !m);
              setTimeout(ensureAutoplay, 0);
            }}
          >
            {muted ? "Ton an" : "Ton aus"}
          </button>
        </div>
      </div>
    </div>
  );
}
