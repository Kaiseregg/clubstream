// Watch.jsx – robust viewer: dark overlay (inline), multi-protocol join/offer, join-ping retry
import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getIceConfig } from "../lib/ice";
import { connectSignaling as connectSignal } from "../lib/signaling";

export default function Watch() {
  const { code } = useParams();
  const videoRef = useRef(null);
  const wrapRef = useRef(null);
  const pcRef = useRef(null);
  const sigRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());
  const joinTimerRef = useRef(null);
  const [connecting, setConnecting] = useState(false);
  const [hasMedia, setHasMedia] = useState(false);
  const [hint, setHint] = useState("Tippe auf Play, um abzuspielen.");

  function cleanupPc() {
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.oniceconnectionstatechange = null;
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }
    remoteStreamRef.current = new MediaStream();
    if (videoRef.current) videoRef.current.srcObject = null;
    setHasMedia(false);
  }

  async function userStartPlayback() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true; // autoplay-safe; user can unmute via your existing UI
    try { await v.play(); } catch {}
  }

  function sendJoin() {
    const payloads = [
      { type: "viewer-join", code },
      { type: "viewer_join", code },
      { type: "join", role: "viewer", code },
    ];
    payloads.forEach(p => {
      try { sigRef.current?.send?.(p); } catch {}
    });
  }

  function startJoinLoop() {
    if (joinTimerRef.current) clearInterval(joinTimerRef.current);
    let tries = 0;
    sendJoin();
    joinTimerRef.current = setInterval(() => {
      if (hasMedia) return;
      tries += 1;
      sendJoin();
      if (tries >= 6) {
        clearInterval(joinTimerRef.current);
        joinTimerRef.current = null;
        setConnecting(false);
        setHint("Keine Verbindung – tippe erneut.");
      }
    }, 1500); // ~9s total
  }

  async function joinOrRetry() {
    setConnecting(true);
    setHint("Verbinde…");
    await userStartPlayback();
    startJoinLoop();
  }

  useEffect(() => {
    cleanupPc();
    if (joinTimerRef.current) { clearInterval(joinTimerRef.current); joinTimerRef.current = null; }

    sigRef.current = connectSignal(
      async (msg) => {
        // Debug: uncomment if needed
        // console.log("[viewer] msg", msg);

        const t = msg?.type;
        const offerObj = (t === "webrtc-offer" || t === "offer" || t === "rtc-offer") ? (msg.offer || msg.sdp || msg) : null;
        if (!offerObj) return;

        cleanupPc();
        const pc = new RTCPeerConnection(await getIceConfig(true));
        pcRef.current = pc;

        pc.ontrack = (ev) => {
          ev.streams?.[0]?.getTracks?.().forEach(tr => remoteStreamRef.current.addTrack(tr));
          if (videoRef.current) {
            videoRef.current.srcObject = remoteStreamRef.current;
            userStartPlayback();
            setHasMedia(true);
            setConnecting(false);
            setHint("");
            if (joinTimerRef.current) { clearInterval(joinTimerRef.current); joinTimerRef.current = null; }
          }
        };

        pc.oniceconnectionstatechange = () => {
          const s = pc.iceConnectionState;
          if (s === "failed" || s === "disconnected") {
            cleanupPc();
            joinOrRetry();
          }
        };

        await pc.setRemoteDescription(offerObj);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // Send multiple answer variants (host will use what it expects)
        const answers = [
          { type: "webrtc-answer", answer, code },
          { type: "answer", answer, code },
          { type: "rtc-answer", answer, code },
        ];
        answers.forEach(a => { try { sigRef.current?.send?.(a); } catch {} });
      },
      () => {}
    );

    return () => {
      if (joinTimerRef.current) { clearInterval(joinTimerRef.current); joinTimerRef.current = null; }
      cleanupPc();
      try { sigRef.current?.close?.(); } catch {}
    };
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleFullscreen() {
    if (!wrapRef.current) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        requestAnimationFrame(() => window.scrollTo(0, 0));
      } else {
        await wrapRef.current.requestFullscreen();
      }
    } catch {}
  }

  return (
    <div className="videoWrap" ref={wrapRef}>
      <video ref={videoRef} playsInline />

      {!hasMedia && (
        <button
          onClick={joinOrRetry}
          style={{
            position: "absolute",
            inset: 0,
            margin: "auto",
            width: 220,
            height: 140,
            borderRadius: 16,
            background: "rgba(0,0,0,0.65)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.25)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            cursor: "pointer",
            backdropFilter: "blur(6px)",
          }}
          aria-label="Start"
        >
          <div style={{ fontSize: 22, fontWeight: 700 }}>▶ Start</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>{connecting ? "Verbinde…" : hint}</div>
        </button>
      )}

      <button className="fsBtn" onClick={toggleFullscreen} aria-label="Fullscreen">⤢</button>
      <Link to="/" className="backBtn">← Zurück</Link>
    </div>
  );
}
