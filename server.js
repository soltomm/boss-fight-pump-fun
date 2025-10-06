/**
 * server.js - Fixed version with client-side HP tracking
 *
 * Node.js server that:
 * - connects to pump.fun chat websocket
 * - integrates with Solana smart contract for betting
 * - manages game phases and blockchain interactions
 * - runs timed boss fights (1 minute duration)
 * - serves a lightweight overlay page (overlay.html)
 * - broadcasts updates to overlay clients via socket.io
 * - exports JSON + CSV at end of fight
 * - HP is tracked client-side and only sent to blockchain at fight end
 */

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
const bs58 = require('bs58'); 
const { 
  Program, 
  AnchorProvider, 
  Wallet,
  BN,
  web3
} = require('@coral-xyz/anchor');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Configuration
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const COIN_ADDRESS = process.env.COIN_ADDRESS || '';
const TRIGGER_KEYWORDS = (process.env.TRIGGER_KEYWORDS || 'HIT,■■').split(',').map(s => s.trim()).filter(Boolean);
const HEAL_KEYWORDS = (process.env.HEAL_KEYWORDS || 'HEAL,❤■').split(',').map(s => s.trim()).filter(Boolean);
const INITIAL_HP = process.env.INITIAL_HP ? Number(process.env.INITIAL_HP) : 30;
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, 'exports');
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const AUTHORITY_KEYPAIR_PATH = process.env.AUTHORITY_KEYPAIR_PATH ;
const TREASURY_WALLET = process.env.TREASURY_WALLET;
const PROGRAM_ID_STR = process.env.PROGRAM_ID || 'FtQbMDA7w8a9icfbMkuTxxQ695Wp9e6RQFSGVjmYQgz3';
const FEE_PERCENTAGE = process.env.FEE_PERCENTAGE ? Number(process.env.FEE_PERCENTAGE) : 5;
const BETTING_DURATION = 60; // seconds
const FIGHT_DURATION = 60;   // seconds
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'aaa';
const ADMIN_WALLET = process.env.ADMIN_WALLET;

const { PumpChatClient } = require('pump-chat-client');

if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

// Validate required environment variables
if (!TREASURY_WALLET) {
  console.error('TREASURY_WALLET environment variable is required');
  process.exit(1);
}

function getAnchorDiscriminator(name) {
  const hash = crypto.createHash('sha256').update(`account:${name}`).digest();
  return hash.slice(0, 8);
}

const BET_ACCOUNT_DISCRIMINATOR = getAnchorDiscriminator('BetAccount');

// Load authority keypair with better error handling
let authorityKeypair;
try {
  if (AUTHORITY_KEYPAIR_PATH && fs.existsSync(AUTHORITY_KEYPAIR_PATH)) {
    authorityKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(AUTHORITY_KEYPAIR_PATH, 'utf8')))
    );
    console.log('Authority keypair loaded from:', AUTHORITY_KEYPAIR_PATH);
  } else {
    console.warn('AUTHORITY_KEYPAIR_PATH not found, generating temporary keypair for demo');
    authorityKeypair = Keypair.generate();
    console.log('Generated temporary authority:', authorityKeypair.publicKey.toString());
    console.log('Note: This is for demo purposes only. In production, use a persistent keypair.');
  }
} catch (error) {
  console.error('Error loading authority keypair:', error.message);
  console.log('Generating temporary keypair for demo purposes...');
  authorityKeypair = Keypair.generate();
  console.log('Generated temporary authority:', authorityKeypair.publicKey.toString());
}

// Solana connection and program setup
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const wallet = new Wallet(authorityKeypair);
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
const programId = new PublicKey(PROGRAM_ID_STR);
const treasuryPubkey = new PublicKey(TREASURY_WALLET);

// Load IDL
const idl = JSON.parse(fs.readFileSync(path.join(__dirname, 'target', 'idl_new.json'), 'utf8'));
const program = new Program(idl, provider);

// Game phases
const GAME_PHASES = {
  IDLE: 'idle',
  BETTING: 'betting',
  FIGHTING: 'fighting',
  ENDED: 'ended'
};

// In-memory state
let gamePhase = GAME_PHASES.IDLE;
let currentRoundId = 0;
let bossHP = INITIAL_HP;
let userHits = new Map(); // username -> hits
let chronological = []; // {username, msg, timestamp, delta}
let lastHitter = null;
let totalHits = 0;
let clientsCount = 0;
let pumpSocket = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;
const reconnectInterval = 5000;

// Game timing
let bettingEndTime = null;
let fightEndTime = null;
let gameTimer = null;

// Blockchain state
let bettingRoundPDA = null;
let escrowPDA = null;
let onChainBets = new Map(); // walletAddress -> bet info
let totalDeathBets = 0;
let totalSurvivalBets = 0;
let isConnecting = false;
let isConnected = false;

// Serve static overlay page and assets
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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
    bettingEndTime,
    fightEndTime,
    totalDeathBets: totalDeathBets / LAMPORTS_PER_SOL,
    totalSurvivalBets: totalSurvivalBets / LAMPORTS_PER_SOL,
    totalBets: onChainBets.size
  });
});

app.get('/api/betting-round/:roundId', async (req, res) => {
  try {
    const roundId = parseInt(req.params.roundId);
    const [bettingRoundPDA] = getBettingRoundPDA(roundId);
    
    const bettingRoundAccount = await program.account.bettingRound.fetch(bettingRoundPDA);
    
    res.json({
      roundId,
      phase: Object.keys(bettingRoundAccount.phase)[0],
      currentHp: bettingRoundAccount.currentHp,
      initialHp: bettingRoundAccount.initialHp,
      totalDeathBets: bettingRoundAccount.totalDeathBets.toNumber() / LAMPORTS_PER_SOL,
      totalSurvivalBets: bettingRoundAccount.totalSurvivalBets.toNumber() / LAMPORTS_PER_SOL,
      totalBetsCount: bettingRoundAccount.totalBetsCount.toNumber(),
      bossDefeated: bettingRoundAccount.bossDefeated,
      bettingEndTime: bettingRoundAccount.bettingEndTime.toNumber() * 1000,
      fightEndTime: bettingRoundAccount.fightEndTime.toNumber() * 1000
    });
  } catch (error) {
    console.error('Error fetching betting round:', error);
    res.status(404).json({ error: 'Betting round not found' });
  }
});

app.post('/api/bet-notification', (req, res) => {
  try {
    const { walletAddress, username, amount, prediction, signature } = req.body;
    
    console.log(`Bet notification received: ${username} (${walletAddress}) bet ${amount} SOL on ${prediction}`);
    
    onChainBets.set(walletAddress, {
      username,
      amount: amount * LAMPORTS_PER_SOL,
      prediction,
      signature,
      timestamp: Date.now()
    });
    
    if (prediction === 'death') {
      totalDeathBets += amount * LAMPORTS_PER_SOL;
    } else {
      totalSurvivalBets += amount * LAMPORTS_PER_SOL;
    }
    
    io.emit('betting_update', {
      totalDeathBets: totalDeathBets / LAMPORTS_PER_SOL,
      totalSurvivalBets: totalSurvivalBets / LAMPORTS_PER_SOL,
      totalBets: onChainBets.size
    });
    
    res.json({ success: true, message: 'Bet notification received' });
  } catch (error) {
    console.error('Error processing bet notification:', error);
    res.status(500).json({ error: 'Error processing bet notification' });
  }
});

app.get('/api/current-round', (req, res) => {
  res.json({
    gamePhase,
    currentRoundId,
    programId: PROGRAM_ID_STR,
    bettingRoundPDA: bettingRoundPDA ? bettingRoundPDA.toString() : null,
    escrowPDA: escrowPDA ? escrowPDA.toString() : null,
    bettingEndTime,
    fightEndTime,
    totalDeathBets: totalDeathBets / LAMPORTS_PER_SOL,
    totalSurvivalBets: totalSurvivalBets / LAMPORTS_PER_SOL,
    totalBets: onChainBets.size
  });
});

app.post('/api/place-bet', async (req, res) => {
  try {
    const { walletAddress, username, amount, prediction } = req.body;
    
    if (gamePhase !== GAME_PHASES.BETTING) {
      return res.status(400).json({ error: 'Not in betting phase' });
    }
    
    if (!currentRoundId) {
      return res.status(400).json({ error: 'No active betting round' });
    }
    
    const bettor = new PublicKey(walletAddress);
    const [betPDA] = getBetPDA(currentRoundId, bettor);
    const amountLamports = Math.floor(amount * LAMPORTS_PER_SOL);
    
    try {
      await program.account.betAccount.fetch(betPDA);
      return res.status(400).json({ error: 'Bet already placed for this round' });
    } catch (err) {
      // Bet doesn't exist, which is what we want
    }
    
    const predictionEnum = prediction === 'death' ? { death: {} } : { survival: {} };
    
    const tx = await program.methods
      .placeBet(new BN(amountLamports), predictionEnum, username)
      .accounts({
        bettingRound: bettingRoundPDA,
        betAccount: betPDA,
        escrow: escrowPDA,
        bettor: bettor,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    
    // Get FRESH blockhash - this makes each transaction unique
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = bettor;
    
    const serializedTx = tx.serialize({ 
      requireAllSignatures: false,
      verifySignatures: false 
    });
    const base64Tx = serializedTx.toString('base64');
    
    res.json({
      success: true,
      transaction: base64Tx,
      blockhash: blockhash, // Send blockhash to client
      lastValidBlockHeight: lastValidBlockHeight,
      message: 'Transaction prepared for signing'
    });
    
  } catch (error) {
    console.error('Error preparing bet transaction:', error);
    res.status(500).json({ error: 'Error preparing bet transaction' });
  }
});

app.get('/api/bet-status/:walletAddress/:roundId', async (req, res) => {
  try {
    const { walletAddress, roundId } = req.params;
    const bettor = new PublicKey(walletAddress);
    const [betPDA] = getBetPDA(parseInt(roundId), bettor);
    
    try {
      const betAccount = await program.account.betAccount.fetch(betPDA);
      res.json({
        exists: true,
        amount: betAccount.amount.toNumber() / LAMPORTS_PER_SOL,
        prediction: Object.keys(betAccount.prediction)[0],
        username: betAccount.username,
        payoutClaimed: betAccount.payoutClaimed,
        timestamp: betAccount.timestamp.toNumber()
      });
    } catch (error) {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error('Error checking bet status:', error);
    res.status(500).json({ error: 'Error checking bet status' });
  }
});

app.get('/test', (req, res) => {
  const user = req.query.user || 'tester';
  const msg = req.query.msg || 'HIT';
  if (gamePhase === GAME_PHASES.FIGHTING) {
    handleChatMessage(user, msg, Date.now());
  }
  res.json({ ok: true, user, msg, gamePhase });
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
    totalDeathBets: totalDeathBets / LAMPORTS_PER_SOL,
    totalSurvivalBets: totalSurvivalBets / LAMPORTS_PER_SOL,
    totalBets: onChainBets.size,
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
    console.log(data)
    if (data && data.adminKey === ADMIN_SECRET && data.walletAddress == ADMIN_WALLET) {
      startBettingPhase();
    } else {
      socket.emit('admin:error', { message: 'Unauthorized' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Overlay page: http://localhost:${PORT}/overlay.html`);
  console.log(`Authority: ${authorityKeypair.publicKey.toString()}`);
  console.log(`Treasury: ${TREASURY_WALLET}`);
  console.log(`Program ID: ${PROGRAM_ID_STR}`);
  console.log(`Trigger keywords: ${TRIGGER_KEYWORDS.join(', ')}`);
  console.log(`Heal keywords: ${HEAL_KEYWORDS.join(', ')}`);
  
  connectToPumpFun();
});

function connectToPumpFun() {
  if (!COIN_ADDRESS) {
    console.warn('No COIN_ADDRESS configured. Set this environment variable to monitor a specific coin.');
    return;
  }

  // Prevent multiple simultaneous connections
  if (isConnecting || isConnected) {
    console.log('Already connected or connecting to pump.fun chat');
    return;
  }

  isConnecting = true;
  console.log('Connecting to pump.fun chat via pump-chat-client');
  console.log('Monitoring coin:', COIN_ADDRESS);
  
  // Close existing connection if any
  if (pumpSocket) {
    try {
      pumpSocket.disconnect();
    } catch (e) {
      // Ignore errors on disconnect
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
      // Add delay before reconnecting to prevent rapid reconnection loops
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

function getEscrowPDA(roundId) {
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
    currentRoundId = Date.now();
    
    const [bettingRoundPDAResult] = getBettingRoundPDA(currentRoundId);
    const [escrowPDAResult] = getEscrowPDA(currentRoundId);
    bettingRoundPDA = bettingRoundPDAResult;
    escrowPDA = escrowPDAResult;
    
    if (program) {
      console.log('Initializing betting round on blockchain...');
      const authorityPubkey = authorityKeypair.publicKey.toBase58();
      console.log("Authority Public Key:", authorityPubkey);
      
      const tx = await program.methods
        .initializeBettingRound(
          new BN(currentRoundId),
          new BN(BETTING_DURATION),
          new BN(FIGHT_DURATION),
          INITIAL_HP,
          FEE_PERCENTAGE
        )
        .accounts({
          bettingRound: bettingRoundPDA,
          escrow: escrowPDA,
          authority: authorityKeypair.publicKey,
          treasury: treasuryPubkey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authorityKeypair])
        .rpc();
      
      console.log('Betting round initialized on blockchain:', tx);
    }
    
    gamePhase = GAME_PHASES.BETTING;
    bettingEndTime = Date.now() + (BETTING_DURATION * 1000);
    
    console.log('Betting phase started! Users have 1 minute to place bets.');
    
    io.emit('phase_change', {
      gamePhase,
      currentRoundId,
      timeRemaining: BETTING_DURATION * 1000,
      message: 'Betting phase started! Place your bets on boss death or survival!',
      bettingRoundPDA: bettingRoundPDA.toString(),
      escrowPDA: escrowPDA.toString()
    });
    
    gameTimer = setTimeout(() => {
      startFightingPhase();
    }, BETTING_DURATION * 1000);
    
  } catch (error) {
    console.error('Error starting betting phase:', error);
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
    
    console.log('Fighting phase started! Apex Gauntlet begins now.');
    
    io.emit('phase_change', {
      gamePhase,
      timeRemaining: FIGHT_DURATION * 1000,
      message: 'Apex Gauntlet started! You have 1 minute to defeat the boss!'
    });
    
    gameTimer = setTimeout(() => {
      endFight('timeout');
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
    if (!bettingRoundPDA || !program) return;
    
    const bettingRoundAccount = await program.account.bettingRound.fetch(bettingRoundPDA);
    
    totalDeathBets = bettingRoundAccount.totalDeathBets.toNumber();
    totalSurvivalBets = bettingRoundAccount.totalSurvivalBets.toNumber();
    
    console.log(`Loaded betting data - Death: ${totalDeathBets / LAMPORTS_PER_SOL} SOL, Survival: ${totalSurvivalBets / LAMPORTS_PER_SOL} SOL`);
    console.log(`Total bets count: ${bettingRoundAccount.totalBetsCount.toNumber()}`);
    
    const roundIdBuffer = bettingRoundAccount.roundId.toArrayLike(Buffer, 'le', 8);

    const betAccounts = await connection.getProgramAccounts(programId, {
      filters: [
        {
          memcmp: {
            offset: 0, 
            bytes: bs58.encode(BET_ACCOUNT_DISCRIMINATOR),
          }
        },
        {
          memcmp: {
            offset: 40, 
            bytes: bs58.encode(roundIdBuffer),
          }
        }
      ]
    });
    
    console.log(`Found ${betAccounts.length} bet accounts on-chain`);
    
    onChainBets.clear();
    for (const { pubkey, account } of betAccounts) {
      try {
        const betData = await program.account.betAccount.fetch(pubkey);
        onChainBets.set(betData.bettor.toString(), {
          username: betData.username,
          amount: betData.amount.toNumber(),
          prediction: Object.keys(betData.prediction)[0],
          timestamp: betData.timestamp.toNumber()
        });
      } catch (err) {
        console.error('Error parsing bet account:', err);
      }
    }
    
    io.emit('betting_update', {
      totalDeathBets: totalDeathBets / LAMPORTS_PER_SOL,
      totalSurvivalBets: totalSurvivalBets / LAMPORTS_PER_SOL,
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
  }
}, 100);

async function claimFees() {
  if (!bettingRoundPDA || !escrowPDA || !program) return;
  
  try {
    console.log('Claiming fees from escrow...');
    
    const tx = await program.methods
      .claimFees()
      .accounts({
        bettingRound: bettingRoundPDA,
        escrow: escrowPDA,
        treasury: treasuryPubkey,
        authority: authorityKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
      
    console.log('Fees claimed successfully:', tx);
  } catch (error) {
    console.error('Error claiming fees:', error);
  }
}

async function processPayouts() {
  if (!bettingRoundPDA || !program) {
    console.log('Cannot process payouts - no active round or program not loaded');
    return;
  }
  
  try {
    console.log('Processing payouts...');
    
    const bettingRoundAccount = await program.account.bettingRound.fetch(bettingRoundPDA);
    
    const bossDefeated = bettingRoundAccount.bossDefeated;
    const totalDeathBetsLamports = bettingRoundAccount.totalDeathBets.toNumber();
    const totalSurvivalBetsLamports = bettingRoundAccount.totalSurvivalBets.toNumber();
    
    const winningPrediction = bossDefeated ? 'death' : 'survival';
    const totalWinnerBets = bossDefeated ? totalDeathBetsLamports : totalSurvivalBetsLamports;
    const totalLoserBets = bossDefeated ? totalSurvivalBetsLamports : totalDeathBetsLamports;
    
    console.log(`Boss ${bossDefeated ? 'defeated' : 'survived'}`);
    console.log(`Winning side: ${winningPrediction}`);
    console.log(`Total winner bets: ${totalWinnerBets / LAMPORTS_PER_SOL} SOL`);
    console.log(`Total loser bets (prize pool): ${totalLoserBets / LAMPORTS_PER_SOL} SOL`);
    
    if (totalWinnerBets === 0) {
      console.log('No winners - claiming fees only.');
      await claimFees(); 
      return;
    }
    
    const roundIdBuffer = bettingRoundAccount.roundId.toArrayLike(Buffer, 'le', 8);

    const betAccounts = await connection.getProgramAccounts(programId, {
      filters: [
        {
          memcmp: {
            offset: 0, 
            bytes: bs58.encode(BET_ACCOUNT_DISCRIMINATOR),
          }
        },
        {
          memcmp: {
            offset: 40, 
            bytes: bs58.encode(roundIdBuffer),
          }
        }
      ]
    });
    
    console.log(`Found ${betAccounts.length} bet accounts to process`);
    
    const payoutResults = [];
    
    for (const { pubkey, account } of betAccounts) {
      try {
        const betData = await program.account.betAccount.fetch(pubkey);
        const betPrediction = Object.keys(betData.prediction)[0];
        const betAmount = betData.amount.toNumber();
        const bettor = betData.bettor;
        
        if (betPrediction === winningPrediction) {
          const feeAmount = Math.floor(totalLoserBets * bettingRoundAccount.feePercentage / 100);
          const prizePool = totalLoserBets - feeAmount;
          const prizeShare = Math.floor((prizePool * betAmount) / totalWinnerBets);
          const totalPayout = betAmount + prizeShare;
          
          console.log(`Winner: ${betData.username} - Bet: ${betAmount / LAMPORTS_PER_SOL} SOL, Prize: ${prizeShare / LAMPORTS_PER_SOL} SOL, Total: ${totalPayout / LAMPORTS_PER_SOL} SOL`);
          
          try {
            const tx = await program.methods
              .claimPayout()
              .accounts({
                bettingRound: bettingRoundPDA,
                betAccount: pubkey,
                escrow: escrowPDA,
                bettor: bettor,
                authority: authorityKeypair.publicKey,
                systemProgram: SystemProgram.programId,
              })
              .rpc();
            
            console.log(`Payout processed for ${betData.username}: ${tx}`);
            
            payoutResults.push({
              username: betData.username,
              wallet: bettor.toString(),
              betAmount: betAmount / LAMPORTS_PER_SOL,
              prizeShare: prizeShare / LAMPORTS_PER_SOL,
              totalPayout: totalPayout / LAMPORTS_PER_SOL,
              signature: tx
            });
          } catch (payoutError) {
            console.error(`Error processing payout for ${betData.username}:`, payoutError.message);
          }
        } else {
          console.log(`Loser: ${betData.username} - Lost ${betAmount / LAMPORTS_PER_SOL} SOL`);
        }
      } catch (err) {
        console.error('Error processing bet account:', err);
      }
    }
    
    await claimFees();

    io.emit('payouts_processed', {
      bossDefeated,
      winningPrediction,
      totalPrizePool: totalLoserBets / LAMPORTS_PER_SOL,
      totalWinnerBets: totalWinnerBets / LAMPORTS_PER_SOL,
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

async function endFight(reason = 'defeated') {
  if (gamePhase !== GAME_PHASES.FIGHTING) return;
  
  try {
    clearTimeout(gameTimer);
    
    const bossDefeated = (reason === 'defeated' || bossHP === 0);
    
    console.log(`Ending fight: ${reason}. Boss ${bossDefeated ? 'defeated' : 'survived'}`);
    console.log(`Final HP: ${bossHP}/${INITIAL_HP}`);
    
    if (program) {
      console.log('Ending fight on blockchain with final HP...');
      
      const tx = await program.methods
        .endFight()
        .accounts({
          bettingRound: bettingRoundPDA,
          authority: authorityKeypair.publicKey,
        })
        .rpc();
      
      console.log('Fight ended on blockchain:', tx);
      await processPayouts();
    }
    
    gamePhase = GAME_PHASES.ENDED;
    
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
  escrowPDA = null;
  
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

/**
 * Message handling & game logic (only during fighting phase)
 * HP is tracked client-side only - no RPC calls here!
 */
async function handleChatMessage(username, message, timestamp = Date.now()) {
  if (gamePhase !== GAME_PHASES.FIGHTING) return;

  const text = (message || '').toUpperCase();
  let delta = 0;
  
  // 1. Check for ANY 'HIT' keyword presence
  const hasHitKeyword = TRIGGER_KEYWORDS.some(k => 
    k && text.includes(k.toUpperCase())
  );
  
  // 2. Check for ANY 'HEAL' keyword presence
  const hasHealKeyword = HEAL_KEYWORDS.some(k => 
    k && text.includes(k.toUpperCase())
  );

  // 3. Determine the final delta (exactly -1, +1, or 0)
  if (hasHitKeyword && !hasHealKeyword) {
    // Only hit keywords found: Deal exactly 1 damage
    delta = -1;
  } else if (hasHealKeyword && !hasHitKeyword) {
    // Only heal keywords found: Heal exactly 1 HP
    delta = 1;
  } 
  // If both or neither are present, delta remains 0, and the function will return early.


  if (delta === 0) return; // Exit if no valid, unambiguous command was found

  // The rest of the logic uses the calculated delta (-1 or +1)
  const hitsDelta = Math.abs(delta); // This will always be 1 now
  
  // Update user statistics and logging
  if (delta < 0) {
    totalHits += hitsDelta; // Adds 1
    const prev = userHits.get(username) || 0;
    userHits.set(username, prev + hitsDelta); // Adds 1
    lastHitter = username;
    console.log(`${username} dealt ${hitsDelta} damage! Boss HP: ${Math.max(0, bossHP + delta)}/${INITIAL_HP}`);
  } else {
    // Delta is 1 (Heal)
    console.log(`${username} healed ${hitsDelta} HP! Boss HP: ${Math.min(INITIAL_HP, bossHP + delta)}/${INITIAL_HP}`);
  }

  chronological.push({ username, message, timestamp, delta });

  // Update the boss's HP, clamped between 0 and INITIAL_HP
  bossHP = Math.max(0, Math.min(INITIAL_HP, bossHP + delta));
  
  // Emit the update event
  io.emit('update', {
    bossHP,
    maxHP: INITIAL_HP,
    top: getTop(3),
    lastHitter,
    latest: chronological[chronological.length - 1],
    timeRemaining: Math.max(0, fightEndTime - Date.now())
  });
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
    totalDeathBets: totalDeathBets / LAMPORTS_PER_SOL,
    totalSurvivalBets: totalSurvivalBets / LAMPORTS_PER_SOL,
    coinAddress: COIN_ADDRESS,
    programId: PROGRAM_ID_STR,
    bettingRoundPDA: bettingRoundPDA ? bettingRoundPDA.toString() : null,
    timestamp: formatISO(new Date())
  };
}

async function exportResults(results) {
  const t = new Date();
  const baseName = `bossfight_${COIN_ADDRESS}_${currentRoundId}_${t.getTime()}`;
  
  const jsonPath = path.join(EXPORT_DIR, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
  console.log('Results exported to:', jsonPath);

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

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\          console.log(`Winner: ${betData.username} - Bet: ${bet');
}

process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  if (gameTimer) clearTimeout(gameTimer);
  if (pumpSocket && pumpSocket.readyState === WebSocket.OPEN) {
    pumpSocket.close();
  }
  process.exit(0);
});