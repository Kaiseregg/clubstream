export function getSignalingUrl() {
  // Default to 127.0.0.1 (not localhost) to avoid IPv6/::1 issues on some Windows setups.
  return (import.meta.env.VITE_SIGNALING_URL || 'ws://127.0.0.1:8787').trim();
}

// Connect with a tiny send-queue so messages sent before WS "open" are not lost.
// This fixes the common "viewer-join sent too early" issue that results in black video.
export function connectSignaling(onMessage, onStatus) {
  const url = getSignalingUrl();
  let ws;
  let closed = false;
  const queue = [];

  const notify = (s) => { try { onStatus?.(s); } catch {} };

  function open() {
    ws = new WebSocket(url);

    ws.onopen = () => {
      notify({ ok: true, url });
      // flush queue
      while (queue.length) {
        try { ws.send(queue.shift()); } catch { break; }
      }
    };

    ws.onclose = () => {
      notify({ ok: false, url });
      // no auto-reconnect for now (keep simple & predictable)
    };

    ws.onerror = () => {
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
    close: () => { closed = true; try { ws?.close(); } catch {} }
  };
}
