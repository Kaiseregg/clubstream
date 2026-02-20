import React, { useEffect, useMemo, useRef, useState } from 'react'
import { connectSignaling } from '../lib/signaling.js'
import { getIceConfig } from '../lib/ice.js'

function mkCode(){
  const a = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4)
  const b = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4)
  return `${a}-${b}`
}

/**
 * MINIMAL, CONSISTENT WEBRTC FLOW (Option A)
 * Host (Admin) creates OFFER when viewer joins.
 * Viewer sends ANSWER.
 * ICE exchanged both ways.
 */
export default function Admin({ role = 'streamer' }){
  const [code, setCode] = useState(mkCode())
  const [sigOk, setSigOk] = useState(false)
  const [status, setStatus] = useState('idle') // idle | live
  const [err, setErr] = useState('')

  const localVideoRef = useRef(null)
  const streamRef = useRef(null)
  const sigRef = useRef(null)
  const pcsRef = useRef(new Map()) // viewerId -> RTCPeerConnection

  // optional: force relay via ?relay=1 (useful on 5G/NAT). Keep default false.
  const forceRelay = useMemo(() => {
    try {
      const q = new URLSearchParams(window.location.search)
      return q.get('relay') === '1'
    } catch {
      return false
    }
  }, [])

  useEffect(() => {
    const sig = connectSignaling(onSigMsg, (s) => setSigOk(!!s.ok))
    sigRef.current = sig
    return () => { try { sig.close?.() ?? sig.ws?.close?.() } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function ensureMedia(){
    if (streamRef.current) return streamRef.current
    setErr('')
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    streamRef.current = s
    if (localVideoRef.current) localVideoRef.current.srcObject = s
    return s
  }

  function cleanupViewer(viewerId){
    const pc = pcsRef.current.get(viewerId)
    if (pc){
      try { pc.close() } catch {}
      pcsRef.current.delete(viewerId)
    }
  }

  function onSigMsg(msg){
    // Viewer announces itself -> host MUST create offer
    if (msg.type === 'viewer-join' || msg.type === 'viewer-joined'){
      const viewerId = msg.viewerId || msg.from
      if (!viewerId) return
      console.log('[admin] viewer joined', viewerId)
      createOfferForViewer(viewerId).catch(e => setErr(String(e?.message || e)))
      return
    }

    // Viewer sends answer -> set remote desc
    if (msg.type === 'webrtc-answer'){
      const viewerId = msg.from
      const pc = pcsRef.current.get(viewerId)
      if (!pc) return
      console.log('[admin] RECV ANSWER from', viewerId)
      pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {})
      return
    }

    // Viewer ICE -> host
    if (msg.type === 'webrtc-ice'){
      if (msg.origin === 'broadcaster') return // ignore echoed self
      const viewerId = msg.from
      const pc = pcsRef.current.get(viewerId)
      if (pc && msg.candidate){
        pc.addIceCandidate(msg.candidate).catch(() => {})
      }
      return
    }

    if (msg.type === 'viewer-left'){
      cleanupViewer(msg.viewerId || msg.from)
    }
  }

  async function start(){
    await ensureMedia()
    setStatus('live')
    setErr('')
    sigRef.current?.send({ type:'host-join', code })
    console.log('[admin] host-join', code)
  }

  function stop(){
    setStatus('idle')
    try { sigRef.current?.send({ type:'host-stop', code }) } catch {}
    for (const pc of pcsRef.current.values()) { try { pc.close() } catch {} }
    pcsRef.current.clear()
    try { streamRef.current?.getTracks?.().forEach(t => t.stop()) } catch {}
    streamRef.current = null
    if (localVideoRef.current) localVideoRef.current.srcObject = null
  }

  async function createOfferForViewer(viewerId){
    const sig = sigRef.current
    if (!sig) return

    const local = await ensureMedia()

    // close old connection for same viewer
    cleanupViewer(viewerId)

    const iceCfg = await getIceConfig()
    const pc = new RTCPeerConnection({
      ...iceCfg,
      iceTransportPolicy: forceRelay ? 'relay' : 'all',
    })
    pcsRef.current.set(viewerId, pc)

    // add tracks
    local.getTracks().forEach(t => pc.addTrack(t, local))

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return
      console.log('[admin] ICE -> viewer', viewerId)
      sig.send({
        type: 'webrtc-ice',
        origin: 'broadcaster',
        code,
        to: viewerId,
        candidate: ev.candidate,
      })
    }

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      console.log('[admin] pc state', viewerId, st)
      if (st === 'failed' || st === 'disconnected' || st === 'closed'){
        cleanupViewer(viewerId)
      }
    }

    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false })
    await pc.setLocalDescription(offer)

    console.log('[admin] SEND OFFER to', viewerId)
    sig.send({
      type: 'webrtc-offer',
      origin: 'broadcaster',
      code,
      to: viewerId,
      sdp: pc.localDescription?.sdp || offer.sdp,
    })
  }

  const watchUrl = `${window.location.origin}/watch/${encodeURIComponent(code)}`

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: 16, color: '#e5e7eb' }}>
      <h2 style={{ margin: '8px 0 4px' }}>Admin (Live)</h2>
      <div style={{ opacity: 0.9, marginBottom: 12 }}>
        Signaling: <b style={{ color: sigOk ? '#22c55e' : '#f97316' }}>{sigOk ? 'ok' : 'offline'}</b>
        {' '}• Status: <b>{status}</b>
        {role ? <span style={{ opacity: 0.7 }}> • Role: {role}</span> : null}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Code</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{code}</div>
        </div>

        <button
          onClick={() => setCode(mkCode())}
          disabled={status === 'live'}
          style={{ padding: '8px 12px' }}
        >
          Neuer Code
        </button>

        {status !== 'live' ? (
          <button onClick={start} style={{ padding: '8px 12px' }}>Start Kamera</button>
        ) : (
          <button onClick={stop} style={{ padding: '8px 12px' }}>Stop</button>
        )}

        <button
          onClick={() => {
            navigator.clipboard?.writeText(watchUrl)
          }}
          style={{ padding: '8px 12px' }}
        >
          Watch-Link kopieren
        </button>
      </div>

      <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 12 }}>
        Zuschauer-Link: <a href={watchUrl} target="_blank" rel="noreferrer">{watchUrl}</a>
      </div>

      {err ? (
        <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', padding: 10, borderRadius: 8, marginBottom: 12 }}>
          <b>Fehler:</b> {err}
        </div>
      ) : null}

      <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.12)' }}>
        <video ref={localVideoRef} autoPlay playsInline muted style={{ width: '100%', background: '#000' }} />
      </div>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
        Debug: Öffne F12 Console → du solltest sehen: <code>viewer joined</code>, <code>SEND OFFER</code>, <code>RECV ANSWER</code>, <code>ICE</code>.
      </div>
    </div>
  )
}
