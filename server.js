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
const PROGRAM_ID_STR = process.env.PROGRAM_ID || 'FtQbMDA7w8a9icfbMkuTxxQ695Wp9e6RQFSGVjmYQgz3';
const TOKEN_MINT_STR = COIN_ADDRESS
const FEE_PERCENTAGE = process.env.FEE_PERCENTAGE ? Number(process.env.FEE_PERCENTAGE) : 5;
const BETTING_DURATION = 60;
const FIGHT_DURATION = 60;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'aaa';
const ADMIN_WALLET = process.env.ADMIN_WALLET || '5GrJ4aUiQRc1frnxyv89ws27wPu2fxsgJvxHgLmEjBBq';

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

// Load authority keypair
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const tokenMint = new PublicKey(TOKEN_MINT_STR);
let authorityKeypair;

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
  console.log('🪙 Token mint:', TOKEN_MINT_STR);
  
  // Fetch token decimals
  getMint(connection, tokenMint, 'confirmed', TOKEN_PROGRAM_ID)
    .then(mintInfo => {
      tokenDecimals = mintInfo.decimals;
      console.log(`✅ Token decimals: ${tokenDecimals}`);
    })
    .catch(err => {
      console.error('Error fetching token mint info:', err.message);
    });
  
  connection.getBalance(authorityKeypair.publicKey).then(balance => {
    console.log('💰 Authority SOL balance:', balance / LAMPORTS_PER_SOL, 'SOL');
    
    if (balance < 0.01 * LAMPORTS_PER_SOL) {
      console.error('❌ INSUFFICIENT SOL BALANCE FOR FEES!');
      console.log('💸 Airdrop command:');
      console.log(`solana airdrop 5 ${authorityKeypair.publicKey.toString()} --url devnet`);
    }
  }).catch(err => {
    console.error('Error checking balance:', err.message);
  });
  
} catch (error) {
  console.error('❌ Error loading authority keypair:', error.message);
  process.exit(1);
}

// Solana connection and program setup
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
let userHits = new Map();
let chronological = [];
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
    tokenMint: TOKEN_MINT_STR, // NEW
    tokenDecimals, // NEW
    bettingEndTime,
    fightEndTime,
    totalDeathBets: fromBaseUnits(totalDeathBets),
    totalSurvivalBets: fromBaseUnits(totalSurvivalBets),
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
      totalDeathBets: fromBaseUnits(bettingRoundAccount.totalDeathBets.toNumber()),
      totalSurvivalBets: fromBaseUnits(bettingRoundAccount.totalSurvivalBets.toNumber()),
      totalBetsCount: bettingRoundAccount.totalBetsCount.toNumber(),
      bossDefeated: bettingRoundAccount.bossDefeated,
      bettingEndTime: bettingRoundAccount.bettingEndTime.toNumber() * 1000,
      fightEndTime: bettingRoundAccount.fightEndTime.toNumber() * 1000,
      tokenMint: bettingRoundAccount.tokenMint.toString() // NEW
    });
  } catch (error) {
    console.error('Error fetching betting round:', error);
    res.status(404).json({ error: 'Betting round not found' });
  }
});

app.post('/api/bet-notification', (req, res) => {
  try {
    const { walletAddress, username, amount, prediction, signature } = req.body;
    
    console.log(`Bet notification received: ${username} (${walletAddress}) bet ${amount} tokens on ${prediction}`);
    
    onChainBets.set(walletAddress, {
      username,
      amount: toBaseUnits(amount),
      prediction,
      signature,
      timestamp: Date.now()
    });
    
    if (prediction === 'death') {
      totalDeathBets += toBaseUnits(amount);
    } else {
      totalSurvivalBets += toBaseUnits(amount);
    }
    
    io.emit('betting_update', {
      totalDeathBets: fromBaseUnits(totalDeathBets),
      totalSurvivalBets: fromBaseUnits(totalSurvivalBets),
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
    tokenMint: TOKEN_MINT_STR, // NEW
    tokenDecimals, // NEW
    bettingRoundPDA: bettingRoundPDA ? bettingRoundPDA.toString() : null,
    escrowTokenAccountPDA: escrowTokenAccountPDA ? escrowTokenAccountPDA.toString() : null, // NEW: Changed name
    bettingEndTime,
    fightEndTime,
    totalDeathBets: fromBaseUnits(totalDeathBets),
    totalSurvivalBets: fromBaseUnits(totalSurvivalBets),
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
            console.warn(`Attempt ${attempts + 1} failed to fetch blockhash. Retrying...`, error.message);
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
    const { walletAddress, username, amount, prediction } = req.body;
    
    if (gamePhase !== GAME_PHASES.BETTING || !currentRoundId) {
      return res.status(400).json({ error: 'Betting is closed or no round is active' });
    }
    
    const bettor = new PublicKey(walletAddress);
    const [betPDA] = getBetPDA(currentRoundId, bettor);
    const amountInBaseUnits = toBaseUnits(amount);
    
    // Check for existing bet
    try {
      await program.account.betAccount.fetch(betPDA);
      return res.status(400).json({ error: 'Bet already placed for this round' });
    } catch (err) {
      // Bet doesn't exist, proceed
    }
    
    const predictionEnum = prediction === 'death' ? { death: {} } : { survival: {} };
    
    // NEW: Get bettor's token account (and create instruction if needed)
    const { address: bettorTokenAccount, instruction: createBettorTokenAccountIx } = 
      await ensureTokenAccount(connection, tokenMint, bettor, bettor);
    
    // Build transaction with token accounts
    const transaction = await program.methods
      .placeBet(new BN(amountInBaseUnits), predictionEnum, username)
      .accounts({
        bettingRound: bettingRoundPDA,
        betAccount: betPDA,
        escrowTokenAccount: escrowTokenAccountPDA, // NEW: Token escrow
        bettorTokenAccount: bettorTokenAccount, // NEW: User's token account
        bettor: bettor,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID, // NEW
      })
      .transaction();
    
    // Add create token account instruction if needed
    if (createBettorTokenAccountIx) {
      transaction.instructions.unshift(createBettorTokenAccountIx);
    }
    
    const { blockhash, lastValidBlockHeight } = await getRobustBlockhash(
      connection, 
      'processed'
    );
    
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = bettor;
    
    const serializedTx = transaction.serialize({ 
      requireAllSignatures: false,
      verifySignatures: false 
    });
    const base64Tx = serializedTx.toString('base64');
    
    res.json({
      success: true,
      transaction: base64Tx,
      blockhash: blockhash, 
      lastValidBlockHeight: lastValidBlockHeight,
      message: 'Transaction prepared for signing',
      tokenDecimals // NEW: Send decimals info
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
        amount: fromBaseUnits(betAccount.amount.toNumber()),
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
    totalDeathBets: fromBaseUnits(totalDeathBets),
    totalSurvivalBets: fromBaseUnits(totalSurvivalBets),
    totalBets: onChainBets.size,
    tokenMint: TOKEN_MINT_STR, // NEW
    tokenDecimals, // NEW
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
    console.log(ADMIN_SECRET)
    console.log(ADMIN_WALLET)
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
    fightEndingInProgress = false;
    fightEndCalled = false;
    currentRoundId = Date.now();
    
    const [bettingRoundPDAResult] = getBettingRoundPDA(currentRoundId);
    const [escrowTokenAccountPDAResult] = getEscrowTokenAccountPDA(currentRoundId); // NEW
    bettingRoundPDA = bettingRoundPDAResult;
    escrowTokenAccountPDA = escrowTokenAccountPDAResult; // NEW
    
    if (program) {
      console.log('Initializing betting round on blockchain...');
      
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
          escrowTokenAccount: escrowTokenAccountPDA, // NEW: Token escrow
          tokenMint: tokenMint, // NEW
          authority: authorityKeypair.publicKey,
          treasury: treasuryPubkey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID, // NEW
          rent: web3.SYSVAR_RENT_PUBKEY, // NEW
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
      escrowTokenAccountPDA: escrowTokenAccountPDA.toString(), // NEW
      tokenMint: TOKEN_MINT_STR, // NEW
      tokenDecimals // NEW
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
    if (!bettingRoundPDA || !program) return;
    
    const bettingRoundAccount = await program.account.bettingRound.fetch(bettingRoundPDA);
    
    totalDeathBets = bettingRoundAccount.totalDeathBets.toNumber();
    totalSurvivalBets = bettingRoundAccount.totalSurvivalBets.toNumber();
    
    console.log(`Loaded betting data - Death: ${fromBaseUnits(totalDeathBets)} tokens, Survival: ${fromBaseUnits(totalSurvivalBets)} tokens`);
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
      totalDeathBets: fromBaseUnits(totalDeathBets),
      totalSurvivalBets: fromBaseUnits(totalSurvivalBets),
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
  if (!bettingRoundPDA || !program) {
    console.log('Cannot process payouts - no active round or program not loaded');
    return;
  }
  
  try {
    console.log('Processing payouts...');
    
    const bettingRoundAccount = await program.account.bettingRound.fetch(bettingRoundPDA);
    
    const bossDefeated = bossHP === 0;
    const totalDeathBetsAmount = bettingRoundAccount.totalDeathBets.toNumber();
    const totalSurvivalBetsAmount = bettingRoundAccount.totalSurvivalBets.toNumber();
    
    const winningPrediction = bossDefeated ? 'death' : 'survival';
    const totalWinnerBets = bossDefeated ? totalDeathBetsAmount : totalSurvivalBetsAmount;
    const totalLoserBets = bossDefeated ? totalSurvivalBetsAmount : totalDeathBetsAmount;
    
    console.log(`Boss ${bossDefeated ? 'defeated' : 'survived'}`);
    console.log(`Winning side: ${winningPrediction}`);
    console.log(`Total winner bets: ${fromBaseUnits(totalWinnerBets)} tokens`);
    console.log(`Total loser bets (prize pool): ${fromBaseUnits(totalLoserBets)} tokens`);
    
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
          
          console.log(`Winner: ${betData.username} - Bet: ${fromBaseUnits(betAmount)} tokens, Prize: ${fromBaseUnits(prizeShare)} tokens, Total: ${fromBaseUnits(totalPayout)} tokens`);
          
          try {
            // NEW: Get bettor's token account
            const { address: bettorTokenAccount, instruction: createBettorTokenAccountIx } = 
              await ensureTokenAccount(connection, tokenMint, bettor, authorityKeypair.publicKey);
            
            const tx = await program.methods
              .claimPayout()
              .accounts({
                bettingRound: bettingRoundPDA,
                betAccount: pubkey,
                escrowTokenAccount: escrowTokenAccountPDA, // NEW
                bettorTokenAccount: bettorTokenAccount, // NEW
                bettor: bettor,
                authority: authorityKeypair.publicKey,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID, // NEW
              })
              .signers([authorityKeypair])
              .preInstructions(createBettorTokenAccountIx ? [createBettorTokenAccountIx] : [])
              .rpc();
            
            console.log(`Payout processed for ${betData.username}: ${tx}`);
            
            payoutResults.push({
              username: betData.username,
              wallet: bettor.toString(),
              betAmount: fromBaseUnits(betAmount),
              prizeShare: fromBaseUnits(prizeShare),
              totalPayout: fromBaseUnits(totalPayout),
              signature: tx
            });
          } catch (payoutError) {
            console.error(`Error processing payout for ${betData.username}:`, payoutError.message);
          }
        } else {
          console.log(`Loser: ${betData.username} - Lost ${fromBaseUnits(betAmount)} tokens`);
        }
      } catch (err) {
        console.error('Error processing bet account:', err);
      }
    }
    
    await claimFees();

    io.emit('payouts_processed', {
      bossDefeated,
      winningPrediction,
      totalPrizePool: fromBaseUnits(totalLoserBets),
      totalWinnerBets: fromBaseUnits(totalWinnerBets),
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
  //autoStartGameLoop();
  
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
    totalDeathBets: fromBaseUnits(totalDeathBets),
    totalSurvivalBets: fromBaseUnits(totalSurvivalBets),
    coinAddress: COIN_ADDRESS,
    programId: PROGRAM_ID_STR,
    tokenMint: TOKEN_MINT_STR, // NEW
    bettingRoundPDA: bettingRoundPDA ? bettingRoundPDA.toString() : null,
    escrowTokenAccountPDA: escrowTokenAccountPDA ? escrowTokenAccountPDA.toString() : null, // NEW
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

process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  if (gameTimer) clearTimeout(gameTimer);
  if (pumpSocket && pumpSocket.readyState === WebSocket.OPEN) {
    pumpSocket.close();
  }
  process.exit(0);
});