
import WebSocket from "ws";
import fetch from "node-fetch";

export async function connectWs(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.on("open", () => resolve(ws));
        ws.on("error", (err) => reject(new Error(`WebSocket connection failed to ${url}: ${err.message}`)));
    });
}

export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export async function waitForSettle(events, { idleMs = 1200, maxWaitMs = 30_000, debug = false } = {}) {
    const start = Date.now();
    let lastLen = events.length;
    let lastChange = Date.now();

    console.log(`[Test] Waiting for pipeline to settle (idle=${idleMs}ms)...`);

    while (Date.now() - start < maxWaitMs) {
        await sleep(200);

        if (events.length !== lastLen) {
            if (debug) console.log(`[Test] Events: ${events.length} (+${events.length - lastLen})`);
            lastLen = events.length;
            lastChange = Date.now();
        }

        if (Date.now() - lastChange >= idleMs) {
            console.log(`[Test] Pipeline settled after ${Date.now() - start}ms (Total events: ${events.length})`);
            return;
        }
    }


    throw new Error(`Pipeline did not settle in ${maxWaitMs}ms (events=${events.length})`);
}

/**
 * Creates a new session via HTTP POST
 * @param {string} baseUrl - e.g. "http://localhost:3002"
 * @returns {Promise<{sessionId: string, sessionCode: string, wsUrl: string}>}
 */
export async function createHostSession(baseUrl) {
    const res = await fetch(`${baseUrl}/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
    });

    if (!res.ok) {
        throw new Error(`Failed to create session: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    if (!data.success) {
        throw new Error(`Session creation failed: ${data.error}`);
    }

    return data;
}
