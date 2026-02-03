export function getSignalingUrl() {
  // Accept ws/wss or http/https (auto-convert). Auto-upgrade to wss when this page is https
  // to avoid mixed-content blocking on Netlify.
  const raw = (import.meta.env.VITE_SIGNALING_URL || "ws://127.0.0.1:8787").trim();
  let url = raw;

  if (/^https?:\/\//i.test(url)) {
    url = url.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  }

  // If user configured ws:// on a https page, upgrade for non-localhost.
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

function ensureWsPath(url, wantWsPath = true) {
  // wantWsPath=true -> ensure /ws suffix
  // wantWsPath=false -> ensure NO /ws suffix
  const u = new URL(url);

  // normalize trailing slash
  const p = u.pathname.replace(/\/+$/, "");
  const hasWs = p === "/ws";

  if (wantWsPath) {
    if (!hasWs) u.pathname = (p && p !== "/" ? p : "") + "/ws";
  } else {
    if (hasWs) u.pathname = "/";
  }

  // clear any fragment; keep query
  u.hash = "";
  return u.toString();
}

// Connect with a tiny send-queue + auto-reconnect.
// Mobile 4G/5G can drop WebSockets briefly; reconnecting keeps stream stable.
export function connectSignaling(onMessage, onStatus) {
  const baseUrl = getSignalingUrl();
  let ws = null;
  let closed = false;
  const queue = [];
  let retry = 0;
  let pingTimer = null;

  // Some hosting setups accept WS at root (/) even if you *think* it is /ws.
  // We try /ws first, then fall back to root once, then keep using the working one.
  let preferWsPath = true;      // start with /ws
  let triedFallback = false;    // only flip once per session

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
    const delay = Math.min(6000, 500 + retry * 500);
    setTimeout(() => {
      if (!closed) open();
    }, delay);
  }

  function open() {
    stopPing();
    try { ws?.close(); } catch {}

    const targetUrl = ensureWsPath(baseUrl, preferWsPath);

    // optimistic status: connecting (don't show "ok" until onopen)
    notify({ ok: false, connecting: true, url: targetUrl });

    let opened = false;

    ws = new WebSocket(targetUrl);

    ws.onopen = () => {
      opened = true;
      retry = 0;
      triedFallback = false; // reset once we have a good connection
      notify({ ok: true, url: targetUrl });
      startPing();
      // flush queue
      while (queue.length) {
        try { ws.send(queue.shift()); } catch { break; }
      }
    };

    ws.onerror = () => {
      // We'll handle fallback/reconnect in onclose (more reliable signal).
    };

    ws.onclose = (ev) => {
      stopPing();
      if (closed) return;

      // If we never opened, try fallback once (switch /ws <-> /).
      if (!opened && !triedFallback) {
        triedFallback = true;
        preferWsPath = !preferWsPath;
        const alt = ensureWsPath(baseUrl, preferWsPath);
        notify({ ok: false, url: targetUrl, error: `ws failed, trying ${alt}` });
        open();
        return;
      }

      notify({ ok: false, url: targetUrl, error: `ws closed (${ev.code || 0})` });
      scheduleReconnect();
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
    baseUrl,
    close: () => {
      closed = true;
      stopPing();
      try { ws?.close(); } catch {}
    }
  };
}
