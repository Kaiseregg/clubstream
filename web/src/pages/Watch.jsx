import React, { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { connectSignaling } from '../lib/signaling.js'
import { getIceConfig } from '../lib/ice.js'

export default function Watch(){
  const { code } = useParams()
  const [sigOk, setSigOk] = useState(false)
  const [note, setNote] = useState('')
  const [match, setMatch] = useState(null)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(true)
  const [theater, setTheater] = useState(false)
  const [playReady, setPlayReady] = useState(false)
  const videoRef = useRef(null)
  const containerRef = useRef(null)
  const sigRef = useRef(null)
  const pcRef = useRef(null)

  function isIOS(){
    const ua = navigator.userAgent || ''
    return /iPad|iPhone|iPod/.test(ua) && !window.MSStream
  }

  async function requestFullscreen(){
    const video = videoRef.current
    const cont = containerRef.current

    // iOS Safari: Fullscreen API is limited; use native fullscreen when possible.
    if(isIOS() && video?.webkitEnterFullscreen){
      try{ video.webkitEnterFullscreen() }catch{}
      return
    }

    try{
      const req = cont?.requestFullscreen || cont?.webkitRequestFullscreen || cont?.msRequestFullscreen
      if(req) await req.call(cont)
    }catch{}
  }

  // Scroll-Lock when in theater mode
  useEffect(()=>{
    const exitFs = () => {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen
      try{ exit?.call(document) }catch{}
    }

    if(!theater){
      exitFs()
      return
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return ()=>{ document.body.style.overflow = prevOverflow }
  },[theater])

  useEffect(()=>{
    const sig = connectSignaling(onSigMsg, (s)=>setSigOk(!!s.ok))
    sigRef.current = sig
    sig.send({ type:'viewer-join', code })
    return ()=>{
      try{ sig.close?.() ?? sig.ws.close() }catch{}
      try{ pcRef.current?.close() }catch{}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  function onSigMsg(msg){
    if (msg.type === 'webrtc-offer' && msg.sdp){
      acceptOffer(msg.sdp, msg.from).catch(e=>setNote(String(e?.message||e)))
    }
    if (msg.type === 'webrtc-ice' && msg.candidate){
      pcRef.current?.addIceCandidate(msg.candidate).catch(()=>{})
    }
    if (msg.type === 'match-state'){
      setMatch(msg.match || null)
      if(typeof msg.paused === 'boolean') setPaused(!!msg.paused)
    }
    if (msg.type === 'pause-state'){
      setPaused(!!msg.paused)
    }
    if (msg.type === 'viewer-denied'){
      setNote(`Zuschauerlimit erreicht (max. ${msg.max || 80}).`)
    }
    if (msg.type === 'host-available'){
      // Host came back, new offer will follow.
      setNote('Stream wird wieder verbunden…')
    }
    if (msg.type === 'ended'){
      setNote(msg?.canReconnect ? 'Stream unterbrochen – warte auf Restart…' : 'Stream beendet.')
      try{ pcRef.current?.close() }catch{}
      pcRef.current = null
    }
  }

  async function acceptOffer(sdp, hostId){
    const sig = sigRef.current
    if (!sig) return
    setNote('Verbinde...')

    const pc = new RTCPeerConnection(await getIceConfig())
    pcRef.current = pc

    pc.onconnectionstatechange = ()=>{
      const st = pc.connectionState
      if (st === 'failed') setNote('Verbindung fehlgeschlagen (ICE/Netz).')
      if (st === 'connecting') setNote('Verbinde...')
    }
    pc.oniceconnectionstatechange = ()=>{
      const st = pc.iceConnectionState
      if (st === 'checking') setNote('Verbinde...')
      if (st === 'failed') setNote('ICE fehlgeschlagen (STUN/TURN nötig).')
    }

    pc.ontrack = (ev)=>{
      const [stream] = ev.streams
      if (videoRef.current && stream){
        videoRef.current.srcObject = stream
        // Autoplay with audio is often blocked by browsers.
        // We start muted and try to play; user can unmute.
        videoRef.current.muted = muted
        const p = videoRef.current.play?.()
        if (p && typeof p.then === 'function') {
          p.then(()=>{ setNote(''); setPlayReady(true) }).catch(()=>{ setPlayReady(false); setNote('Tippe auf Play, um abzuspielen.') })
        } else {
          setNote('')
          setPlayReady(true)
        }
      }
    }
    pc.onicecandidate = (ev)=>{
      if (ev.candidate) sig.send({ type:'webrtc-ice', code, to: hostId, candidate: ev.candidate })
    }

    await pc.setRemoteDescription(sdp)
    const ans = await pc.createAnswer()
    await pc.setLocalDescription(ans)
    sig.send({ type:'webrtc-answer', code, to: hostId, sdp: pc.localDescription })
  }

  
  async function ensurePlayback(){
    const v = videoRef.current
    if(!v) return
    try{
      v.muted = false
      setMuted(false)
      await v.play?.()
      setPlayReady(true)
      setNote('')
    }catch{
      setPlayReady(false)
      setNote('Tippe auf Play, um abzuspielen.')
    }
  }

  async function handlePlay(){
    await ensurePlayback()
    setTheater(true)
    await requestFullscreen()
  }

return (
    <div className="card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
        <h2 className="h">Live</h2>
        <span className="badge">Code: {code}</span>
      </div>
      <div className="muted" style={{marginBottom:10}}>
        Signaling: {sigOk ? 'ok' : 'offline'} • <Link to="/">← Zurück</Link>
      </div>

      <div ref={containerRef} className={"video" + (theater ? " theaterOn" : "")} style={{position:'relative'}}>

        <div style={{position:'absolute',top:10,right:10,display:'flex',gap:8,zIndex:6}}>
          {theater && (
            <button className="theaterClose" onClick={()=>setTheater(false)} aria-label="Theater schliessen">×</button>
          )}
          <button className="fsBtn" onClick={handlePlay} aria-label="Fullscreen">
            ⤢
          </button>
        </div>

        {match ? (
          <div style={{
            position:'absolute',top:10,left:10,right:10,
            display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,
            padding:'10px 12px',
            background:'rgba(0,0,0,.45)',border:'1px solid rgba(255,255,255,.14)',
            borderRadius:14,backdropFilter:'blur(6px)'
          }}>
            <div style={{minWidth:0}}>
              <div style={{fontSize:12,opacity:.9}}>{match.sport || 'Sport'}</div>
              <div style={{fontWeight:800,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                {(match.teamA||'Team A')} vs {(match.teamB||'Team B')}
              </div>
            </div>
            <div style={{textAlign:'right',flexShrink:0}}>
              {match.periodsTotal ? (
                <div style={{fontSize:12,opacity:.9,fontWeight:800}}>{Number(match.period||1)}/{Number(match.periodsTotal)}</div>
              ) : null}
              <div style={{fontWeight:900,fontSize:18}}>
              {Number(match.scoreA||0)} : {Number(match.scoreB||0)}
              </div>
            </div>
          </div>
        ) : null}

        {/* overlay removed; match is shown above the video for better readability */}

        <video
          ref={videoRef}
          className="videoEl"
          autoPlay
          playsInline
          controls={false}
          muted={muted}
          onClick={handlePlay}
          style={{
            width:'100%',
            height:'100%',
            background:'#000',
            objectFit: theater ? 'contain' : 'cover'
          }} />

        {/* Play overlay (iOS autoplay / permissions) */}
        {(!playReady || note) && (
          <div className="playOverlay" onClick={handlePlay}>
            <div className="playOverlayInner">
              <div className="playIcon">▶</div>
              <div style={{fontWeight:800}}>Start</div>
              <div style={{opacity:.8,fontSize:12,marginTop:6}}>{note || 'Tippe, um Video zu starten'}</div>
            </div>
          </div>
        )}

        {paused && (
          <div className="pauseOverlay">
            <div className="pauseOverlayInner">PAUSE</div>
          </div>
        )}
      </div>
      <div className="muted" style={{marginTop:10, display:'flex', justifyContent:'space-between', gap:12, alignItems:'center'}}>
        <span>Keine Wiederholung • nur live</span>
        <button className="btn" onClick={()=>setMuted(m=>!m)} style={{padding:'8px 10px'}}>
          {muted ? 'Ton an' : 'Ton aus'}
        </button>
      </div>
    </div>
  )
}
