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

export default function Watch() {
  const { code } = useParams();

  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const sigRef = useRef(null);
  const broadcasterIdRef = useRef(null);
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
    // Mobile networks are often symmetric NAT -> relay helps a lot
    return isMobileUA();
  }, []);

  function stopJoinLoop() {
    if (joinTimerRef.current) {
      clearInterval(joinTimerRef.current);
      joinTimerRef.current = null;
    }
  }

  function cleanupPc() {
    stopJoinLoop();
    hasVideoRef.current = false;

    try {
      if (pcRef.current) {
        pcRef.current.ontrack = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      }
    } catch {}

    pcRef.current = null;
    remoteStreamRef.current = new MediaStream();

    const v = videoRef.current;
    if (v) {
      try { v.pause(); } catch {}
      v.srcObject = null;
    }
  }

  async function ensurePlaybackGesture() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    try {
      await v.play();
    } catch {
      // ignore – user can tap again
    }
  }

  function sendViewerJoin() {
    if (!sigRef.current?.send) return;
    sigRef.current.send({ type: "viewer-join", code });
  }

  function startJoinLoop(reasonText) {
    startedRef.current = true;
    if (reasonText) setNote(reasonText);

    // Send immediately
    sendViewerJoin();

    // Keep sending until offer arrives (helps when WS reconnects on 4G/5G)
    if (!joinTimerRef.current) {
      joinTimerRef.current = setInterval(() => {
        if (hasVideoRef.current) return;
        if (!sigOk) return;
        sendViewerJoin();
      }, 1500);
    }
  }

  async function onPlayClick() {
    setError(null);
    await ensurePlaybackGesture();

    // if signaling not ready yet, start join loop (will keep WS alive)
    if (!sigOk || !sigRef.current) {
      setStarted(true);
      startedRef.current = true;
      setNote('Verbinde…');
      startJoinLoop();
      return;
    }

    try {
      setStarted(true);
      startedRef.current = true;
      setNote('Verbinde…');

      const pc = await createViewerPc();

      // recvonly negotiation
      try { pc.addTransceiver('video', { direction: 'recvonly' }); } catch {}
      try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch {}

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sigRef.current.send({
        type: 'webrtc-offer',
        origin: 'viewer',
        code,
        sdp: pc.localDescription,
      });
    } catch (e) {
      console.error(e);
      setError('Verbindung fehlgeschlagen');
      setNote('Fehler');
    }
  }

  async function createViewerPc() {
    if (pcRef.current) return pcRef.current;

    const cfg = await getIceConfig();
    const pc = new RTCPeerConnection(cfg);
    pcRef.current = pc;

    pc.ontrack = (e) => {
      if (e.streams && e.streams[0] && videoRef.current) {
        videoRef.current.srcObject = e.streams[0];
      }
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      sigRef.current?.send({
        type: 'webrtc-ice',
        origin: 'viewer',
        code,
        candidate: e.candidate,
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setNote('');
      if (pc.connectionState === 'failed') setError('Verbindung fehlgeschlagen');
    };

    return pc;
  }


  async function requestFs() {
    // Try Fullscreen API (desktop/Android). iOS Safari often requires native video fullscreen.
    const el = document.querySelector(".viewerCard");
    try {
      if (el?.requestFullscreen) {
        await el.requestFullscreen();
      } else {
        // Fallback to theater mode if fullscreen API not available
        setTheater((v) => !v);
      }
    } catch {
      setTheater((v) => !v);
    }
  }

  async function acceptOffer(offerSdp) {
    cleanupPc();

    const pc = new RTCPeerConnection(await getIceConfig(forceRelay));
    pcRef.current = pc;

    // Trickle ICE back to broadcaster (critical for NAT / 4G / 5G)
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      sigRef.current?.send?.({
        type: "webrtc-ice",
        origin: "viewer",
        code,
        // Signaling server routes by "to" (sender is provided as "from")
        ...(broadcasterIdRef.current ? { to: broadcasterIdRef.current } : {}),
        candidate: ev.candidate,
      });
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams?.[0];
      if (!stream) return;

      // Collect tracks into a dedicated MediaStream
      stream.getTracks().forEach((t) => {
        try { remoteStreamRef.current.addTrack(t); } catch {}
      });

      const v = videoRef.current;
      if (v && v.srcObject !== remoteStreamRef.current) {
        v.srcObject = remoteStreamRef.current;
        hasVideoRef.current = true;
        stopJoinLoop();
        setNote("");
        ensurePlaybackGesture();
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") {
        setNote("");
      }
      if (st === "failed" || st === "disconnected") {
        // Mobile network drops -> restart join
        cleanupPc();
        startJoinLoop("Verbindung unterbrochen – neu verbinden…");
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

    // The admin may (by mistake or older builds) send either:
    // - a raw SDP string
    // - an RTCSessionDescriptionInit ({type,sdp})
    // If we blindly put an object into the sdp field, the browser tries to parse "[object Object]".
    const offerDesc =
      offerSdp && typeof offerSdp === "object"
        ? offerSdp
        : { type: "offer", sdp: String(offerSdp || "") };
    await pc.setRemoteDescription(offerDesc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sigRef.current?.send?.({
      type: "webrtc-answer",
      origin: "viewer",
      code,
      ...(broadcasterIdRef.current ? { to: broadcasterIdRef.current } : {}),
      sdp: answer.sdp,
    });
  }

  // Signaling connect
  useEffect(() => {
    setViewportVhVar();
    window.addEventListener("resize", setViewportVhVar);

    sigRef.current = connectSignaling(
      async (msg) => {
        if (msg?.type === "webrtc-offer" && msg.sdp) {
          broadcasterIdRef.current = msg.from || null;
          await acceptOffer(msg.sdp);
        }

        if (msg?.type === "webrtc-answer" && (msg.sdp || msg?.sdp?.sdp)) {
          await acceptAnswer(msg);
        }

        // Trickle ICE from broadcaster
        if (msg?.type === "webrtc-ice" && msg.candidate && pcRef.current) {
          // Ignore our own echoed ICE (some signaling setups broadcast to sender)
          if (msg.origin === "viewer") return;
          try {
            await pcRef.current.addIceCandidate(msg.candidate);
          } catch {}
        }
      },
      (status) => {
        const ok = !!status?.ok;
        setSigOk(ok);

        if (!ok) {
          // Keep UI ready for re-join
          if (startedRef.current && !hasVideoRef.current) {
            setNote("Verbindung…");
          }
          return;
        }

        // Auto-start once signaling is connected.
        // This avoids cases where the Play overlay/button doesn't trigger on some browsers/devices.
        if (!startedRef.current) {
          setNote("Verbinde…");
          startJoinLoop();
          return;
        }

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
  }, [code]);

  // Keep video element mute state in sync
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.muted = muted;
  }, [muted]);

  function toggleTheater() {
    setTheater((v) => !v);
    // When switching modes, keep playback alive
    setTimeout(() => ensurePlaybackGesture(), 0);
  }

  return (
    <div className={"row"}>
      <div className={"col"}>
        <div className={"card"}>
          <div className={"cardHead"}>
            <div>
              <div className={"h1"}>Live</div>
              <div className={"sub"}>
                Signaling: {sigOk ? "ok" : "…"} · <Link to={"/"}>← Zurück</Link>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
              <div className={"pill"}>Code: {code}</div>
              <button className={"btn"} onClick={onPlayClick}>
                Play
              </button>
              <button className={"btn"} onClick={toggleTheater}>
                Theater
              </button>
              <button className={"btn"} onClick={() => setMuted((m) => !m)}>
                {muted ? "Ton an" : "Ton aus"}
              </button>
              <button className={"btn"} onClick={requestFs}>
                Fullscreen
              </button>
            </div>
          </div>

          <div className={"videoWrap"}>
            <div className={"video " + (theater ? "theaterOn" : "")}
                 style={theater ? { height: "calc(var(--vh, 1vh) * 100)" } : undefined}>
              <video
                ref={videoRef}
                className={"videoEl"}
                playsInline
                muted={muted}
                controls={false}
              />

              {!hasVideoRef.current && (
                <button className={"playOverlay"} onClick={onPlayClick}>
                  <div className={"playOverlayInner"}>
                    <div className={"playIcon"}>▶</div>
                    <div className={"playText"}>
                      <div className={"playTitle"}>Start</div>
                      <div className={"playHint"}>{note}</div>
                    </div>
                  </div>
                </button>
              )}

              <button className={"fsBtn"} onClick={toggleTheater} title={"Vollbild"}>
                ⤢
              </button>

              {theater && (
                <button className={"theaterClose"} onClick={() => setTheater(false)} title={"Schliessen"}>
                  ✕
                </button>
              )}
            </div>
          </div>

          <div className={"cardFoot"}>
            <div className={"sub"}>Keine Wiederholung · nur live</div>
            <button className={"btn"} onClick={() => setMuted((m) => !m)}>
              {muted ? "Ton an" : "Ton aus"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


  async function acceptAnswer(answerMsg) {
    try {
      const pc = pcRef.current;
      if (!pc) return;
      const sdp = answerMsg?.sdp && typeof answerMsg.sdp === 'string' ? answerMsg.sdp : answerMsg?.sdp?.sdp;
      if (!sdp) return;
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      setNote('');
    } catch (e) {
      console.error('acceptAnswer failed', e);
    }
  }
