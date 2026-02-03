export function getSignalingUrl() {
  // Accept ws/wss or http/https (auto-convert). Auto-upgrade to wss when this page is https
  // to avoid mixed-content blocking on Netlify.
  const raw = (import.meta.env.VITE_SIGNALING_URL || "ws://127.0.0.1:8787").trim();
  let url = raw;
  if (/^https?:\/\//i.test(url)) {
    url = url.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  }
  // If user accidentally configured ws:// on a https page, upgrade for non-localhost.
  try {
    const u = new URL(url);
    const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (!isLocal && window.location.protocol === "https:" && u.protocol === "ws:") {
      u.protocol = "wss:";
      url = u.toString();
    }
  } catch {
    // leave as-is
  }
  return url;
}

function normalizeUrl(raw) {
  // Ensure we connect to the websocket endpoint (/ws) even if env only contains the host.
  // Keeps query params intact.
  const s = String(raw || "").trim();
  if (!s) return s;

  try {
    const u = new URL(s);
    // If already points to /ws or any explicit path, keep it.
    const path = (u.pathname || "").replace(/\/+$/, "");
    if (path === "" || path === "/") {
      u.pathname = "/ws";
    }
    return u.toString();
  } catch {
    // Fallback: append /ws if it looks like a host-only url
    if (/^wss?:\/\//i.test(s) && !/\/ws(\?|#|$)/i.test(s) && !/\/[^/?#]+/i.test(s.replace(/^wss?:\/\//i,""))) {
      return s.replace(/\/+$/, "") + "/ws";
    }
    return s;
  }
}

// Connect with a tiny send-queue + auto-reconnect.
// Mobile 4G/5G can drop WebSockets briefly; reconnecting keeps stream stable.
export function connectSignaling(onMessage, onStatus) {
  const url = getSignalingUrl();
  let ws = null;
  let closed = false;
  const queue = [];
  let retry = 0;
  let pingTimer = null;

  const notify = (s) => { try { onStatus?.(s); } catch {} };

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function startPing() {
    stopPing();
    // Keep the WS alive on some mobile networks / proxies.
    pingTimer = setInterval(() => {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      } catch {}
    }, 25000);
  }

  function scheduleReconnect() {
    if (closed) return;
    retry = Math.min(retry + 1, 8);
    const delay = Math.min(5000, 400 + retry * 400);
    setTimeout(() => {
      if (!closed) open();
    }, delay);
  }

  function open() {
    stopPing();
    try { ws?.close(); } catch {}
    ws = new WebSocket(normalizeUrl(url));

    ws.onopen = () => {
      retry = 0;
      notify({ ok: true, url: normalizeUrl(url) });
      startPing();
      // flush queue
      while (queue.length) {
        try { ws.send(queue.shift()); } catch { break; }
      }
    };

    ws.onclose = () => {
      stopPing();
      notify({ ok: false, url: normalizeUrl(url) });
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow; just notify once.
      notify({ ok: false, url: normalizeUrl(url), error: true });
    };

    ws.onmessage = (ev) => {
      try { onMessage?.(JSON.parse(ev.data)); } catch {}
    };
  }

  open();

  function send(obj) {
    const payload = JSON.stringify(obj);
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      } else if (!closed) {
        queue.push(payload);
      }
    } catch {
      if (!closed) queue.push(payload);
    }
  }

  return {
    get ws() { return ws; },
    send,
    url: normalizeUrl(url),
    close: () => {
      closed = true;
      stopPing();
      try { ws?.close(); } catch {}
    }
  };
}
