// http_load_test.js
const axios = require('axios');

// --- CONFIGURATION ---
const SERVER_URL = 'http://localhost:3000/test'; 
const CONCURRENT_REQUESTS = 500; // Number of simultaneous damage reports
const TOTAL_DURATION_MS = 30000; // 30 seconds
const HIT_MESSAGES = ['HIT', '■■', 'hit'];

// Helper to generate a unique 'user' for each request
function getRandomUser(index) {
    return `user_${(index % 200) + 1}`; // Cycle through 200 users
}

async function sendRequest(index) {
    const username = getRandomUser(index);
    const msg = HIT_MESSAGES[Math.floor(Math.random() * HIT_MESSAGES.length)];
    
    try {
        const response = await axios.get(SERVER_URL, {
            params: { user: username, msg: msg },
            timeout: 5000 // Timeout per request
        });
        
        if (response.status !== 200) {
            console.warn(`Request failed for ${username}: Status ${response.status}`);
        }
        return { success: true };
    } catch (error) {
        // Log critical errors only
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
             console.error(`CRITICAL: Server is down or unreachable: ${error.message}`);
        }
        return { success: false, error: error.message };
    }
}

async function runLoadTest() {
    console.log('--- Starting HTTP Load Test ---');
    console.log(`Target URL: ${SERVER_URL}`);
    console.log(`Concurrent Requests: ${CONCURRENT_REQUESTS}`);
    console.log(`Duration: ${TOTAL_DURATION_MS / 1000}s`);

    let requestsSent = 0;
    let successfulRequests = 0;
    let failedRequests = 0;

    const startTime = Date.now();

    // Main loop to keep the pressure on
    while (Date.now() - startTime < TOTAL_DURATION_MS) {
        const promises = [];
        for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
            // Send requests without waiting for previous ones to finish
            promises.push(sendRequest(requestsSent++));
        }

        const results = await Promise.all(promises);

        results.forEach(result => {
            if (result.success) {
                successfulRequests++;
            } else {
                failedRequests++;
            }
        });

        // Wait a short period to prevent a completely infinite loop on the host machine
        await new Promise(resolve => setTimeout(resolve, 50)); 
    }

    const duration = (Date.now() - startTime) / 1000;
    const RPS = (successfulRequests / duration).toFixed(2);

    console.log('\n--- Load Test Results ---');
    console.log(`Total Duration: ${duration}s`);
    console.log(`Total Requests Sent: ${requestsSent}`);
    console.log(`Successful Requests: ${successfulRequests}`);
    console.log(`Failed Requests (Server/Network Error): ${failedRequests}`);
    console.log(`Requests Per Second (RPS): ${RPS}`);
    console.log('---------------------------');
}

// Ensure your server is in the FIGHTING phase before running this test!
runLoadTest();