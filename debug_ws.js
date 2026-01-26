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

// Test via Vite Proxy (might fail if Vite is not running or behaving differently for non-browser clients, but worth a shot if we can hit localhost:3000)
// Note: Vite proxy usually requires the 'Origin' header to match, or changeOrigin in config handles it.
// We'll see.
testConnection('ws://localhost:3000/translate?role=listener&sessionId=test_session&targetLang=es&userName=DebugBot', 'Vite Proxy');
