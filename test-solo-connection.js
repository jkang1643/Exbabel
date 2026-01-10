import WebSocket from 'ws';

const url = 'ws://127.0.0.1:3001/translate';
console.log(`Connecting to: ${url}`);

const ws = new WebSocket(url);

ws.on('open', () => {
    console.log('✅ Connection opened successfully');
    // Keep open for a bit to ensure it doesn't close immediately
    setTimeout(() => {
        console.log('Closing connection...');
        ws.close();
        process.exit(0);
    }, 2000);
});

ws.on('error', (err) => {
    console.error('❌ Connection failed:', err.message);
    process.exit(1);
});

ws.on('close', (code, reason) => {
    console.log(`Connection closed: ${code} ${reason}`);
    if (code !== 1000) process.exit(1);
});
