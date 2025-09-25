# Pump.fun Boss Fight Overlay (local)

## What this does
- Connects to a chat websocket (Pump.fun or other) and listens for trigger keywords ("■■" or "HIT" by default).
- Each trigger reduces boss HP (default initial HP is 10,000).
- Real-time overlay served at `/overlay.html` for OBS BrowserSource.
- Exports JSON and CSV results at the end of the fight to ./exports/.

## Install
1. Node.js 18+ (or fairly recent LTS).
2. In project root:
   npm install

## Config (env)
- PUMP_CHAT_WS_URL: websocket URL for chat (e.g. wss://example) **REQUIRED** to connect to live chat.
- TRIGGER_KEYWORDS: comma-separated triggers (e.g. "■■,HIT")
- HEAL_KEYWORDS: optional (e.g. "❤■")
- INITIAL_HP: number (default 10000)
- PORT: server port (default 3000)
- EXPORT_DIR: where result JSON/CSV are saved

Example (mac / linux):
PUMP_CHAT_WS_URL="wss://pumpportal.fun/api/data" INITIAL_HP=10000 TRIGGER_KEYWORDS="■■,HIT" npm start

## OBS integration
1. Open OBS.
2. Add a new BrowserSource.
3. Put the URL `http://localhost:3000/overlay.html`.
4. Set resolution to 960x540 (match the overlay container) or desired size.
5. Click OK.

## How to adapt to Pump.fun message format
- Inspect one raw websocket message from Pump.fun and modify `parseIncomingChatMessage(msg)` in server.js to return `{ username, message, timestamp }`.
- Some pump.fun endpoints require a subscription message after opening the websocket. Add `ws.send(...)` in ws.on('open') as needed.

## Files exported
When fight ends, JSON and CSV files are saved to `./exports/` with timestamped filenames. JSON contains:
{
  winner, winnerHits, lastHitter, scores[], totalHits, timestamp
}
CSV contains username/hits rows.
