const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { formatISO } = require('date-fns');
const crypto = require('crypto');
const { 
  Connection, 
  PublicKey, 
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  Keypair
} = require('@solana/web3.js');
// NEW: Import SPL Token functions
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getMint
} = require('@solana/spl-token');

let bs58 = require('bs58');
if (!bs58.decode) {
    bs58 = bs58.default || bs58; 
}
const { 
  Program, 
  AnchorProvider, 
  Wallet,
  BN,
  web3
} = require('@coral-xyz/anchor');

const app = express();
const server = http.createServer(app);

// Configuration for Socket.IO CORS
const io = new Server(server, {
    cors: {
        origin: [
            "http://localhost:3000",
            "https://boss-fight-pump-fun.onrender.com",
            "https://boss-fight-pump-fun.vercel.app/"
        ],
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Configuration
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const COIN_ADDRESS = process.env.COIN_ADDRESS || '';
const TRIGGER_KEYWORDS = (process.env.TRIGGER_KEYWORDS || 'HIT,■■').split(',').map(s => s.trim()).filter(Boolean);
const HEAL_KEYWORDS = (process.env.HEAL_KEYWORDS || 'HEAL,❤■').split(',').map(s => s.trim()).filter(Boolean);
const INITIAL_HP = process.env.INITIAL_HP ? Number(process.env.INITIAL_HP) : 30;
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, 'exports');
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://devnet.helius-rpc.com/?api-key=dc02dd0a-4e67-4759-8fa2-940cf9c75746';
const TREASURY_WALLET = process.env.TREASURY_WALLET;
const PROGRAM_ID_STR = process.env.PROGRAM_ID || 'EiWbPhCjpcf7w1ar5Ws2xxWFRrmS6M6gyNCwcPm8uNxz';
const TOKEN_MINT_STR = COIN_ADDRESS
const FEE_PERCENTAGE = process.env.FEE_PERCENTAGE ? Number(process.env.FEE_PERCENTAGE) : 0;
const BETTING_DURATION = 60;
const FIGHT_DURATION = 60;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'aaa';
const ADMIN_WALLET = process.env.ADMIN_WALLET || '5GrJ4aUiQRc1frnxyv89ws27wPu2fxsgJvxHgLmEjBBq';
const BOT_API_KEY = process.env.BOT_API_KEY; // For authenticated bot endpoint access

// Load whitelisted betting wallets (if specified)
const WHITELISTED_BETTING_WALLETS = process.env.WHITELISTED_BETTING_WALLETS
  ? process.env.WHITELISTED_BETTING_WALLETS.split(',').map(w => w.trim()).filter(Boolean)
  : null; // null means no whitelist (allow all)

// Helper function to check if a wallet is authorized to place bets
function isWalletAuthorizedToBet(walletAddress) {
  // If no whitelist is configured, allow all wallets
  if (!WHITELISTED_BETTING_WALLETS || WHITELISTED_BETTING_WALLETS.length === 0) {
    return true;
  }

  // Check if wallet is in the whitelist
  return WHITELISTED_BETTING_WALLETS.includes(walletAddress);
}

let fightEndingInProgress = false;
let fightEndCalled = false;
let tokenDecimals = 6; // Will be fetched from mint

const { PumpChatClient } = require('pump-chat-client');

if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

// Validate required environment variables
if (!TREASURY_WALLET) {
  console.error('TREASURY_WALLET environment variable is required');
  process.exit(1);
}

if (!TOKEN_MINT_STR) {
  console.error('TOKEN_MINT environment variable is required (your pump.fun token)');
  process.exit(1);
}

function getAnchorDiscriminator(name) {
  const hash = crypto.createHash('sha256').update(`account:${name}`).digest();
  return hash.slice(0, 8);
}

const BET_ACCOUNT_DISCRIMINATOR = getAnchorDiscriminator('BetAccount');

// Load authority and treasury keypairs
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const tokenMint = new PublicKey(TOKEN_MINT_STR);
let authorityKeypair;
let treasuryKeypair;

try {
  if (!process.env.AUTHORITY_SECRET_KEY){
    console.error('Missing AUTHORITY_SECRET_KEY');
    process.exit(1);
  }
  authorityKeypair = Keypair.fromSecretKey(
    bs58.decode(process.env.AUTHORITY_SECRET_KEY)
  );
  console.log('✅ Authority loaded from env variable');
  console.log('🔑 Authority address:', authorityKeypair.publicKey.toString());

  if (!process.env.TREASURY_SECRET_KEY){
    console.error('Missing TREASURY_SECRET_KEY');
    process.exit(1);
  }
  treasuryKeypair = Keypair.fromSecretKey(
    bs58.decode(process.env.TREASURY_SECRET_KEY)
  );
  console.log('✅ Treasury loaded from env variable');
  console.log('🏦 Treasury address:', treasuryKeypair.publicKey.toString());
  console.log('🪙 Token mint:', TOKEN_MINT_STR);
  
  // Fetch token decimals
  getMint(connection, tokenMint, 'confirmed', TOKEN_PROGRAM_ID)
    .then(mintInfo => {
      tokenDecimals = mintInfo.decimals;
      console.log(`✅ Token decimals: ${tokenDecimals}`);
    })
    .catch(() => {
      console.error('Error fetching token mint info');
    });
  
  connection.getBalance(authorityKeypair.publicKey).then(balance => {
    console.log('💰 Authority SOL balance:', balance / LAMPORTS_PER_SOL, 'SOL');

    if (balance < 0.01 * LAMPORTS_PER_SOL) {
      console.error('❌ INSUFFICIENT SOL BALANCE FOR FEES!');
    }
  }).catch(() => {
    console.error('Error checking balance');
  });
  
} catch (error) {
  console.error('❌ Error loading authority keypair');
  process.exit(1);
}

// Solana connection and program setup
const wallet = new Wallet(authorityKeypair);
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
const programId = new PublicKey(PROGRAM_ID_STR);
const treasuryPubkey = treasuryKeypair.publicKey;

// Load IDL
const idl = JSON.parse(fs.readFileSync(path.join(__dirname, 'target', 'idl_prod.json'), 'utf8'));
const program = new Program(idl, provider);

// Game phases
const GAME_PHASES = {
  IDLE: 'idle',
  WAITING: 'waiting',
  BETTING: 'betting',
  FIGHTING: 'fighting',
  ENDED: 'ended'
};

// In-memory state
let gamePhase = GAME_PHASES.IDLE;
let currentRoundId = 0;
let bossHP = INITIAL_HP;
let userHits = new Map();
let chronological = [];
let lastHitter = null;
let totalHits = 0;
let clientsCount = 0;
let pumpSocket = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;
const reconnectInterval = 5000;
const WAITING_DURATION = process.env.WAITING_DURATION || 5 * 60; // 5 minutes in seconds
let waitingEndTime = null;
let waitingTimer = null;

// Game timing
let bettingEndTime = null;
let fightEndTime = null;
let gameTimer = null;
const IDLE_DURATION = 60;

let idleStartTime = null;
let idleTimer = null;

// Blockchain state
let bettingRoundPDA = null;
let escrowTokenAccountPDA = null; // NEW: Changed from escrowPDA
let onChainBets = new Map();
let totalDeathBets = 0;
let totalSurvivalBets = 0;
let isConnecting = false;
let isConnected = false;

// Helper function to convert tokens to base units
function toBaseUnits(amount) {
  return Math.floor(amount * Math.pow(10, tokenDecimals));
}

// Helper function to convert base units to tokens
function fromBaseUnits(amount) {
  return amount / Math.pow(10, tokenDecimals);
}

// Serve index.html with environment variable injection
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  // Replace the placeholder with actual environment variable
  const bossImageText = process.env.BOSS_IMAGE_TEXT || 'RAID THE BOSS';
  html = html.replace('${BOSS_IMAGE_TEXT}', bossImageText);

  res.send(html);
});

// Serve static overlay page and assets
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' })); // Limit request body size

// Middleware to validate Solana wallet address
function validateWalletAddress(address) {
  if (!address || typeof address !== 'string') return false;
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// Middleware to sanitize username
function sanitizeUsername(username) {
  if (!username || typeof username !== 'string') return null;
  // Remove HTML tags and limit length
  const sanitized = username.replace(/<[^>]*>/g, '').trim();
  return sanitized.length > 0 && sanitized.length <= 50 ? sanitized : null;
}

// Middleware to authenticate bot API requests
function authenticateBotAPI(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;

  if (!BOT_API_KEY) {
    return res.status(500).json({ error: 'Bot API not configured' });
  }

  if (apiKey !== BOT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized - Invalid API key' });
  }

  next();
}

// API endpoints
app.get('/api/game-status', (req, res) => {
  res.json({
    gamePhase,
    currentRoundId,
    bossHP,
    maxHP: INITIAL_HP,
    totalHits,
    coinAddress: COIN_ADDRESS,
    programId: PROGRAM_ID_STR,
    tokenMint: TOKEN_MINT_STR,
    tokenDecimals,
    bettingEndTime,
    fightEndTime,
    totalDeathBets: totalDeathBets,
    totalSurvivalBets: totalSurvivalBets,
    totalBets: onChainBets.size
  });
});

app.get('/api/betting-round/:roundId', async (req, res) => {
  try {
    const roundId = parseInt(req.params.roundId);

    // Validate round ID
    if (isNaN(roundId) || roundId < 0) {
      return res.status(400).json({ error: 'Invalid round ID' });
    }

    const [bettingRoundPDA] = getBettingRoundPDA(roundId);

    const bettingRoundAccount = await program.account.bettingRound.fetch(bettingRoundPDA);

    res.json({
      roundId,
      phase: Object.keys(bettingRoundAccount.phase)[0],
      currentHp: bettingRoundAccount.currentHp,
      initialHp: bettingRoundAccount.initialHp,
      totalDeathBets: fromBaseUnits(bettingRoundAccount.totalDeathBets.toNumber()),
      totalSurvivalBets: fromBaseUnits(bettingRoundAccount.totalSurvivalBets.toNumber()),
      totalBetsCount: bettingRoundAccount.totalBetsCount.toNumber(),
      bossDefeated: bettingRoundAccount.bossDefeated,
      bettingEndTime: bettingRoundAccount.bettingEndTime.toNumber() * 1000,
      fightEndTime: bettingRoundAccount.fightEndTime.toNumber() * 1000,
      tokenMint: bettingRoundAccount.tokenMint.toString()
    });
  } catch (error) {
    console.error('Error fetching betting round');
    res.status(404).json({ error: 'Betting round not found' });
  }
});

app.post('/api/bet-notification', (req, res) => {
  try {
    const { walletAddress, username, prediction } = req.body;

    // Validate wallet address
    if (!validateWalletAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Sanitize and validate username
    const sanitizedUsername = sanitizeUsername(username);
    if (!sanitizedUsername) {
      return res.status(400).json({ error: 'Invalid username' });
    }

    // Validate prediction
    if (prediction !== 'death' && prediction !== 'survival') {
      return res.status(400).json({ error: 'Invalid prediction - must be "death" or "survival"' });
    }

    // Check if wallet is authorized to place bets
    if (!isWalletAuthorizedToBet(walletAddress)) {
      console.log(`Unauthorized bet notification from wallet: ${walletAddress}`);
      return res.status(403).json({ error: 'Wallet not authorized to place bets' });
    }

    console.log(`Bet notification received: ${sanitizedUsername} (${walletAddress}) bet on ${prediction}`);

    onChainBets.set(walletAddress, {
      username: sanitizedUsername,
      prediction,
      timestamp: Date.now()
    });

    if (prediction === 'death') {
      totalDeathBets += 1;
    } else {
      totalSurvivalBets += 1;
    }

    io.emit('betting_update', {
      totalDeathBets: totalDeathBets,
      totalSurvivalBets: totalSurvivalBets,
      totalBets: onChainBets.size
    });

    res.json({ success: true, message: 'Bet notification received' });
  } catch (error) {
    console.error('Error processing bet notification');
    res.status(500).json({ error: 'Error processing bet notification' });
  }
});

app.get('/api/current-round', (req, res) => {
  res.json({
    gamePhase,
    currentRoundId,
    programId: PROGRAM_ID_STR,
    tokenMint: TOKEN_MINT_STR,
    tokenDecimals,
    bettingRoundPDA: bettingRoundPDA ? bettingRoundPDA.toString() : null,
    escrowTokenAccountPDA: escrowTokenAccountPDA ? escrowTokenAccountPDA.toString() : null,
    bettingEndTime,
    fightEndTime,
    totalDeathBets: totalDeathBets,
    totalSurvivalBets: totalSurvivalBets,
    totalBets: onChainBets.size
  });
});

async function getRobustBlockhash(connection, commitment) {
    let attempts = 0;
    while (attempts < 3) {
        try {
            const blockhashData = await connection.getLatestBlockhash(commitment);

            if (blockhashData && blockhashData.blockhash) {
                return blockhashData;
            }
        } catch (error) {
            console.warn(`Attempt ${attempts + 1} failed to fetch blockhash. Retrying...`);
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    throw new Error('Failed to fetch a recent blockhash after multiple attempts.');
}

// NEW: Ensure token account exists
async function ensureTokenAccount(connection, mint, owner, payer) {
  const tokenAccountAddress = await getAssociatedTokenAddress(
    mint,
    owner,
    false,
    TOKEN_PROGRAM_ID
  );

  try {
    await getAccount(connection, tokenAccountAddress, 'confirmed', TOKEN_PROGRAM_ID);
    return { address: tokenAccountAddress, instruction: null };
  } catch (error) {
    const instruction = createAssociatedTokenAccountInstruction(
      payer,
      tokenAccountAddress,
      owner,
      mint,
      TOKEN_PROGRAM_ID
    );
    return { address: tokenAccountAddress, instruction };
  }
}

app.post('/api/place-bet', async (req, res) => {
  try {
    const { walletAddress, username, prediction } = req.body;

    // Validate wallet address
    if (!validateWalletAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Sanitize and validate username
    const sanitizedUsername = sanitizeUsername(username);
    if (!sanitizedUsername) {
      return res.status(400).json({ error: 'Invalid username' });
    }

    // Validate prediction
    if (prediction !== 'death' && prediction !== 'survival') {
      return res.status(400).json({ error: 'Invalid prediction - must be "death" or "survival"' });
    }

    if (gamePhase !== GAME_PHASES.BETTING || !currentRoundId) {
      return res.status(400).json({ error: 'Betting is closed or no round is active' });
    }

    // Check if wallet is authorized to place bets
    if (!isWalletAuthorizedToBet(walletAddress)) {
      console.log(`Unauthorized bet attempt from wallet: ${walletAddress}`);
      return res.status(403).json({ error: 'Wallet not authorized to place bets' });
    }

    // Check if user already placed a bet
    if (onChainBets.has(walletAddress)) {
      return res.status(400).json({ error: 'Bet already placed for this round' });
    }

    console.log(`Free bet accepted from ${sanitizedUsername} (${walletAddress}) on ${prediction}`);

    // Simply acknowledge the bet - no blockchain transaction needed
    res.json({
      success: true,
      message: 'Free bet accepted'
    });

  } catch (error) {
    console.error('Error placing bet');
    res.status(500).json({ error: 'Error placing bet' });
  }
});

app.get('/api/bet-status/:walletAddress/:roundId', async (req, res) => {
  try {
    const { walletAddress, roundId } = req.params;

    // Validate wallet address
    if (!validateWalletAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Validate round ID
    const parsedRoundId = parseInt(roundId);
    if (isNaN(parsedRoundId) || parsedRoundId < 0) {
      return res.status(400).json({ error: 'Invalid round ID' });
    }

    // Check in-memory bet storage
    if (onChainBets.has(walletAddress) && parsedRoundId === currentRoundId) {
      const bet = onChainBets.get(walletAddress);
      res.json({
        exists: true,
        prediction: bet.prediction,
        username: bet.username,
        timestamp: bet.timestamp
      });
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error('Error checking bet status');
    res.status(500).json({ error: 'Error checking bet status' });
  }
});

// Bot API endpoint - protected with authentication
app.get('/api/bot/simulate-hit', authenticateBotAPI, (req, res) => {
  const user = req.query.user || 'tester';
  const msg = req.query.msg || 'HIT';

  // Sanitize username
  const sanitizedUser = sanitizeUsername(user);
  if (!sanitizedUser) {
    return res.status(400).json({ error: 'Invalid username' });
  }

  // Validate message
  if (!msg || typeof msg !== 'string' || msg.length > 100) {
    return res.status(400).json({ error: 'Invalid message' });
  }

  if (gamePhase === GAME_PHASES.FIGHTING) {
    handleChatMessage(sanitizedUser, msg, Date.now());
    res.json({ ok: true, user: sanitizedUser, msg, gamePhase, message: 'Message processed' });
  } else {
    res.json({ ok: false, gamePhase, message: 'Not in fighting phase' });
  }
});

// Handle overlay client connections
io.on('connection', (socket) => {
  clientsCount++;
  console.log(`Overlay client connected. Total clients: ${clientsCount}`);
  
  socket.emit('state', {
    gamePhase,
    currentRoundId,
    bossHP,
    maxHP: INITIAL_HP,
    top: getTop(3),
    lastHitter,
    chronological: chronological.slice(-10),
    totalDeathBets: totalDeathBets,
    totalSurvivalBets: totalSurvivalBets,
    totalBets: onChainBets.size,
    tokenMint: TOKEN_MINT_STR,
    tokenDecimals,
    timeRemaining: gamePhase === GAME_PHASES.BETTING ? Math.max(0, bettingEndTime - Date.now()) : 0,
    fightTimeRemaining: gamePhase === GAME_PHASES.FIGHTING ? Math.max(0, fightEndTime - Date.now()) : 0,
    connected: pumpSocket?.readyState === WebSocket.OPEN || false
  });

  socket.on('disconnect', () => {
    clientsCount--;
    console.log(`Overlay client disconnected. Total clients: ${clientsCount}`);
  });

  socket.on('admin:reset', (data) => {
    if (!data || !data.adminKey || !data.walletAddress) {
      socket.emit('admin:error', { message: 'Missing credentials' });
      return;
    }
    
    if (data.walletAddress !== ADMIN_WALLET) {
      socket.emit('admin:error', { message: 'Unauthorized wallet' });
      return;
    }
    
    if (data.adminKey === ADMIN_SECRET) {
      resetGame();
    } else {
      socket.emit('admin:error', { message: 'Invalid admin key' });
    }
  });
  
  socket.on('admin:start_betting', (data) => {
    if (data && data.adminKey === ADMIN_SECRET && data.walletAddress == ADMIN_WALLET) {
      startBettingPhase();
    } else {
      socket.emit('admin:error', { message: 'Unauthorized' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Overlay page: http://localhost:${PORT}/index.html`);
  console.log(`Authority: ${authorityKeypair.publicKey.toString()}`);
  console.log(`Treasury: ${TREASURY_WALLET}`);
  console.log(`Program ID: ${PROGRAM_ID_STR}`);
  console.log(`Token Mint: ${TOKEN_MINT_STR}`);
  console.log(`Token Decimals: ${tokenDecimals}`);
  console.log(`Trigger keywords: ${TRIGGER_KEYWORDS.join(', ')}`);
  console.log(`Heal keywords: ${HEAL_KEYWORDS.join(', ')}`);

  // Log whitelist status
  if (WHITELISTED_BETTING_WALLETS && WHITELISTED_BETTING_WALLETS.length > 0) {
    console.log(`\n🔒 BETTING WHITELIST ENABLED`);
    console.log(`📋 Authorized wallets (${WHITELISTED_BETTING_WALLETS.length}):`);
    WHITELISTED_BETTING_WALLETS.forEach((wallet, index) => {
      console.log(`   ${index + 1}. ${wallet}`);
    });
  } else {
    console.log(`\n🔓 BETTING WHITELIST DISABLED - All wallets can place bets`);
  }

  connectToPumpFun();
  //autoStartGameLoop();
});

function connectToPumpFun() {
  if (!COIN_ADDRESS) {
    console.warn('No COIN_ADDRESS configured. Set this environment variable to monitor a specific coin.');
    return;
  }

  if (isConnecting || isConnected) {
    console.log('Already connected or connecting to pump.fun chat');
    return;
  }

  isConnecting = true;
  console.log('Connecting to pump.fun chat via pump-chat-client');
  console.log('Monitoring coin:', COIN_ADDRESS);
  
  if (pumpSocket) {
    try {
      pumpSocket.disconnect();
    } catch (e) {
      // Ignore errors
    }
  }
  
  pumpSocket = new PumpChatClient({
    roomId: COIN_ADDRESS
  });
  
  pumpSocket.on('connected', () => {
    console.log('Successfully connected to pump.fun chat!');
    reconnectAttempts = 0;
    isConnecting = false;
    isConnected = true;
    broadcastConnectionStatus(true);
  });

  pumpSocket.on('message', (messageData) => {
    console.log(`<${messageData.username}> ${messageData.message}`);
    if (gamePhase === GAME_PHASES.FIGHTING) {
      handleChatMessage(messageData.username, messageData.message, new Date(messageData.timestamp).getTime());
    }
  });

  pumpSocket.on('error', (error) => {
    console.error('Connection error:', error.message);
    isConnected = false;
    isConnecting = false;
    broadcastConnectionStatus(false);
  });

  pumpSocket.on('disconnected', (reason) => {
    console.log('Disconnected from pump.fun chat:', reason);
    isConnected = false;
    isConnecting = false;
    broadcastConnectionStatus(false);
    
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      console.log(`Attempting to reconnect (${reconnectAttempts}/${maxReconnectAttempts})...`);
      setTimeout(() => {
        connectToPumpFun();
      }, reconnectInterval);
    } else {
      console.error('Max reconnection attempts reached. Please restart the server.');
    }
  });
  
  pumpSocket.connect();
}

function broadcastConnectionStatus(connected) {
  io.emit('connection_status', { connected });
}

// Utility functions for Solana PDAs
function getBettingRoundPDA(roundId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('betting_round'), new BN(roundId).toArrayLike(Buffer, 'le', 8)],
    programId
  );
}

// NEW: Get escrow TOKEN account PDA
function getEscrowTokenAccountPDA(roundId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), new BN(roundId).toArrayLike(Buffer, 'le', 8)],
    programId
  );
}

function getBetPDA(roundId, bettor) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('bet'),
      new BN(roundId).toArrayLike(Buffer, 'le', 8),
      bettor.toBuffer()
    ],
    programId
  );
}

// Game phase management
async function startBettingPhase() {
  if (gamePhase !== GAME_PHASES.IDLE && gamePhase !== GAME_PHASES.ENDED) {
    console.log('Cannot start betting phase - game is already in progress');
    return;
  }
  
  try {
    resetGame();
    console.log('Starting 5-minute waiting period before betting...');
    fightEndingInProgress = false;
    fightEndCalled = false;
    currentRoundId = Date.now();
    
    // Set waiting phase
    gamePhase = GAME_PHASES.WAITING;
    waitingEndTime = Date.now() + (WAITING_DURATION * 1000);
    
    // Emit waiting phase to clients
    io.emit('waiting_phase', {
      gamePhase: 'waiting',
      currentRoundId,
      timeRemaining: WAITING_DURATION * 1000,
      message: 'Preparing for the next round! Betting will start in 5 minutes.',
    });
    
    // Start countdown timer that emits every second
    const waitingInterval = setInterval(() => {
      const remaining = waitingEndTime - Date.now();
      
      if (remaining <= 0) {
        clearInterval(waitingInterval);
        return;
      }
      
      io.emit('waiting_timer_update', {
        timeRemaining: remaining,
        phase: 'waiting'
      });
    }, 1000);
    
    // After 5 minutes, initialize betting round
    waitingTimer = setTimeout(async () => {
      console.log('Waiting period ended. Initializing betting round on blockchain...');
      
      try {
        const [bettingRoundPDAResult] = getBettingRoundPDA(currentRoundId);
        const [escrowTokenAccountPDAResult] = getEscrowTokenAccountPDA(currentRoundId);
        bettingRoundPDA = bettingRoundPDAResult;
        escrowTokenAccountPDA = escrowTokenAccountPDAResult;

        if (program) {
          // Get treasury token account
          const { address: treasuryTokenAccount, instruction: createTreasuryTokenAccountIx } =
            await ensureTokenAccount(connection, tokenMint, treasuryPubkey, authorityKeypair.publicKey);

          // Prize pool is 30k tokens in base units
          const PRIZE_POOL = 30000;
          const prizePoolBaseUnits = toBaseUnits(PRIZE_POOL);

          const tx = await program.methods
            .initializeBettingRound(
              new BN(currentRoundId),
              new BN(BETTING_DURATION),
              new BN(FIGHT_DURATION),
              INITIAL_HP,
              new BN(prizePoolBaseUnits)
            )
            .accounts({
              bettingRound: bettingRoundPDA,
              escrowTokenAccount: escrowTokenAccountPDA,
              tokenMint: tokenMint,
              treasuryTokenAccount: treasuryTokenAccount,
              authority: authorityKeypair.publicKey,
              treasury: treasuryPubkey,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              rent: web3.SYSVAR_RENT_PUBKEY,
            })
            .preInstructions(createTreasuryTokenAccountIx ? [createTreasuryTokenAccountIx] : [])
            .signers([authorityKeypair, treasuryKeypair]) // Both authority and treasury must sign
            .rpc();
          
          console.log('Betting round initialized on blockchain:', tx);
        }
        
        gamePhase = GAME_PHASES.BETTING;
        bettingEndTime = Date.now() + (BETTING_DURATION * 1000);
        
        console.log('Betting phase started! Users have time to place bets.');
        
        io.emit('phase_change', {
          gamePhase,
          currentRoundId,
          timeRemaining: BETTING_DURATION * 1000,
          message: 'Betting phase started! Place your bets on boss death or survival!',
          bettingRoundPDA: bettingRoundPDA.toString(),
          escrowTokenAccountPDA: escrowTokenAccountPDA.toString(),
          tokenMint: TOKEN_MINT_STR,
          tokenDecimals
        });
        
        gameTimer = setTimeout(() => {
          startFightingPhase();
        }, BETTING_DURATION * 1000);
        
      } catch (error) {
        console.error('Error initializing betting round after waiting:', error);
        gamePhase = GAME_PHASES.IDLE;
        io.emit('error', { message: 'Failed to start betting phase after waiting period' });
      }
    }, WAITING_DURATION * 1000);
    
  } catch (error) {
    console.error('Error starting waiting phase:', error);
    gamePhase = GAME_PHASES.IDLE;
  }
}

async function startFightingPhase(retryCount = 0) {
  if (gamePhase !== GAME_PHASES.BETTING) return;
  
  try {
    if (program) {
      console.log('Starting fight phase on blockchain...');
      
      const tx = await program.methods
        .startFightPhase()
        .accounts({
          bettingRound: bettingRoundPDA,
          authority: authorityKeypair.publicKey,
        })
        .rpc();
      
      console.log('Fight phase started on blockchain:', tx);
    }
    
    gamePhase = GAME_PHASES.FIGHTING;
    fightEndTime = Date.now() + (FIGHT_DURATION * 1000);
    
    if (program) {
      await loadBettingData();
    }
    
    console.log('Fighting phase started! Raid begins now.');
    
    io.emit('phase_change', {
      gamePhase,
      timeRemaining: FIGHT_DURATION * 1000,
      message: 'Raid started! You have 1 minute to defeat the boss!'
    });
    
    gameTimer = setTimeout(() => {
      endFight();
    }, FIGHT_DURATION * 1000);
    
  } catch (error) {
    if (error.error?.errorCode?.code === 'BettingStillActive' && retryCount < 5) {
      console.log(`Betting still active on-chain, retrying in 2 seconds (attempt ${retryCount + 1}/5)...`);
      setTimeout(() => startFightingPhase(retryCount + 1), 2000);
      return;
    }
    
    console.error('Error starting fight phase:', error);
    
    if (retryCount >= 5) {
      console.error('Failed to start fight phase after 5 retry attempts');
      io.emit('phase_change', {
        gamePhase: GAME_PHASES.IDLE,
        message: 'Failed to start fight phase. Please try starting a new betting round.'
      });
      gamePhase = GAME_PHASES.IDLE;
    }
  }
}

async function loadBettingData() {
  try {
    // Betting data is already in memory (onChainBets map)
    // Just recalculate counts
    totalDeathBets = 0;
    totalSurvivalBets = 0;

    for (const [walletAddress, bet] of onChainBets.entries()) {
      if (bet.prediction === 'death') {
        totalDeathBets++;
      } else {
        totalSurvivalBets++;
      }
    }

    console.log(`Loaded betting data - Death: ${totalDeathBets} bets, Survival: ${totalSurvivalBets} bets`);
    console.log(`Total bets count: ${onChainBets.size}`);

    io.emit('betting_update', {
      totalDeathBets: totalDeathBets,
      totalSurvivalBets: totalSurvivalBets,
      totalBets: onChainBets.size
    });

  } catch (error) {
    console.error('Error loading betting data:', error);
    throw error;
  }
}

// Timer broadcast for real-time updates
setInterval(() => {
  if (gamePhase === GAME_PHASES.BETTING && bettingEndTime) {
    const timeRemaining = Math.max(0, bettingEndTime - Date.now());
    io.emit('timer_update', {
      phase: 'betting',
      timeRemaining
    });
  } else if (gamePhase === GAME_PHASES.FIGHTING && fightEndTime) {
    const timeRemaining = Math.max(0, fightEndTime - Date.now());
    io.emit('timer_update', {
      phase: 'fighting',
      timeRemaining
    });
  } else if ((gamePhase === GAME_PHASES.IDLE || gamePhase === GAME_PHASES.ENDED) && idleStartTime) {
    const timeElapsed = Date.now() - idleStartTime;
    const totalDuration = IDLE_DURATION * 1000;
    const timeRemaining = Math.max(0, totalDuration - timeElapsed);

    io.emit('timer_update', {
      phase: 'idle',
      timeRemaining
    });
  }
}, 100);

async function claimFees() {
  if (!bettingRoundPDA || !escrowTokenAccountPDA || !program) return;
  
  try {
    console.log('Claiming fees from escrow...');
    
    // NEW: Get treasury token account
    const { address: treasuryTokenAccount, instruction: createTreasuryTokenAccountIx } = 
      await ensureTokenAccount(connection, tokenMint, treasuryPubkey, authorityKeypair.publicKey);
    
    // Build transaction
    const tx = await program.methods
      .claimFees()
      .accounts({
        bettingRound: bettingRoundPDA,
        escrowTokenAccount: escrowTokenAccountPDA, // NEW
        treasuryTokenAccount: treasuryTokenAccount, // NEW
        treasury: treasuryPubkey,
        authority: authorityKeypair.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID, // NEW
      })
      .preInstructions(createTreasuryTokenAccountIx ? [createTreasuryTokenAccountIx] : [])
      .rpc();
      
    console.log('Fees claimed successfully:', tx);
  } catch (error) {
    console.error('Error claiming fees:', error);
  }
}

async function processPayouts() {
  try {
    console.log('Processing payouts...');

    const bossDefeated = bossHP === 0;
    const winningPrediction = bossDefeated ? 'death' : 'survival';

    // Count winners
    let winnerCount = 0;
    const winners = [];

    for (const [walletAddress, bet] of onChainBets.entries()) {
      if (bet.prediction === winningPrediction) {
        winnerCount++;
        winners.push({
          walletAddress,
          username: bet.username
        });
      }
    }

    console.log(`Boss ${bossDefeated ? 'defeated' : 'survived'}`);
    console.log(`Winning side: ${winningPrediction}`);
    console.log(`Total winners: ${winnerCount}`);

    if (winnerCount === 0) {
      console.log('No winners - no payouts to process');
      io.emit('payouts_processed', {
        bossDefeated,
        winningPrediction,
        totalPrizePool: 300000,
        winningBets: 0,
        payouts: []
      });
      return;
    }

    // Prize pool is 300k tokens, split equally among winners
    const PRIZE_POOL = 30000;
    const payoutPerWinner = Math.floor(PRIZE_POOL / winnerCount);
    const payoutPerWinnerInBaseUnits = toBaseUnits(payoutPerWinner);

    console.log(`Prize pool: ${PRIZE_POOL} tokens`);
    console.log(`Payout per winner: ${payoutPerWinner} tokens`);

    const payoutResults = [];

    // Process payouts for each winner
    for (const winner of winners) {
      try {
        const winnerPubkey = new PublicKey(winner.walletAddress);

        // Get winner's token account
        const { address: winnerTokenAccount, instruction: createWinnerTokenAccountIx } =
          await ensureTokenAccount(connection, tokenMint, winnerPubkey, authorityKeypair.publicKey);

        // Get treasury token account
        const { address: treasuryTokenAccount } =
          await ensureTokenAccount(connection, tokenMint, treasuryPubkey, authorityKeypair.publicKey);

        console.log(`Sending ${payoutPerWinner} tokens to ${winner.username} (${winner.walletAddress})`);

        // Create transfer instruction from treasury to winner
        const { createTransferInstruction } = require('@solana/spl-token');

        const transferIx = createTransferInstruction(
          treasuryTokenAccount,
          winnerTokenAccount,
          treasuryKeypair.publicKey, // Treasury signs, not authority
          payoutPerWinnerInBaseUnits,
          [],
          TOKEN_PROGRAM_ID
        );

        const transaction = new web3.Transaction();
        if (createWinnerTokenAccountIx) {
          transaction.add(createWinnerTokenAccountIx);
        }
        transaction.add(transferIx);

        const signature = await web3.sendAndConfirmTransaction(
          connection,
          transaction,
          createWinnerTokenAccountIx ? [authorityKeypair, treasuryKeypair] : [treasuryKeypair], // Treasury must sign the transfer
          { commitment: 'confirmed' }
        );

        console.log(`Payout processed for ${winner.username}: ${signature}`);

        payoutResults.push({
          username: winner.username,
          wallet: winner.walletAddress,
          payout: payoutPerWinner,
          signature: signature
        });
      } catch (payoutError) {
        console.error(`Error processing payout for ${winner.username}:`, payoutError.message);
      }
    }

    io.emit('payouts_processed', {
      bossDefeated,
      winningPrediction,
      totalPrizePool: PRIZE_POOL,
      winningBets: payoutResults.length,
      payouts: payoutResults
    });

    console.log('Payout processing complete');
    return payoutResults;
  } catch (error) {
    console.error('Error processing payouts:', error);
    throw error;
  }
}

async function endFight() {
  if (fightEndingInProgress || fightEndCalled) {
    console.log('Fight end already in progress or completed. Skipping duplicate call');
    return;
  }
  if (gamePhase !== GAME_PHASES.FIGHTING) return;
  
  try {
    fightEndingInProgress = true;
    fightEndCalled = true;
    clearTimeout(gameTimer);
    
    const bossDefeated = bossHP === 0;
    
    console.log(`Ending fight. Boss ${bossDefeated ? 'defeated' : 'survived'}`);
    console.log(`Final HP: ${bossHP}/${INITIAL_HP}`);
    
    if (program) {
      console.log('Ending fight on blockchain');
      const finalHP_BN = new BN(bossHP); 
      
      console.log(`[RPC PAYLOAD CHECK] Sending final_hp: ${bossHP} (BN value: ${finalHP_BN.toString()})`);
      
      const tx = await program.methods
        .endFight(finalHP_BN)
        .accounts({
          bettingRound: bettingRoundPDA,
          authority: authorityKeypair.publicKey,
        })
        .rpc();
      
      console.log('Fight ended on blockchain:', tx);
      await processPayouts();
    }
    
    gamePhase = GAME_PHASES.ENDED;
    //autoStartGameLoop();
    
    const results = buildResults(bossDefeated);
    
    io.emit('fight_ended', {
      gamePhase,
      bossDefeated,
      results,
      message: `Boss ${bossDefeated ? 'defeated' : 'survived'}! Processing payouts...`
    });
    
    exportResults(results).then(() => {
      console.log('Results exported.');
    }).catch(err => console.error('Error exporting results:', err));
  } catch (error) {
    console.error('Error ending fight:', error);
  } finally {
    fightEndingInProgress = false;
  }
}

function resetGame() {
  gamePhase = GAME_PHASES.IDLE;
  currentRoundId = 0;
  bossHP = INITIAL_HP;
  userHits = new Map();
  chronological = [];
  lastHitter = null;
  totalHits = 0;
  onChainBets = new Map();
  totalDeathBets = 0;
  totalSurvivalBets = 0;
  bettingEndTime = null;
  fightEndTime = null;
  bettingRoundPDA = null;
  escrowTokenAccountPDA = null; // NEW: Changed name

  fightEndingInProgress = false;
  fightEndCalled = false;
  
  if (gameTimer) {
    clearTimeout(gameTimer);
    gameTimer = null;
  }
  
  console.log(`Game reset! Boss HP: ${bossHP}/${INITIAL_HP}`);
  
  io.emit('game_reset', {
    gamePhase,
    bossHP,
    maxHP: INITIAL_HP,
    message: 'Game reset. Ready for new betting phase!'
  });
}

async function handleChatMessage(username, message, timestamp = Date.now()) {
  if (gamePhase !== GAME_PHASES.FIGHTING) return;

  if (bossHP <= 0) {
    console.log(`Boss is already defeated. Ignoring message from ${username}.`);
    return;
  }

  const text = (message || '').toUpperCase();
  let delta = 0;
  
  const hasHitKeyword = TRIGGER_KEYWORDS.some(k => 
    k && text.includes(k.toUpperCase())
  );
  
  const hasHealKeyword = HEAL_KEYWORDS.some(k => 
    k && text.includes(k.toUpperCase())
  );

  if (hasHitKeyword && !hasHealKeyword) {
    delta = -1;
  } else if (hasHealKeyword && !hasHitKeyword) {
    delta = 1;
  }

  if (delta === 0) return;

  const hitsDelta = Math.abs(delta);
  
  if (delta < 0) {
    totalHits += hitsDelta;
    const prev = userHits.get(username) || 0;
    userHits.set(username, prev + hitsDelta);
    lastHitter = username;
    console.log(`${username} dealt ${hitsDelta} damage! Boss HP: ${Math.max(0, bossHP + delta)}/${INITIAL_HP}`);
  } else {
    console.log(`${username} healed ${hitsDelta} HP! Boss HP: ${Math.min(INITIAL_HP, bossHP + delta)}/${INITIAL_HP}`);
  }

  chronological.push({ username, message, timestamp, delta });

  bossHP = Math.max(0, Math.min(INITIAL_HP, bossHP + delta));
  
  io.emit('update', {
    bossHP,
    maxHP: INITIAL_HP,
    top: getTop(3),
    lastHitter,
    latest: chronological[chronological.length - 1],
    timeRemaining: Math.max(0, fightEndTime - Date.now())
  });

  if (bossHP === 0) {
    console.log("BOSS DEFEATED! Triggering immediate fight end sequence.");
    
    if (gameTimer) {
      clearTimeout(gameTimer);
      gameTimer = null;
    }
    
    await endFight(); 
  }
}

function getTop(n = 3) {
  const arr = Array.from(userHits.entries()).map(([username, hits]) => ({ username, hits }));
  arr.sort((a, b) => b.hits - a.hits);
  return arr.slice(0, n);
}

function buildResults(bossDefeated) {
  const top = getTop(1)[0] || null;
  return {
    currentRoundId,
    bossDefeated,
    topDamageDealer: top ? top.username : null,
    topDamage: top ? top.hits : 0,
    lastHitter,
    scores: Array.from(userHits.entries()).map(([username, hits]) => ({ username, hits })),
    totalHits,
    totalDeathBets: totalDeathBets,
    totalSurvivalBets: totalSurvivalBets,
    coinAddress: COIN_ADDRESS,
    programId: PROGRAM_ID_STR,
    tokenMint: TOKEN_MINT_STR,
    bettingRoundPDA: bettingRoundPDA ? bettingRoundPDA.toString() : null,
    escrowTokenAccountPDA: escrowTokenAccountPDA ? escrowTokenAccountPDA.toString() : null,
    timestamp: formatISO(new Date())
  };
}

async function exportResults(results) {
  const t = new Date();
  const baseName = `bossfight_${COIN_ADDRESS}_${currentRoundId}_${t.getTime()}`;
  
  // Log the full JSON results
  console.log('=== EXPORT RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
  console.log('======================');
  
  const jsonPath = path.join(EXPORT_DIR, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
  console.log('Results exported to:', jsonPath);

  // Log the CSV data in a readable format
  console.log('=== DAMAGE CSV DATA ===');
  console.log('Username | Hits');
  console.log('---------|-----');
  results.scores.forEach(score => {
    console.log(`${score.username} | ${score.hits}`);
  });
  console.log('=======================');

  const csvPath = path.join(EXPORT_DIR, `${baseName}_damage.csv`);
  const csvWriter = createCsvWriter({
    path: csvPath,
    header: [
      { id: 'username', title: 'username' },
      { id: 'hits', title: 'hits' }
    ]
  });
  await csvWriter.writeRecords(results.scores);
  console.log('Damage CSV exported to:', csvPath);
  
  return { jsonPath, csvPath };
}

process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  if (gameTimer) clearTimeout(gameTimer);
  if (pumpSocket && pumpSocket.readyState === WebSocket.OPEN) {
    pumpSocket.close();
  }
  process.exit(0);
});