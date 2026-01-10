import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3001/translate/translate?role=solo');

ws.on('open', () => {
    console.log('✅ Connection opened successfully');
    process.exit(0);
});

ws.on('error', (err) => {
    console.error('❌ Connection failed:', err.message);
    process.exit(1);
});

setTimeout(() => {
    console.log('⌛ Connection timed out');
    process.exit(1);
}, 5000);
