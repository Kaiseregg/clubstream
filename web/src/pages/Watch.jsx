import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { connectSignaling } from '../lib/signaling.js'

function getIceServers(){
  try {
    const raw = import.meta.env.VITE_ICE_SERVERS_JSON
    if (raw) return JSON.parse(raw)
  } catch {}
  return [{ urls: ['stun:stun.l.google.com:19302'] }]
}

export default function Watch(){
  const { code } = useParams()
  const [sigOk, setSigOk] = useState(false)
  const [note, setNote] = useState('')
  const [match, setMatch] = useState(null)
  const [muted, setMuted] = useState(true)
  const [theater, setTheater] = useState(false)
  const [started, setStarted] = useState(false)
  const [playing, setPlaying] = useState(false)
  const isIOS = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    return /iP(hone|ad|od)/.test(navigator.platform) || (navigator.userAgent.includes('Mac') && 'ontouchend' in document)
  }, [])
  const videoRef = useRef(null)
  const containerRef = useRef(null)
  const sigRef = useRef(null)
  const pcRef = useRef(null)
  const iceServers = useMemo(()=>({ iceServers: getIceServers() }), [])

  // iOS viewport height fix (100vh bug) + safe rotation
  useEffect(()=>{
    const setVh = ()=>{
      const h = window.innerHeight || document.documentElement.clientHeight
      document.documentElement.style.setProperty('--vh', `${h * 0.01}px`)
    }
    setVh()
    window.addEventListener('resize', setVh)
    window.addEventListener('orientationchange', setVh)
    return ()=>{
      window.removeEventListener('resize', setVh)
      window.removeEventListener('orientationchange', setVh)
    }
  }, [])

  // Fullscreen + Scroll-Lock
  useEffect(()=>{
    const video = videoRef.current
    const cont = containerRef.current

    const exitFs = () => {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen
      try{ exit?.call(document) }catch{}
    }

    if(!theater){
      // exit fullscreen + restore scroll
      exitFs()
      return
    }

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // request fullscreen (desktop/android) or iOS video fullscreen
    try{
      const req = cont?.requestFullscreen || cont?.webkitRequestFullscreen || cont?.msRequestFullscreen
      if(req) req.call(cont)
      else if(video?.webkitEnterFullscreen) video.webkitEnterFullscreen()
    }catch{}

    return ()=>{ document.body.style.overflow = prevOverflow }
  },[theater, isIOS])

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
    }
    if (msg.type === 'ended'){
      setNote('Stream beendet.')
      try{ pcRef.current?.close() }catch{}
      pcRef.current = null
    }
  }

  async function acceptOffer(sdp, hostId){
    const sig = sigRef.current
    if (!sig) return
    setNote('Verbinde...')

    const pc = new RTCPeerConnection(iceServers)
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
      const v = videoRef.current
      if (v && stream){
        v.srcObject = stream
        v.muted = muted
        v.playsInline = true
        v.setAttribute('playsinline','')
        v.setAttribute('webkit-playsinline','')

        const tryPlay = async ()=>{
          try{
            const p = v.play?.()
            if (p && typeof p.then === 'function') await p
            setNote('')
          }catch{
            setNote('Tippe ins Video, um abzuspielen (Autoplay blockiert).')
          }
        }

        v.onplaying = ()=>setPlaying(true)
        v.onpause = ()=>setPlaying(false)
        v.onloadedmetadata = ()=>{ tryPlay() }
        tryPlay()
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

  
  async function ensurePlay(userGesture=false){
    const v = videoRef.current
    if (!v) return
    try{
      // ensure attributes for iOS
      v.playsInline = true
      v.setAttribute('playsinline','')
      v.setAttribute('webkit-playsinline','')
      if (userGesture) setMuted(false)
      v.muted = userGesture ? false : muted
      const p = v.play?.()
      if (p && typeof p.then === 'function') await p
      setStarted(true)
    }catch{
      // ignore; user might need to tap
    }
  }

  async function handleVideoClick(){
    // user gesture: start playback + enter theater
    await ensurePlay(true)
    setTheater(true)
  }

  async function handleFsButton(e){
    e?.preventDefault?.()
    e?.stopPropagation?.()
    await ensurePlay(true)
    setTheater(true)
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

        {theater && (
          <button className="theaterClose" onClick={()=>setTheater(false)}>×</button>
        )}

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
            <div style={{fontWeight:900,fontSize:18,flexShrink:0}}>
              {Number(match.scoreA||0)} : {Number(match.scoreB||0)}
            </div>
          </div>
        ) : null}

        {/* overlay removed; match is shown above the video for better readability */}


        {/* Play overlay (iOS often needs a user gesture) */}
        {(!playing) && (
          <button className="playOverlay" onClick={handleVideoClick}>
            {started ? 'Weiter' : '▶ Start'}
          </button>
        )}

        <button className="fsBtn" onClick={handleFsButton} title="Vollbild">⤢</button>

        <video
          ref={videoRef}
          className="videoEl"
          autoPlay
          playsInline
          controls={false}
          muted={muted}
          onClick={handleVideoClick}
          style={{
            width:'100%',
            height:'100%',
            background:'#000',
            objectFit: theater ? 'contain' : 'cover'
          }} />
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
