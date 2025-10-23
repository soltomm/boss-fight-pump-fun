// overlay_load_test.js
const { io } = require("socket.io-client");

// 1. **CRITICAL:** Replace with the URL and Port of your server's Socket.IO instance
const SERVER_URL = 'http://localhost:3000'; 

// 2. Adjust for the desired load
const NUM_CLIENTS = 1000; // Simulate 1000 concurrent overlays

const clients = [];
let totalLatency = 0;
let messageCount = 0;
const startTimestamp = Date.now();

for (let i = 0; i < NUM_CLIENTS; i++) {
    const socket = io(SERVER_URL, {
        // Optional: reduce logging overhead
        transports: ['websocket'], 
        forceNew: true 
    });

    socket.on('connect', () => {
        // console.log(`Client ${i + 1} connected.`);
    });
    
    // The main event your server emits frequently
    socket.on('game_state', (data) => {
        const receivedTime = Date.now();
        
        // Calculate latency by tracking a 'sentTime' field added to your server's payload
        // NOTE: You must temporarily modify your server.js to add: data.sentTime = Date.now();
        const latency = receivedTime - (data.sentTime || startTimestamp); 
        
        totalLatency += latency;
        messageCount++;

        if (messageCount % 5000 === 0) {
            const avgLatency = (totalLatency / messageCount).toFixed(2);
            console.log(`Received ${messageCount} messages. Avg Latency: ${avgLatency}ms`);
        }
    });

    socket.on('disconnect', () => {
        // console.log(`Client ${i + 1} disconnected.`);
    });

    clients.push(socket);
}

console.log(`Simulating ${NUM_CLIENTS} concurrent overlay clients...`);

// Report final statistics after 30 seconds
setTimeout(() => {
    clients.forEach(c => c.disconnect());
    const finalAvgLatency = (totalLatency / messageCount).toFixed(2);
    const duration = (Date.now() - startTimestamp) / 1000;
    
    console.log('\n--- FINAL STRESS REPORT ---');
    console.log(`Duration: ${duration.toFixed(2)}s`);
    console.log(`Total Messages Received: ${messageCount}`);
    console.log(`Final Average Latency: ${finalAvgLatency}ms`);
    console.log('---------------------------');
}, 30000); // Test for 30 seconds