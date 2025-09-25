/**
 * server.js
 *
 * Node.js server that:
 * - connects to pump.fun chat websocket
 * - listens to messages and filters trigger keywords
 * - maintains boss HP and per-user stats
 * - serves a lightweight overlay page (overlay.html)
 * - broadcasts updates to overlay clients via socket.io
 * - exports JSON + CSV at end of fight
 *
 * Configuration via env:
 * COIN_ADDRESS (string) -> pump.fun coin address to monitor
 * TRIGGER_KEYWORDS (comma-separated) default: "HIT,■■"
 * HEAL_KEYWORDS (comma-separated) default: "HEAL,❤■"
 * INITIAL_HP default: 10000
 * PORT default: 3000
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws'); // Use the 'ws' library for a raw WebSocket connection
const fs = require('fs');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { formatISO } = require('date-fns');

const app = express();
const server = http.createServer(app);
const io = new Server(server); // This is for serving the overlay clients

// Configuration
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const COIN_ADDRESS = process.env.COIN_ADDRESS || '';
const TRIGGER_KEYWORDS = (process.env.TRIGGER_KEYWORDS || 'HIT,■■').split(',').map(s => s.trim()).filter(Boolean);
const HEAL_KEYWORDS = (process.env.HEAL_KEYWORDS || 'HEAL,❤■').split(',').map(s => s.trim()).filter(Boolean);
const INITIAL_HP = process.env.INITIAL_HP ? Number(process.env.INITIAL_HP) : 30;
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, 'exports');
const { PumpChatClient } = require('pump-chat-client');

if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

// In-memory state
let bossHP = INITIAL_HP;
let running = true;
let userHits = new Map(); // username -> hits
let chronological = []; // {username, msg, timestamp, delta}
let lastHitter = null;
let totalHits = 0;
let clientsCount = 0;
let pumpSocket = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;
const reconnectInterval = 5000;

// Serve static overlay page and assets
app.use(express.static(path.join(__dirname, 'public')));

app.get('/test', (req, res) => {
  const user = req.query.user || 'tester';
  const msg = req.query.msg || 'HIT';
  handleChatMessage(user, msg, Date.now());
  res.json({ ok: true, user, msg });
});

app.get('/status', (req, res) => {
  res.json({
    connected: pumpSocket?.readyState === WebSocket.OPEN || false,
    bossHP,
    maxHP: INITIAL_HP,
    running,
    totalHits,
    coinAddress: COIN_ADDRESS
  });
});

// Handle overlay client connections
io.on('connection', (socket) => {
  clientsCount++;
  console.log(`Overlay client connected. Total clients: ${clientsCount}`);
  
  // Send initial state
  socket.emit('state', {
    bossHP,
    maxHP: INITIAL_HP,
    top: getTop(3),
    lastHitter,
    chronological: chronological.slice(-10)
  });

  socket.on('disconnect', () => {
    clientsCount--;
    console.log(`Overlay client disconnected. Total clients: ${clientsCount}`);
  });

  // Admin controls from overlay
  socket.on('admin:reset', (opts) => {
    resetFight(opts && opts.initialHP ? Number(opts.initialHP) : INITIAL_HP);
    io.emit('state', { 
      bossHP, 
      maxHP: INITIAL_HP, 
      top: getTop(3), 
      lastHitter, 
      chronological: chronological.slice(-10)
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Overlay page: http://localhost:${PORT}/overlay.html`);
  console.log(`Status endpoint: http://localhost:${PORT}/status`);
  console.log(`Trigger keywords: ${TRIGGER_KEYWORDS.join(', ')}`);
  console.log(`Heal keywords: ${HEAL_KEYWORDS.join(', ')}`);
  
  // Start pump.fun connection
  connectToPumpFun();
});

function connectToPumpFun() {
  if (!COIN_ADDRESS) {
    console.warn('No COIN_ADDRESS configured. Set this environment variable to monitor a specific coin.');
    return;
  }

  console.log('Connecting to pump.fun chat via pump-chat-client');
  console.log('Monitoring coin:', COIN_ADDRESS);
  
  // Create a new client instance
  pumpSocket = new PumpChatClient(
    {
        roomId: COIN_ADDRESS
    }
);
  
  pumpSocket.on('connected', () => {
    console.log('Successfully connected to pump.fun chat!');
    reconnectAttempts = 0;
  });

  // The client library handles the 'joinRoom' event automatically
  
  pumpSocket.on('message', (messageData) => {
    console.log(`<${messageData.username}> ${messageData.message}`);
      handleChatMessage(messageData.username, messageData.message, new Date(messageData.timestamp).getTime());
  });

  pumpSocket.on('error', (error) => {
    console.error('Connection error:', error.message);
  });

  pumpSocket.on('disconnected', (reason) => {
    console.log('Disconnected from pump.fun chat:', reason);
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      console.log(`Attempting to reconnect (${reconnectAttempts}/${maxReconnectAttempts})...`);
      // The client library handles the internal reconnect logic
      pumpSocket.connect();
    } else {
      console.error('Max reconnection attempts reached. Please restart the server.');
    }
  });
  
  // Initiate the connection
  pumpSocket.connect();
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  if (pumpSocket && typeof pumpSocket.close === 'function') {
    pumpSocket.close();
  }
  process.exit(0);
});

/**
 * Message handling & game logic
 */
function handleChatMessage(username, message, timestamp = Date.now()) {
  if (!running) return;

  const text = (message || '').toUpperCase();
  let delta = 0;

  // Count trigger keywords (multiple occurrences in the same message count multiple hits)
  TRIGGER_KEYWORDS.forEach(k => {
    if (!k) return;
    // Count occurrences (case-insensitive)
    const re = new RegExp(escapeRegExp(k.toUpperCase()), 'g');
    const matches = (text.match(re) || []).length;
    delta -= matches;
  });

  HEAL_KEYWORDS.forEach(k => {
    if (!k) return;
    const re = new RegExp(escapeRegExp(k.toUpperCase()), 'g');
    const matches = (text.match(re) || []).length;
    delta += matches;
  });

  if (delta === 0) return; // nothing to do

  // Update stats
  const hitsDelta = Math.abs(delta);
  if (delta < 0) {
    // damage
    totalHits += hitsDelta;
    const prev = userHits.get(username) || 0;
    userHits.set(username, prev + hitsDelta);
    lastHitter = username;
    console.log(`${username} dealt ${hitsDelta} damage! Boss HP: ${Math.max(0, bossHP + delta)}/${INITIAL_HP}`);
  } else {
    // heal
    console.log(`${username} healed ${hitsDelta} HP! Boss HP: ${Math.min(INITIAL_HP, bossHP + delta)}/${INITIAL_HP}`);
  }

  // Push chronological entry
  chronological.push({
    username,
    message,
    timestamp,
    delta
  });

  // Apply to boss HP
  const previousHP = bossHP;
  bossHP = Math.max(0, Math.min(INITIAL_HP, bossHP + delta));
  
  // Broadcast current state to overlay clients
  io.emit('update', {
    bossHP,
    maxHP: INITIAL_HP,
    top: getTop(3),
    lastHitter,
    latest: chronological[chronological.length - 1]
  });

  if (bossHP === 0 && previousHP > 0) {
    // Game ended
    running = false;
    console.log('BOSS DEFEATED!');
    const results = buildResults();
    io.emit('end', results);
    exportResults(results).then(() => {
      console.log('Results exported.');
    }).catch(err => console.error('Error exporting results:', err));
  } else if (bossHP === INITIAL_HP && previousHP < INITIAL_HP) {
  }
}

function resetFight(newInitialHP) {
  bossHP = newInitialHP || INITIAL_HP;
  running = true;
  userHits = new Map();
  chronological = [];
  lastHitter = null;
  totalHits = 0;
  console.log(`Fight reset! Boss HP: ${bossHP}/${newInitialHP || INITIAL_HP}`);
}

// Helpers
function getTop(n = 3) {
  const arr = Array.from(userHits.entries()).map(([username, hits]) => ({ username, hits }));
  arr.sort((a, b) => b.hits - a.hits);
  return arr.slice(0, n);
}

function buildResults() {
  const top = getTop(1)[0] || null;
  return {
    winner: top ? top.username : null,
    winnerHits: top ? top.hits : 0,
    lastHitter,
    scores: Array.from(userHits.entries()).map(([username, hits]) => ({ username, hits })),
    totalHits,
    coinAddress: COIN_ADDRESS,
    timestamp: formatISO(new Date())
  };
}

async function exportResults(results) {
  const t = new Date();
  const baseName = `bossfight_${COIN_ADDRESS}_${t.getTime()}`;
  
  // JSON
  const jsonPath = path.join(EXPORT_DIR, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
  console.log('Results exported to:', jsonPath);

  // CSV
  const csvPath = path.join(EXPORT_DIR, `${baseName}.csv`);
  const csvWriter = createCsvWriter({
    path: csvPath,
    header: [
      { id: 'username', title: 'username' },
      { id: 'hits', title: 'hits' }
    ]
  });
  await csvWriter.writeRecords(results.scores);
  console.log('CSV exported to:', csvPath);
  
  return { jsonPath, csvPath };
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  if (pumpSocket && pumpSocket.readyState === WebSocket.OPEN) {
    pumpSocket.close();
  }
  process.exit(0);
});