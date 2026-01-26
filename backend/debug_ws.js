import WebSocket from 'ws';

const testConnection = (url, name) => {
    console.log(`Testing connection to ${name} (${url})...`);
    const ws = new WebSocket(url);

    ws.on('open', () => {
        console.log(`[${name}] Connected successfully!`);
        ws.close();
    });

    ws.on('error', (err) => {
        console.error(`[${name}] Connection error:`, err.message);
    });

    ws.on('close', (code, reason) => {
        console.log(`[${name}] Connection closed. Code: ${code}, Reason: ${reason}`);
    });
};

// Test Direct Backend
testConnection('ws://localhost:3001/translate?role=listener&sessionId=test_session&targetLang=es&userName=DebugBot', 'Direct Backend');

// Test via Vite Proxy
testConnection('ws://localhost:3000/translate?role=listener&sessionId=test_session&targetLang=es&userName=DebugBot', 'Vite Proxy');
