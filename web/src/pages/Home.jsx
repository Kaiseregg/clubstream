import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function Home(){
  const [code, setCode] = useState('')
  const nav = useNavigate()

  function open(){
    const c = code.trim()
    if(!c) return
    nav('/watch/' + encodeURIComponent(c))
  }

  return (
    <div className="row">
      <div className="col">
        <div className="card">
          <h2 className="h">Zuschauer</h2>
          <div className="muted">Gib den Spiel-Code ein (z.B. ABCD-1234) oder öffne den Link.</div>
          <div style={{height:10}}/>
          <div className="muted">Spiel-Code</div>
          <input className="input" value={code} onChange={e=>setCode(e.target.value)} placeholder="z.B. SPIEL1" />
          <div style={{height:10}}/>
          <button className="btn" onClick={open}>Live öffnen</button>
        </div>
      </div>
    </div>
  )
}
