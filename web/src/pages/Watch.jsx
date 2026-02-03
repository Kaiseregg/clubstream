// Watch.jsx – stable viewer (mobile + desktop)
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getIceConfig } from "../lib/ice";
import { connectSignaling } from "../lib/signaling";

function normCandidate(c) {
  if (!c) return null;
  if (typeof c.toJSON === "function") return c.toJSON();
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
    usernameFragment: c.usernameFragment ?? null,
  };
}

export default function Watch() {
  const { code } = useParams();

  const wrapRef = useRef(null);
  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const sigRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());

  const [connecting, setConnecting] = useState(false);
  const [hasMedia, setHasMedia] = useState(false);
  const [sigOk, setSigOk] = useState(false);
  const [note, setNote] = useState("Tippe auf Start.");
  const [theater, setTheater] = useState(false);

  const isIOS = useMemo(() => {
    const ua = navigator.userAgent || "";
    return /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  }, []);

  function setVideoStream() {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = remoteStreamRef.current;
  }

  async function safePlay() {
    const v = videoRef.current;
    if (!v) return;
    v.playsInline = true;
    v.muted = true; // allow autoplay on mobile
    try { await v.play(); } catch {}
  }

  function cleanupPc() {
    try { pcRef.current?.close?.(); } catch {}
    pcRef.current = null;
    remoteStreamRef.current = new MediaStream();
    if (videoRef.current) videoRef.current.srcObject = null;
    setHasMedia(false);
  }

  async function ensurePc() {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection(await getIceConfig(true));
    pcRef.current = pc;

    pc.ontrack = (ev) => {
      const s = ev.streams?.[0];
      if (!s) return;
      s.getTracks().forEach((t) => remoteStreamRef.current.addTrack(t));
      setVideoStream();
      safePlay();
      setHasMedia(true);
      setConnecting(false);
      setNote("");
    };

    pc.onicecandidate = (ev) => {
      const c = normCandidate(ev.candidate);
      if (c) sigRef.current?.send?.({ type: "webrtc-ice", code, candidate: c });
    };

    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === "checking") setNote("Verbinde…");
      if (st === "connected" || st === "completed") setNote("");
      if (st === "failed" || st === "disconnected") {
        // keep UI responsive; user can tap start again
        setHasMedia(false);
        setConnecting(false);
        setNote("Verbindung unterbrochen – tippe erneut.");
      }
    };

    return pc;
  }

  function join() {
    setConnecting(true);
    setNote("Verbinde…");
    safePlay();
    sigRef.current?.send?.({ type: "viewer-join", code });
  }

  async function onOffer(msg) {
    const desc = msg?.sdp || msg?.offer || msg?.desc;
    if (!desc || typeof desc.sdp !== "string" || typeof desc.type !== "string") {
      setConnecting(false);
      setNote("Offer fehlerhaft (kein SDP). Bitte erneut starten.");
      return;
    }

    cleanupPc();
    const pc = await ensurePc();

    await pc.setRemoteDescription(desc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // IMPORTANT: send plain JSON for the answer
    sigRef.current?.send?.({
      type: "webrtc-answer",
      code,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    });
  }

  async function onIce(msg) {
    const c = msg?.candidate;
    if (!c || !pcRef.current) return;
    try { await pcRef.current.addIceCandidate(new RTCIceCandidate(c)); } catch {}
  }

  useEffect(() => {
    // signaling
    sigRef.current = connectSignaling(
      async (msg) => {
        try {
          if (msg?.type === "webrtc-offer") await onOffer(msg);
          if (msg?.type === "webrtc-ice") await onIce(msg);
        } catch {
          setConnecting(false);
          setNote("Fehler – tippe erneut.");
        }
      },
      (st) => {
        const ok = !!st?.ok;
        setSigOk(ok);
        // if Render is waking up, auto-join once WS becomes ok
        if (ok) {
          // small delay prevents "join too early" after cold start
          setTimeout(() => {
            if (!hasMedia) join();
          }, 200);
        }
      }
    );

    return () => {
      cleanupPc();
      sigRef.current?.close?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // keep iOS safe-area vh stable when theater mode is on
  useEffect(() => {
    function setVh() {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty("--vh", `${vh}px`);
    }
    setVh();
    window.addEventListener("resize", setVh);
    window.addEventListener("orientationchange", setVh);
    return () => {
      window.removeEventListener("resize", setVh);
      window.removeEventListener("orientationchange", setVh);
    };
  }, []);

  async function toggleFullscreen() {
    const el = wrapRef.current;
    if (!el) return;

    // iOS Safari has flaky Fullscreen API for custom video containers → use theater mode
    if (isIOS) {
      setTheater((v) => !v);
      setTimeout(safePlay, 0);
      return;
    }

    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      // fallback
      setTheater((v) => !v);
    }
  }

  const showOverlay = !hasMedia;

  return (
    <div className="layout">
      <header className="topBar">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="title">Stream Live</div>
            <div className="sub">Live Sport • ohne Replay</div>
          </div>
        </div>
        <div className="topBtns">
          <Link className="pill" to="/">Zuschauer</Link>
          <Link className="pill" to="/admin">Admin</Link>
        </div>
      </header>

      <div className="card">
        <div className="cardHead">
          <div>
            <div className="h1">Live</div>
            <div className="meta">
              Signaling: {sigOk ? "ok" : "…"} • <Link to="/">← Zurück</Link>
            </div>
            <div className="meta">Code: {code}</div>
          </div>
        </div>

        <div ref={wrapRef} className={`video ${theater ? "theaterOn" : ""}`}>
          <video ref={videoRef} className="videoEl" playsInline />

          {showOverlay && (
            <button className="playOverlay" onClick={join}>
              <div className="playIcon">▶</div>
              <div className="playText">Start</div>
              <div className="playHint">{connecting ? "Verbinde…" : note}</div>
            </button>
          )}

          <button className="fsBtn" onClick={toggleFullscreen} aria-label="fullscreen">
            ⤢
          </button>

          {theater && (
            <button className="theaterClose" onClick={() => setTheater(false)} aria-label="close">
              ✕
            </button>
          )}
        </div>

        <div className="foot">
          <div className="footLeft">Keine Wiederholung • nur live</div>
        </div>
      </div>
    </div>
  );
}
