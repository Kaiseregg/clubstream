import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const app = express();
app.use(cors());

app.get('/', (_req, res) => res.status(200).send('stream-live signaling ok'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Protocol messages (JSON):
 * {type:'host-join', code}
 * {type:'viewer-join', code}
 * {type:'webrtc-offer', to, code, sdp}
 * {type:'webrtc-answer', to, code, sdp}
 * {type:'webrtc-ice', to, code, candidate}
 * {type:'host-stop', code}
 * {type:'match-update', code, match}
 */

const clients = new Map(); // ws -> {id}
const MAX_VIEWERS = Number(process.env.MAX_VIEWERS || 80);

// code -> {hostId: string|null, viewers: Set<string>, match: object|null, paused: boolean, pauseImageUrl: string|null}
const rooms = new Map();

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(2, 6);
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function findWsById(id) {
  for (const [ws, meta] of clients.entries()) {
    if (meta.id === id) return ws;
  }
  return null;
}

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { hostId: null, viewers: new Set(), match: null, paused: false, pauseImageUrl: null });
  return rooms.get(code);
}

function cleanupClient(id) {
  for (const [code, room] of rooms.entries()) {
    if (room.hostId === id) {
      // Host disconnected: keep the room so viewers can auto-reconnect when host joins again.
      room.hostId = null;
      for (const vid of room.viewers) {
        const vws = findWsById(vid);
        if (vws) safeSend(vws, { type: 'ended', code, reason: 'host-left', canReconnect: true });
      }
      // If nobody is watching, we can free the room.
      if (room.viewers.size === 0) rooms.delete(code);
      continue;
    }
    if (room.viewers.has(id)) {
      room.viewers.delete(id);
      const hws = room.hostId ? findWsById(room.hostId) : null;
      if (hws) safeSend(hws, { type: 'viewer-left', code, viewerId: id });
      if (!room.hostId && room.viewers.size === 0) rooms.delete(code);
    }
  }
}

wss.on('connection', (ws) => {
  const id = uid();
  clients.set(ws, { id });
  safeSend(ws, { type: 'hello', id });

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return safeSend(ws, { type: 'error', message: 'invalid-json' });
    }

    const meta = clients.get(ws);
    if (!meta) return;

    const type = msg?.type;
    const code = String(msg?.code || '').trim();

    if (type === 'host-join') {
      if (!code) return safeSend(ws, { type: 'error', message: 'missing-code' });
      const room = getRoom(code);
      if (room.hostId && room.hostId !== meta.id) {
        return safeSend(ws, { type: 'error', message: 'host-exists', code });
      }
      room.hostId = meta.id;
      safeSend(ws, { type: 'host-joined', code });
      for (const vid of room.viewers) safeSend(ws, { type: 'viewer-joined', code, viewerId: vid });

      // notify viewers that host is available again (auto-reconnect)
      for (const vid of room.viewers) {
        const vws = findWsById(vid);
        if (vws) {
          safeSend(vws, { type: 'host-available', code });
          if (room.match) safeSend(vws, { type: 'match-state', code, match: room.match, paused: room.paused, pauseImageUrl: room.pauseImageUrl });
          safeSend(vws, { type: 'pause-state', code, paused: room.paused, pauseImageUrl: room.pauseImageUrl });
        }
      }
      return;
    }

    if (type === 'viewer-join') {
      if (!code) return safeSend(ws, { type: 'error', message: 'missing-code' });
      const room = getRoom(code);
      if (!room.viewers.has(meta.id) && room.viewers.size >= MAX_VIEWERS) {
        return safeSend(ws, { type: 'viewer-denied', code, reason: 'viewer-limit', max: MAX_VIEWERS });
      }
      room.viewers.add(meta.id);
      safeSend(ws, { type: 'viewer-joined-ok', code, viewerId: meta.id, hostPresent: !!room.hostId });
      if (room.match) safeSend(ws, { type: 'match-state', code, match: room.match, paused: room.paused, pauseImageUrl: room.pauseImageUrl });
      safeSend(ws, { type: 'pause-state', code, paused: room.paused, pauseImageUrl: room.pauseImageUrl });
      const hws = room.hostId ? findWsById(room.hostId) : null;
      if (hws) safeSend(hws, { type: 'viewer-joined', code, viewerId: meta.id });
      return;
    }

    if (type === 'host-stop') {
      if (!code) return;
      const room = rooms.get(code);
      if (!room || room.hostId !== meta.id) return;
      // Host explicitly stopped streaming: keep room for restart.
      room.hostId = null;
      for (const vid of room.viewers) {
        const vws = findWsById(vid);
        if (vws) safeSend(vws, { type: 'ended', code, reason: 'host-stopped', canReconnect: true });
      }
      if (room.viewers.size === 0) rooms.delete(code);
      return;
    }

    if (type === 'pause-set') {
      if (!code) return safeSend(ws, { type: 'error', message: 'missing-code' });
      const room = rooms.get(code);
      if (!room || room.hostId !== meta.id) return safeSend(ws, { type: 'error', message: 'not-host', code });
      room.paused = !!msg?.paused;
      if (typeof msg?.pauseImageUrl === 'string') {
        room.pauseImageUrl = msg.pauseImageUrl || null;
      }
      for (const vid of room.viewers) {
        const vws = findWsById(vid);
        if (vws) safeSend(vws, { type: 'pause-state', code, paused: room.paused, pauseImageUrl: room.pauseImageUrl });
        if (room.match && vws) safeSend(vws, { type: 'match-state', code, match: room.match, paused: room.paused, pauseImageUrl: room.pauseImageUrl });
      }
      return;
    }


    if (type === 'match-update') {
      if (!code) return safeSend(ws, { type: 'error', message: 'missing-code' });
      const room = rooms.get(code);
      if (!room || room.hostId !== meta.id) return safeSend(ws, { type: 'error', message: 'not-host', code });
      room.match = msg?.match || null;
      for (const vid of room.viewers) {
        const vws = findWsById(vid);
        if (vws) safeSend(vws, { type: 'match-state', code, match: room.match, paused: room.paused, pauseImageUrl: room.pauseImageUrl });
      }
      return;
    }

    if (type === 'webrtc-offer' || type === 'webrtc-answer' || type === 'webrtc-ice') {
      const to = String(msg?.to || '').trim();
      if (!to) return;
      const target = findWsById(to);
      if (!target) return safeSend(ws, { type: 'error', message: 'peer-not-found', to });
      safeSend(target, { ...msg, from: meta.id });
      return;
    }

    safeSend(ws, { type: 'error', message: 'unknown-type' });
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    if (meta) cleanupClient(meta.id);
    clients.delete(ws);
  });
});

const PORT = process.env.PORT || 8787;
server.listen(PORT, () => console.log(`[signaling] listening on :${PORT}`));
