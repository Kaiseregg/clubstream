import React from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import Home from './pages/Home.jsx'
import Watch from './pages/Watch.jsx'
import AdminGate from './pages/AdminGate.jsx'
import AdminLogin from './pages/AdminLogin.jsx'
import AdminRequest from './pages/AdminRequest.jsx'
import SetPassword from './pages/SetPassword.jsx'

export default function App(){
  return (
    <div className="wrap">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:10,height:10,borderRadius:999,background:'#7aa7ff'}} />
            <strong>Stream Live</strong>
          </div>
          <div className="muted">Live Sport • ohne Replay</div>
        </div>
        <div style={{display:'flex',gap:10}}>
          <Link className="btn" to="/">Zuschauer</Link>
          <Link className="btn" to="/admin">Admin</Link>
        </div>
      </div>

      <Routes>
        <Route path="/" element={<Home/>} />
        <Route path="/watch/:code" element={<Watch/>} />
        <Route path="/admin" element={<AdminGate/>} />
        <Route path="/admin/login" element={<AdminLogin/>} />
        <Route path="/admin/request" element={<AdminRequest/>} />
        <Route path="/set-password" element={<SetPassword/>} />
        <Route path="*" element={<Home/>} />
      </Routes>
    </div>
  )
}
