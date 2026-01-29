import React, { useEffect, useMemo, useRef, useState } from 'react'
import { connectSignaling } from '../lib/signaling.js'
import { supabase } from '../lib/supabase.js'

function mkCode(){
  const a = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4)
  const b = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4)
  return `${a}-${b}`
}

function getIceServers(){
  try {
    const raw = import.meta.env.VITE_ICE_SERVERS_JSON
    if (raw) return JSON.parse(raw)
  } catch {}
  return [{ urls: ['stun:stun.l.google.com:19302'] }]
}

export default function Admin(){
  const [code, setCode] = useState(mkCode())
  const [sigOk, setSigOk] = useState(false)
  const [status, setStatus] = useState('idle') // idle | live
  const [err, setErr] = useState('')
  const [facingMode, setFacingMode] = useState('environment')

  // Match / Score state (synced to viewers)
  const sports = ['Unihockey','Fussball','Eishockey','Basketball','Volleyball','Handball','Tennis','Sonstiges']
  const [sport, setSport] = useState(sports[0])
  const [teamA, setTeamA] = useState('Team A')
  const [teamB, setTeamB] = useState('Team B')
  const [scoreA, setScoreA] = useState(0)
  const [scoreB, setScoreB] = useState(0)

  function sendMatch(next){
    const sig = sigRef.current
    if (!sig) return
    const match = next || { sport, teamA, teamB, scoreA, scoreB }
    sig.send({ type:'match-update', code, match })
  }

  const localVideoRef = useRef(null)
  const streamRef = useRef(null)
  const sigRef = useRef(null)
  const pcsRef = useRef(new Map()) // viewerId -> RTCPeerConnection
  const iceServers = useMemo(()=>({ iceServers: getIceServers() }), [])

  useEffect(()=>{
    const sig = connectSignaling(onSigMsg, (s)=>setSigOk(!!s.ok))
    sigRef.current = sig
    return ()=>{ try{ sig.close?.() ?? sig.ws.close() }catch{} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function ensureMedia(force=false, preferredFacing=null){
    if (streamRef.current && !force) return streamRef.current
    try{ streamRef.current?.getTracks?.().forEach(t=>t.stop()) }catch{}
    const fm = preferredFacing || facingMode
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: fm },
      audio: true
    })
    streamRef.current = s
    if (localVideoRef.current) localVideoRef.current.srcObject = s

    // If already streaming to viewers, swap tracks without breaking the connection.
    try{
      const vTrack = s.getVideoTracks?.()[0]
      const aTrack = s.getAudioTracks?.()[0]
      pcsRef.current.forEach((pc)=>{
        pc.getSenders?.().forEach(sender=>{
          if (sender?.track?.kind === 'video' && vTrack) sender.replaceTrack(vTrack)
          if (sender?.track?.kind === 'audio' && aTrack) sender.replaceTrack(aTrack)
        })
      })
    }catch{}

    return s
  }

  function onSigMsg(msg){
    if (msg.type === 'viewer-joined'){
      createOfferForViewer(msg.viewerId).catch(e=>setErr(String(e?.message||e)))
    }
    if (msg.type === 'webrtc-answer'){
      const pc = pcsRef.current.get(msg.from)
      if (pc && msg.sdp) pc.setRemoteDescription(msg.sdp).catch(()=>{})
    }
    if (msg.type === 'webrtc-ice'){
      const pc = pcsRef.current.get(msg.from)
      if (pc && msg.candidate) pc.addIceCandidate(msg.candidate).catch(()=>{})
    }
    if (msg.type === 'viewer-left'){
      const pc = pcsRef.current.get(msg.viewerId)
      if (pc){ try{ pc.close() }catch{} pcsRef.current.delete(msg.viewerId) }
    }
  }

  async function start(){
    setErr('')
    await ensureMedia()
    setStatus('live')
    sigRef.current?.send({ type:'host-join', code })
    sendMatch()
  }

  function stop(){
    setStatus('idle')
    sigRef.current?.send({ type:'host-stop', code })
    for (const pc of pcsRef.current.values()) { try{ pc.close() }catch{} }
    pcsRef.current.clear()
  }

  async function createOfferForViewer(viewerId){
    const sig = sigRef.current
    if (!sig) return
    const local = await ensureMedia()

    const pc = new RTCPeerConnection(iceServers)
    pcsRef.current.set(viewerId, pc)

    local.getTracks().forEach(t=>pc.addTrack(t, local))

    pc.onicecandidate = (ev)=>{
      if (ev.candidate) sig.send({ type:'webrtc-ice', code, to: viewerId, candidate: ev.candidate })
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    sig.send({ type:'webrtc-offer', code, to: viewerId, sdp: pc.localDescription })
  }

  
  async function switchCamera(){
    const next = (facingMode === 'user') ? 'environment' : 'user'
    setFacingMode(next)
    try{
      await ensureMedia(true, next)
    }catch(e){
      setErr(String(e?.message||e))
    }
  }

  async function logout(){
    try{ await supabase?.auth?.signOut?.() }catch{}
    window.location.href = '/admin/login'
  }

const watchUrl = `${location.origin}/watch/${encodeURIComponent(code)}`

  return (
    <div className="row">
      <div className="col">
        <div className="card">
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
            <h2 className="h">Admin • Live Stream</h2>
            <div style={{display:'flex',gap:10,alignItems:'center'}}>
              <span className="badge">Signaling: {sigOk ? 'ok' : 'offline'}</span>
              <button className="btn" onClick={logout} style={{padding:'8px 10px'}}>Abmelden</button>
            </div>
          </div>

          <div className="muted">Code</div>
          <input className="input" value={code} onChange={e=>setCode(e.target.value.toUpperCase())} />
          <div style={{height:10}}/>
          <div className="muted">Link</div>
          <div style={{display:'flex',gap:10}}>
            <input className="input" readOnly value={watchUrl} />
            <button className="btn" onClick={()=>navigator.clipboard?.writeText(watchUrl)}>Kopieren</button>
          </div>

          
          <div style={{height:14}}/>
          <div className="card" style={{padding:12, background:'rgba(255,255,255,0.03)'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
              <div className="muted" style={{fontWeight:700}}>Match Setup</div>
              <button className="btn" onClick={()=>sendMatch()} disabled={status!=='live'} style={{padding:'8px 10px'}}>Übernehmen</button>
            </div>

            <div className="grid2">
              <div>
                <div className="muted">Sportart</div>
                <select className="input" value={sport} onChange={e=>setSport(e.target.value)}>
                  {sports.map(s=>(<option key={s} value={s}>{s}</option>))}
                </select>
              </div>
              <div>
                <div className="muted">Code</div>
                <input className="input" readOnly value={code} />
              </div>

              <div>
                <div className="muted">Team A</div>
                <input className="input" value={teamA} onChange={e=>setTeamA(e.target.value)} />
              </div>
              <div>
                <div className="muted">Team B</div>
                <input className="input" value={teamB} onChange={e=>setTeamB(e.target.value)} />
              </div>

              <div>
                <div className="muted">Score A</div>
                <div style={{display:'flex', gap:8, alignItems:'center'}}>
                  <button className="btn" style={{minWidth:44}} onClick={()=>{ const v=Math.max(0,scoreA-1); setScoreA(v); sendMatch({sport,teamA,teamB,scoreA:v,scoreB}); }} disabled={status!=='live'}>-</button>
                  <input className="input" value={scoreA} onChange={e=>{ const v=Math.max(0,parseInt(e.target.value||'0',10)||0); setScoreA(v); }} style={{textAlign:'center', width:90}} />
                  <button className="btn" style={{minWidth:44}} onClick={()=>{ const v=scoreA+1; setScoreA(v); sendMatch({sport,teamA,teamB,scoreA:v,scoreB}); }} disabled={status!=='live'}>+</button>
                </div>
              </div>

              <div>
                <div className="muted">Score B</div>
                <div style={{display:'flex', gap:8, alignItems:'center'}}>
                  <button className="btn" style={{minWidth:44}} onClick={()=>{ const v=Math.max(0,scoreB-1); setScoreB(v); sendMatch({sport,teamA,teamB,scoreA,scoreB:v}); }} disabled={status!=='live'}>-</button>
                  <input className="input" value={scoreB} onChange={e=>{ const v=Math.max(0,parseInt(e.target.value||'0',10)||0); setScoreB(v); }} style={{textAlign:'center', width:90}} />
                  <button className="btn" style={{minWidth:44}} onClick={()=>{ const v=scoreB+1; setScoreB(v); sendMatch({sport,teamA,teamB,scoreA,scoreB:v}); }} disabled={status!=='live'}>+</button>
                </div>
              </div>
            </div>

            <div className="muted" style={{marginTop:10}}>
              Tipp: Team/Score ändern → “Übernehmen” oder mit +/- wird sofort an Zuschauer gesendet.
            </div>
          </div>

<div style={{height:12}}/>
          <div style={{display:'flex',gap:10}}>
            <button className="btn" onClick={start} disabled={!sigOk || status==='live'}>Start</button>
            <button className="btn" onClick={stop} disabled={status!=='live'}>Stop</button>
            <span className="badge">Status: {status}</span>
          </div>

          {err ? <div style={{marginTop:10}} className="muted">⚠️ {err}</div> : null}

          <div style={{height:12}}/>
          <div className="video">
            <video ref={localVideoRef} autoPlay playsInline muted style={{width:'100%',height:'100%',objectFit:'cover'}} />
          </div>

          <div style={{height:10}} className="muted">
            Wenn das Video schwarz bleibt: Browser-Popup "Kamera erlauben" bestätigen.
          </div>
        </div>
      </div>
    </div>
  )
}
