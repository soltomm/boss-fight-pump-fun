const { PumpChatClient } = require('pump-chat-client');

// 2. Adjust these for the desired load
const NUM_CONNECTIONS = 50; // How many concurrent users to simulate
const MESSAGES_PER_SECOND = 5; // How often *each* user sends a message
const COIN_ADDRESS = process.env.COIN_ADDRESS || '';

// The message format your server expects to process a hit
const TEST_MESSAGES = [
    // Simulate a hit message format for 'user1'
    JSON.stringify({
        type: 'message',
        data: {
            user: { username: 'user1' },
            text: 'HIT'
        }
    }),
    // Simulate a hit message format for 'user2'
    JSON.stringify({
        type: 'message',
        data: {
            user: { username: 'user2' },
            text: 'HIT'
        }
    }),
];

function createConnection(id) {
    pumpSocket = new PumpChatClient({
        roomId: COIN_ADDRESS
      });

    pumpSocket.on('open', () => {
        console.log(`Connection ${id} opened.`);
        
        // Start sending messages on an interval
        setInterval(() => {
            const message = TEST_MESSAGES[Math.floor(Math.random() * TEST_MESSAGES.length)];
            try {
                pumpSocket.send(message);
                // Console log this only for low loads, as it can be a bottleneck itself
                // console.log(`Connection ${id} sent message.`);
            } catch (e) {
                console.error(`Error sending message on ${id}:`, e.message);
            }
        }, 1000 / MESSAGES_PER_SECOND);
    });

    pumpSocket.on('error', (err) => {
        console.error(`Connection ${id} error:`, err.message);
    });

    pumpSocket.on('close', () => {
        console.log(`Connection ${id} closed. Reconnecting...`);
        // Simple reconnect logic for continuous stress
        setTimeout(() => createConnection(id), 5000);
    });
}

// Start all connections
for (let i = 1; i <= NUM_CONNECTIONS; i++) {
    createConnection(i);
}

console.log(`Starting load test with ${NUM_CONNECTIONS} connections, sending ~${NUM_CONNECTIONS * MESSAGES_PER_SECOND} messages/second...`);