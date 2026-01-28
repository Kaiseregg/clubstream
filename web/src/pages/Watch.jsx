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
  const [note, setNote] = useState('Warte auf Stream...')
  const [match, setMatch] = useState(null)
  const [muted, setMuted] = useState(true)
  const videoRef = useRef(null)
  const pcRef = useRef(null)
  const sigRef = useRef(null)
  const iceServers = useMemo(()=>({ iceServers: getIceServers() }), [])

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
      if (videoRef.current && stream){
        videoRef.current.srcObject = stream
        // Autoplay with audio is often blocked by browsers.
        // We start muted and try to play; user can unmute.
        videoRef.current.muted = muted
        const p = videoRef.current.play?.()
        if (p && typeof p.then === 'function') {
          p.then(()=>setNote('')).catch(()=>setNote('Tippe ins Video, um abzuspielen (Autoplay blockiert).'))
        } else {
          setNote('')
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

  return (
    <div className="card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
        <h2 className="h">Live</h2>
        <span className="badge">Code: {code}</span>
      </div>
      <div className="muted" style={{marginBottom:10}}>
        Signaling: {sigOk ? 'ok' : 'offline'} • <Link to="/">← Zurück</Link>
      </div>

      {match ? (
        <div className="matchbar">
          <div className="meta">
            <div className="sport">{match.sport || 'Sport'}</div>
            <div className="teams">{(match.teamA||'Team A')} vs {(match.teamB||'Team B')}</div>
          </div>
          <div className="score">{Number(match.scoreA||0)} : {Number(match.scoreB||0)}</div>
        </div>
      ) : null}

      <div className="video" style={{position:'relative'}}>
        {/* overlay removed; match is shown above the video for better readability */}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          controls={false}
          muted={muted}
          onClick={()=>setMuted(false)}
          style={{width:'100%',height:'100%',objectFit:'cover'}} />
        {note ? (
          <div style={{
            position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',
            color:'#e6eefc',fontWeight:700,textShadow:'0 2px 18px rgba(0,0,0,.6)'
          }}>{note}</div>
        ) : null}
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
