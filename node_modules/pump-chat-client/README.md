# pump-chat-client

A WebSocket client library for connecting to pump.fun token chat rooms. This library handles the socket.io protocol communication and provides an easy-to-use interface for reading chat messages.

## Installation

```bash
npm install pump-chat-client
```

## Usage

```typescript
import { PumpChatClient } from 'pump-chat-client';

// Create a new client instance
const client = new PumpChatClient({
  roomId: 'YOUR_TOKEN_ADDRESS',
  username: 'your-username',
  messageHistoryLimit: 100
});

// Set up event listeners
client.on('connected', () => {
  console.log('Connected to pump.fun chat!');
});

client.on('message', (message) => {
  console.log(`${message.username}: ${message.message}`);
});

client.on('messageHistory', (messages) => {
  console.log(`Received ${messages.length} historical messages`);
});

client.on('error', (error) => {
  console.error('Chat error:', error);
});

client.on('disconnected', () => {
  console.log('Disconnected from chat');
});

// Connect to the chat room
client.connect();

// Send a message (requires authentication)
client.sendMessage('Hello everyone!');

// Get stored messages
const messages = client.getMessages(10); // Get last 10 messages
const latestMessage = client.getLatestMessage();

// Disconnect when done
client.disconnect();
```

## Features

- **Automatic reconnection** with exponential backoff
- **Socket.io protocol support** with acknowledgment tracking
- **Message history** management with configurable limits
- **Event-driven architecture** using EventEmitter
- **TypeScript support** with full type definitions

## API

### Constructor Options

```typescript
interface PumpChatClientOptions {
  roomId: string;           // Token address/room ID
  username?: string;        // Username (default: 'anonymous')
  messageHistoryLimit?: number; // Max messages to store (default: 100)
}
```

### Events

- `connected` - Emitted when successfully connected
- `message` - Emitted when a new message is received
- `messageHistory` - Emitted when message history is received
- `error` - Emitted on connection or protocol errors
- `serverError` - Emitted on server-side errors
- `disconnected` - Emitted when disconnected
- `userLeft` - Emitted when a user leaves the chat
- `maxReconnectAttemptsReached` - Emitted after max reconnection attempts

### Methods

- `connect()` - Connect to the chat room
- `disconnect()` - Disconnect from the chat room
- `sendMessage(message: string)` - Send a message (requires authentication)
- `getMessages(limit?: number)` - Get stored messages
- `getLatestMessage()` - Get the most recent message
- `isActive()` - Check if connected

## Message Interface

```typescript
interface IMessage {
  id: string;
  roomId: string;
  username: string;
  userAddress: string;
  message: string;
  profile_image: string;
  timestamp: string;
  messageType: string;
  expiresAt: number;
}
```

## Authentication

Note: Sending messages requires authentication with pump.fun. You need to be logged in to pump.fun in a browser and have valid session cookies. Reading messages works without authentication.

## License

MIT