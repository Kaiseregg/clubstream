// FINAL Watch.jsx – viewer fix ONLY (no CSS changes)
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
  const lastJoinRef = useRef(0);

  const [started, setStarted] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [hasMedia, setHasMedia] = useState(false);
  const [hint, setHint] = useState("Tippe auf Play, um abzuspielen.");
  const [isFullscreen, setIsFullscreen] = useState(false);

  function cleanupPc() {
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    remoteStreamRef.current = new MediaStream();
    if (videoRef.current) videoRef.current.srcObject = null;
    setHasMedia(false);
  }

  async function userStartPlayback() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    try { await v.play(); } catch {}
  }

  async function joinOrRetry() {
    setStarted(true);
    setConnecting(true);
    setHint("Verbinde…");
    await userStartPlayback();

    const now = Date.now();
    if (now - lastJoinRef.current < 800) return;
    lastJoinRef.current = now;

    sigRef.current?.send?.({ type: "viewer-join", code });
  }

  useEffect(() => {
    sigRef.current = connectSignal(
      async (msg) => {
        if (msg.type === "webrtc-offer") {
          cleanupPc();

          const pc = new RTCPeerConnection(await getIceConfig(true));
          pcRef.current = pc;

          pc.ontrack = (ev) => {
            ev.streams[0].getTracks().forEach(t =>
              remoteStreamRef.current.addTrack(t)
            );

            if (videoRef.current) {
              videoRef.current.srcObject = remoteStreamRef.current;
              userStartPlayback();
              setHasMedia(true);
              setConnecting(false);
              setHint("");
            }
          };

          pc.oniceconnectionstatechange = () => {
            if (["failed", "disconnected"].includes(pc.iceConnectionState)) {
              cleanupPc();
              joinOrRetry();
            }
          };

          await pc.setRemoteDescription(msg.offer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          sigRef.current.send({
            type: "webrtc-answer",
            answer,
            code
          });
        }
      },
      () => {}
    );

    return () => {
      cleanupPc();
      sigRef.current?.close?.();
    };
  }, [code]);

  useEffect(() => {
    if (!started || hasMedia) return;
    const t = setTimeout(() => {
      if (!hasMedia) {
        setConnecting(false);
        setHint("Keine Verbindung – tippe erneut.");
      }
    }, 6000);
    return () => clearTimeout(t);
  }, [started, hasMedia]);

  useEffect(() => {
    const f = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);

  async function toggleFullscreen() {
    if (!wrapRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await wrapRef.current.requestFullscreen();
  }

  return (
    <div className="videoWrap" ref={wrapRef}>
      <video ref={videoRef} playsInline />
      {!hasMedia && (
        <button className="overlayPlay" onClick={joinOrRetry}>
          <div>▶ Start</div>
          <small>{connecting ? "Verbinde…" : hint}</small>
        </button>
      )}
      <button className="fsBtn" onClick={toggleFullscreen}>⤢</button>
      <Link to="/" className="backBtn">← Zurück</Link>
    </div>
  );
}
