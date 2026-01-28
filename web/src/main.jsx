import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './styles.css'

// Note: React.StrictMode double-invokes effects in dev, which can cause WebSocket/WebRTC to
// connect+close during startup and confuse debugging. Keep it simple for this project.
ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)
