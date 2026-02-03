export function getSignalingUrl() {
  // Default to 127.0.0.1 (not localhost) to avoid IPv6/::1 issues on some Windows setups.
  return (import.meta.env.VITE_SIGNALING_URL || "ws://127.0.0.1:8787").trim();
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
    ws = new WebSocket(url);

    ws.onopen = () => {
      retry = 0;
      notify({ ok: true, url });
      startPing();
      // flush queue
      while (queue.length) {
        try { ws.send(queue.shift()); } catch { break; }
      }
    };

    ws.onclose = () => {
      stopPing();
      notify({ ok: false, url });
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow; just notify once.
      notify({ ok: false, url, error: true });
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
    url,
    close: () => {
      closed = true;
      stopPing();
      try { ws?.close(); } catch {}
    }
  };
}
