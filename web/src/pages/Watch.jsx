import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getIceConfig } from "../lib/ice";
import { connectSignaling } from "../lib/signaling";

function isMobileUA() {
  const ua = navigator.userAgent || "";
  return /iphone|ipad|ipod|android/i.test(ua);
}

function setViewportVhVar() {
  // iOS Safari: use --vh to avoid address-bar jump
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty("--vh", `${vh}px`);
}

function normDesc(desc, forcedType) {
  if (!desc) return null;
  if (typeof desc === "string") return { type: forcedType, sdp: desc };
  if (typeof desc === "object" && desc.sdp) return desc;
  return null;
}

function normCandidate(c) {
  if (!c) return null;
  if (typeof c.toJSON === "function") return c.toJSON();
  if (typeof c === "object" && c.candidate) return c;
  return null;
}

export default function Watch() {
  const { code } = useParams();

  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const sigRef = useRef(null);
  const joinTimerRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());

  const startedRef = useRef(false);
  const hasVideoRef = useRef(false);

  const [note, setNote] = useState("Tippe auf Play, um zu starten.");
  const [theater, setTheater] = useState(false);
  const [muted, setMuted] = useState(true);
  const [sigOk, setSigOk] = useState(false);

  const forceRelay = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("relay") === "1") return true;
    // Mobile default: relay is usually more stable behind carrier NATs
    return isMobileUA();
  }, []);

  async function ensurePc() {
    if (pcRef.current) return pcRef.current;

    const ice = await getIceConfig({ forceRelay });

    const pc = new RTCPeerConnection({
      iceServers: ice?.iceServers || [],
      iceTransportPolicy: ice?.iceTransportPolicy || "all",
    });

    pc.ontrack = (ev) => {
      const stream = remoteStreamRef.current;
      ev.streams?.[0]?.getTracks?.().forEach((t) => stream.addTrack(t));
      if (videoRef.current) videoRef.current.srcObject = stream;
      hasVideoRef.current = true;
      setNote("");
    };

    pc.onicecandidate = (ev) => {
      const cand = normCandidate(ev.candidate);
      if (cand) {
        sigRef.current?.send?.({ type: "webrtc-ice", code, candidate: cand });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === "checking") setNote("Verbinde…");
      if (st === "failed" || st === "disconnected") {
        cleanupPc();
        startJoinLoop("Verbindung unterbrochen – neu verbinden…");
      }
    };

    pcRef.current = pc;
    return pc;
  }

  function cleanupPc() {
    try { joinTimerRef.current && clearInterval(joinTimerRef.current); } catch {}
    joinTimerRef.current = null;

    try { pcRef.current?.close?.(); } catch {}
    pcRef.current = null;

    hasVideoRef.current = false;
    remoteStreamRef.current = new MediaStream();
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  function sendViewerJoin() {
    sigRef.current?.send?.({ type: "viewer-join", code });
  }

  function startJoinLoop(msg) {
    setNote(msg || "Verbinde…");
    sendViewerJoin();
    try { joinTimerRef.current && clearInterval(joinTimerRef.current); } catch {}
    joinTimerRef.current = setInterval(() => {
      if (!hasVideoRef.current) sendViewerJoin();
    }, 2500);
  }

  async function acceptOffer(rawOffer) {
    const offer = normDesc(rawOffer, "offer");
    if (!offer?.sdp) return;

    const pc = await ensurePc();

    // Accept both {type:'offer',sdp:'...'} and raw sdp string.
    await pc.setRemoteDescription(offer);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Send full localDescription (includes type + sdp) so Admin can setRemoteDescription directly.
    sigRef.current?.send?.({ type: "webrtc-answer", code, sdp: pc.localDescription });
  }

  // Signaling connect
  useEffect(() => {
    setViewportVhVar();
    window.addEventListener("resize", setViewportVhVar);

    sigRef.current = connectSignaling(
      async (msg) => {
        if (msg?.type === "webrtc-offer" && msg.sdp) {
          await acceptOffer(msg.sdp);
        }
        if (msg?.type === "webrtc-ice" && msg.candidate) {
          const pc = pcRef.current;
          const cand = normCandidate(msg.candidate);
          if (pc && cand) {
            try { await pc.addIceCandidate(cand); } catch {}
          }
        }
        if (msg?.type === "ended") {
          cleanupPc();
          setNote("Stream beendet.");
        }
      },
      (status) => {
        const ok = !!status?.ok;
        setSigOk(ok);

        if (!ok) return;

        // On reconnect, re-announce join (common on mobile)
        if (startedRef.current && !hasVideoRef.current) {
          sendViewerJoin();
        }
      }
    );

    return () => {
      window.removeEventListener("resize", setViewportVhVar);
      cleanupPc();
      try { sigRef.current?.close?.(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autoplay helper: user gesture required on iOS; we still try.
  async function tryPlay() {
    try {
      if (videoRef.current) await videoRef.current.play();
    } catch {}
  }

  const canFullscreen = useMemo(() => {
    const v = videoRef.current;
    return !!(v && (v.requestFullscreen || v.webkitEnterFullscreen));
  }, [videoRef.current]);

  async function toggleFullscreen() {
    const v = videoRef.current;
    if (!v) return;

    // iOS Safari uses webkitEnterFullscreen() (native player)
    if (v.webkitEnterFullscreen) {
      try { v.webkitEnterFullscreen(); } catch {}
      return;
    }

    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch {}
      return;
    }
    try { await v.requestFullscreen(); } catch {}
  }

  return (
    <div className="wrap">
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0 }}>Zuschauer</h2>
            <div className="muted">Code: <strong>{code}</strong> • Signaling: <strong style={{ color: sigOk ? "#b6ffbf" : "#ffb3b3" }}>{sigOk ? "ok" : "offline"}</strong></div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btnPrimary" onClick={() => { startedRef.current = true; startJoinLoop("Verbinde…"); tryPlay(); }}>Play</button>
            <button className="btn" onClick={() => setTheater((s) => !s)}>{theater ? "Normal" : "Theater"}</button>
            <button className="btn" onClick={() => setMuted((m) => !m)}>{muted ? "Ton an" : "Ton aus"}</button>
            {canFullscreen && <button className="btn" onClick={toggleFullscreen}>Fullscreen</button>}
          </div>
        </div>

        {note && <div className="muted" style={{ marginTop: 10 }}>{note}</div>}

        <div className={"videoStage" + (theater ? " theater" : "")} style={{ marginTop: 14 }}>
          <video
            ref={videoRef}
            className="videoEl"
            playsInline
            autoPlay
            muted={muted}
            controls={false}
            onClick={tryPlay}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, flexWrap: "wrap", gap: 10 }}>
          <Link className="btn" to="/">Zur Startseite</Link>
          <div className="muted">Tip: iPhone → zuerst Play tippen, dann Fullscreen.</div>
        </div>
      </div>
    </div>
  );
}
