
import net from 'net';

const port = 3001;
const host = 'localhost';
const timeout = 30000; // 30 seconds
const start = Date.now();

function tryConnection() {
    if (Date.now() - start > timeout) {
        console.error(`[waitForBackend] Timeout after ${timeout}ms waiting for ${host}:${port}`);
        process.exit(1);
    }

    const socket = new net.Socket();

    socket.on('connect', () => {
        console.log(`[waitForBackend] Backend is ready on ${host}:${port}!`);
        socket.destroy();
        process.exit(0);
    });

    socket.on('error', (err) => {
        socket.destroy();
        setTimeout(tryConnection, 1000);
    });

    socket.connect(port, host);
}

console.log(`[waitForBackend] Waiting for backend to start on ${host}:${port}...`);
tryConnection();
