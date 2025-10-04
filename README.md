# Solana Boss Fight Betting

A real-time boss fight game with Solana-based betting integration. Players can bet on whether the boss will die or survive, then participate in a timed boss fight through pump.fun chat messages.

## Features

- **Betting Phase**: 1-minute betting window where users place SOL bets on boss death/survival
- **Timed Boss Fight**: 1-minute boss fight with real-time HP tracking
- **Automatic Payouts**: Winners share the losing bets pool proportionally
- **Real-time Updates**: WebSocket-based live updates for all participants
- **Pump.fun Integration**: Listens to pump.fun chat for game actions
- **Export Results**: JSON and CSV export of game results and betting data

## Game Flow

1. **Betting Phase** (1 minute)
   - Users connect their Solana wallets
   - Place bets on whether the boss will die or survive
   - View real-time betting pool totals

2. **Boss Fight Phase** (1 minute)
   - Boss fight begins automatically after betting ends
   - Players send trigger keywords in pump.fun chat to damage the boss
   - Real-time HP updates and leaderboard tracking

3. **Payout Phase**
   - Determine if boss was defeated or survived
   - Calculate payouts for winning bets
   - Distribute prizes proportionally based on bet amounts
   - Take configurable fee percentage

## Setup Instructions

### Prerequisites

- Node.js (v16 or higher)
- Solana wallet (Phantom recommended)
- pump.fun coin address to monitor

### Installation

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.template .env
   ```
   
   Edit `.env` with your configuration:
   ```env
   COIN_ADDRESS=your_pump_fun_coin_address
   TREASURY_WALLET=your_solana_wallet_address
   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
   FEE_PERCENTAGE=5
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

4. **Open the overlay:**
   Visit `http://localhost:3000/overlay.html`

### Required Environment Variables

- `COIN_ADDRESS`: The pump.fun coin address to monitor for chat messages
- `TREASURY_WALLET`: Your Solana wallet address to receive fees
- `SOLANA_RPC_URL`: Solana RPC endpoint (mainnet/devnet)

### Optional Environment Variables

- `PORT`: Server port (default: 3000)
- `TRIGGER_KEYWORDS`: Damage keywords (default: "HIT,■■")
- `HEAL_KEYWORDS`: Healing keywords (default: "HEAL,❤■")
- `INITIAL_HP`: Boss starting HP (default: 30)
- `FEE_PERCENTAGE`: Fee percentage on losing bets (default: 5%)
- `EXPORT_DIR`: Results export directory (default: ./exports)

## Usage

### For Players

1. **Connect Wallet**: Click "Connect Wallet" and approve the Phantom wallet connection
2. **Place Bets**: During the betting phase, enter your username and bet amount, then choose "Boss Dies" or "Boss Survives"
3. **Participate**: During the fight phase, send damage keywords in the pump.fun chat to attack the boss
4. **Collect Winnings**: If your prediction was correct, you'll receive your original bet plus a share of the prize pool

### For Administrators

Use the admin controls in the overlay to:
- **Start Betting Phase**: Begin a new betting round
- **Reset Game**: Clear all data and return to idle state

### API Endpoints

- `GET /status`: Get current game status