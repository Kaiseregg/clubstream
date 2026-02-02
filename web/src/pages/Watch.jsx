import React, { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { connectSignaling } from '../lib/signaling.js'
import { getIceConfig } from '../lib/ice.js'
import pauseDefault from '../assets/pause.png'

export default function Watch(){
  const { code } = useParams()
  const [sigOk, setSigOk] = useState(false)
  const [note, setNote] = useState('')
  const [match, setMatch] = useState(null)
  const [paused, setPaused] = useState(false)
  const [pausePoster, setPausePoster] = useState(null)

  // audio: always start muted; unmute only by user click
  const [muted, setMuted] = useState(true)
  const prevMutedRef = useRef(true)

  const [theater, setTheater] = useState(false)
  const [playReady, setPlayReady] = useState(false) // true once video.play() succeeded at least once
  const [started, setStarted] = useState(false)     // user clicked start

  const videoRef = useRef(null)
  const sigRef = useRef(null)
  const pcRef = useRef(null)
  const remoteStreamRef = useRef(new MediaStream())
  const hostIdRef = useRef(null)

  const reconnectingRef = useRef(false)
  const discTimerRef = useRef(null)

  function cleanupPc(){
    try{ if (discTimerRef.current) { clearTimeout(discTimerRef.current); discTimerRef.current = null } }catch{}
    try{
      const pc = pcRef.current
      if(pc){
        pc.ontrack = null
        pc.onicecandidate = null
        pc.oniceconnectionstatechange = null
        pc.onconnectionstatechange = null
        try{ pc.close() }catch{}
      }
    }catch{}
    pcRef.current = null
    remoteStreamRef.current = new MediaStream()
    try{ if(videoRef.current) videoRef.current.srcObject = null }catch{}
    setPlayReady(false)
  }

  // Pause handling: force mute during pause, restore previous choice after resume
  useEffect(()=>{
    const v = videoRef.current
    if(!v) return
    if(paused){
      prevMutedRef.current = muted
      v.muted = true
      setMuted(true)
    }else{
      const prev = !!prevMutedRef.current
      v.muted = prev
      setMuted(prev)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[paused])

  async function startPlayback(){
    setStarted(true)
    const v = videoRef.current
    if(!v) return
    // first play must be muted for reliable autoplay on mobile
    v.muted = true
    setMuted(true)
    try{
      await v.play?.()
      setPlayReady(true)
      setNote('')
    }catch{
      setPlayReady(false)
      setNote('Tippe auf Start, um abzuspielen.')
    }
  }

  function requestTheater(){
    setTheater(true)
    document.body.style.overflow = 'hidden'
    // user gesture already happened (button click)
    try{ videoRef.current?.play?.() }catch{}
  }
  function closeTheater(){
    setTheater(false)
    document.body.style.overflow = ''
    setTimeout(()=>{ try{ document.querySelector('.video')?.scrollIntoView({ block:'center' }) }catch{} }, 50)
  }

  useEffect(()=>{
    const prevOverflow = document.body.style.overflow
    if(theater) document.body.style.overflow = 'hidden'
    const onKey = (e)=>{ if(e.key === 'Escape') closeTheater() }
    if(theater) window.addEventListener('keydown', onKey)
    return ()=>{
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  },[theater])

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
      if(typeof msg.pauseImageUrl === 'string') setPausePoster(msg.pauseImageUrl || null)
    }
    if (msg.type === 'pause-state'){
      setPaused(!!msg.paused)
      if(typeof msg.pauseImageUrl === 'string') setPausePoster(msg.pauseImageUrl || null)
    }
    if (msg.type === 'viewer-denied'){
      setNote(`Zuschauerlimit erreicht (max. ${msg.max || 80}).`)
    }
    if (msg.type === 'host-available'){
      setNote('Stream wird wieder verbunden…')
      hardReconnect('host-available')
    }
    if (msg.type === 'ended'){
      setNote(msg?.canReconnect ? 'Stream unterbrochen – warte auf Restart…' : 'Stream beendet.')
      cleanupPc()
    }
  }

  useEffect(()=>{
    const sig = connectSignaling(onSigMsg, (s)=>setSigOk(!!s.ok))
    sigRef.current = sig
    sig.send({ type:'viewer-join', code })
    return ()=>{
      try{ sig.close?.() ?? sig.ws.close() }catch{}
      cleanupPc()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  function hardReconnect(_reason){
    if(reconnectingRef.current) return
    reconnectingRef.current = true
    setNote('Stream wird wieder verbunden…')
    cleanupPc()
    try{ sigRef.current?.send({ type:'viewer-join', code }) }catch{}
    setTimeout(()=>{ reconnectingRef.current = false }, 1200)
  }

  async function acceptOffer(sdp, hostId){
    const sig = sigRef.current
    if (!sig) return
    hostIdRef.current = hostId

    // Always hard reset before applying a new offer (fixes black screen after host restart)
    cleanupPc()
    setNote('Verbinde...')

    const ice = await getIceConfig()

    const forceRelay = (()=>{
      const ua = navigator.userAgent || ''
      const mobile = /iPad|iPhone|iPod|Android/i.test(ua)
      const conn = navigator.connection
      const cellular = String(conn?.type||'').toLowerCase()==='cellular'
      return mobile || cellular
    })()

    const pc = new RTCPeerConnection({ ...ice, iceTransportPolicy: forceRelay ? 'relay' : 'all' })
    pcRef.current = pc

    pc.ontrack = (ev)=>{
      const v = videoRef.current
      if(!v) return
      const stream = remoteStreamRef.current
      const src = ev.streams?.[0]
      if(src && src.getTracks){
        src.getTracks().forEach(t=>{
          try{ if(!stream.getTracks().some(x=>x.id===t.id)) stream.addTrack(t) }catch{}
        })
      }else if(ev.track){
        try{ if(!stream.getTracks().some(x=>x.id===ev.track.id)) stream.addTrack(ev.track) }catch{}
      }

      if(v.srcObject !== stream) v.srcObject = stream

      // only attempt play after the user clicked Start at least once
      if(started){
        const p = v.play?.()
        if(p && typeof p.then === 'function'){
          p.then(()=>{ setPlayReady(true); setNote('') }).catch(()=>{ setPlayReady(false) })
        }else{
          setPlayReady(true); setNote('')
        }
      }
    }

    pc.onicecandidate = (ev)=>{
      if (ev.candidate) sig.send({ type:'webrtc-ice', code, to: hostId, candidate: ev.candidate })
    }

    pc.oniceconnectionstatechange = ()=>{
      const st = pc.iceConnectionState
      if(st === 'checking') setNote('Verbinde...')
      if(st === 'connected') {
        setNote('')
        if(discTimerRef.current){ clearTimeout(discTimerRef.current); discTimerRef.current = null }
      }
      if(st === 'disconnected'){
        if(discTimerRef.current) clearTimeout(discTimerRef.current)
        discTimerRef.current = setTimeout(()=>{
          try{ if(pcRef.current?.iceConnectionState === 'disconnected') hardReconnect('ice-disconnected') }catch{}
        }, 1500)
      }
      if(st === 'failed') hardReconnect('ice-failed')
    }

    pc.onconnectionstatechange = ()=>{
      const st = pc.connectionState
      if(st === 'connecting') setNote('Verbinde...')
      if(st === 'failed') hardReconnect('pc-failed')
    }

    await pc.setRemoteDescription(sdp)
    const ans = await pc.createAnswer()
    await pc.setLocalDescription(ans)
    sig.send({ type:'webrtc-answer', code, to: hostId, sdp: pc.localDescription })
  }

  async function handleStart(){
    await startPlayback()
    requestTheater()
  }

  async function toggleMute(){
    const v = videoRef.current
    const next = !muted
    setMuted(next)
    prevMutedRef.current = next
    if(v) v.muted = next
    if(v && !next){
      try{ await v.play?.(); setPlayReady(true); setNote('') }catch{}
    }
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

      <div className={'video' + (theater ? ' theaterOn' : '')} style={{position:'relative'}}>
        <div style={{position:'absolute',top:10,right:10,display:'flex',gap:8,zIndex:6}}>
          {theater && (
            <button className="theaterClose" onClick={closeTheater} aria-label="Theater schliessen">×</button>
          )}
          <button className="fsBtn" onClick={handleStart} aria-label="Theater">
            ⤢
          </button>
        </div>

        {match ? (
          <>
            <div className="overlayLeft">
              <div className="overlaySport">{match.sport || 'Sport'}</div>
              <div className="overlayTeams">{(match.teamA||'Team A')} vs {(match.teamB||'Team B')}</div>
            </div>
            <div className="overlayScore">
              {match.periodsTotal ? (
                <div className="overlayPeriod">{Number(match.period||1)}/{Number(match.periodsTotal)}</div>
              ) : null}
              <div className="overlayScoreNum">{Number(match.scoreA||0)} : {Number(match.scoreB||0)}</div>
            </div>
          </>
        ) : null}

        <video
          ref={videoRef}
          className="videoEl"
          autoPlay
          playsInline
          controls={false}
          muted={muted}
          onClick={theater ? undefined : handleStart}
          style={{ width:'100%', height:'100%', background:'#000' }}
        />

        {(!started || !playReady || note) && (
          <div className="playOverlay" onClick={handleStart}>
            <div className="playOverlayInner">
              <div className="playIcon">▶</div>
              <div style={{fontWeight:800}}>Start</div>
              <div style={{opacity:.8,fontSize:12,marginTop:6}}>
                {note || 'Tippe, um Video zu starten'}
              </div>
            </div>
          </div>
        )}

        {paused && (
          <div className="pauseOverlayImg">
            <img
              src={pausePoster || pauseDefault}
              alt="Pause"
              style={{width:'100%',height:'100%',objectFit:'contain'}}
            />
          </div>
        )}
      </div>

      <div className="muted" style={{marginTop:10, display:'flex', justifyContent:'space-between', gap:12, alignItems:'center'}}>
        <span>Keine Wiederholung • nur live</span>
        <button className="btn" onClick={toggleMute} style={{padding:'8px 10px'}}>
          {muted ? 'Ton an' : 'Ton aus'}
        </button>
      </div>
    </div>
  )
}
