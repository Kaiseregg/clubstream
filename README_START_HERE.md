# stream_live_v0.2_clean (LOCAL)

## 1) Signaling Server starten (Terminal 1)
```bash
cd signaling
npm install
npm start
```
Erwartet: `[signaling] listening on :8787`

Test: http://127.0.0.1:8787/health -> {"ok":true}

## 2) Web App starten (Terminal 2)
```bash
cd web
npm install
npm run dev
```
Öffne: http://localhost:5173

## 3) Test
- Admin: http://localhost:5173/admin
  - Klick "Start"
  - Code wird angezeigt (z.B. ABCD-1234)
- Zuschauer: http://localhost:5173/watch/ABCD-1234
  - Sollte nach 1-5s das Live-Bild zeigen

### Wenn Zuschauer "schwarz" bleibt
- Viele Browser blockieren **Autoplay mit Ton**.
- Lösung: im Zuschauer-Tab **ins Video klicken** oder Button **"Ton an"** drücken.

## Hinweis
- Lokal funktioniert es ohne TURN meistens sofort.
- Für Mobile-Netze später TURN ergänzen (ICE-Servers JSON).
