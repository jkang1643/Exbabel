
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

export async function spawnTestServer({ port = 3002, env = {}, artifactsDir } = {}) {
    const serverPath = path.resolve(process.cwd(), "server.js");

    // Merge default test env with provided env
    const testEnv = {
        ...process.env,
        PORT: port.toString(),
        NODE_ENV: "test",
        ...env,
    };

    console.log(`[Test] Spawning server on port ${port}...`);

    let logStream;
    if (artifactsDir) {
        const serverLogPath = path.join(artifactsDir, "server.log");
        logStream = fs.createWriteStream(serverLogPath, { flags: "a" });
    }

    const server = spawn("node", [serverPath], {
        env: testEnv,
        stdio: ["ignore", "pipe", "pipe"], // ignore stdin, pipe stdout/stderr
        detached: false,
    });

    server.stdout.on("data", (data) => {
        if (logStream) logStream.write(data);
        // console.log(`[Server stdout] ${data}`); // Uncomment for debug if needed
    });

    server.stderr.on("data", (data) => {
        if (logStream) logStream.write(data);
        console.error(`[Server stderr] ${data}`);
    });

    const baseUrl = `http://localhost:${port}`;

    // Wait for health check to pass
    await waitForHealthCheck(baseUrl);

    console.log(`[Test] Server is up at ${baseUrl}`);

    return { server, baseUrl };
}

export async function stopTestServer(server) {
    if (!server) return;
    console.log("[Test] Stopping server...");
    server.kill();
    // Give it a moment to die
    await new Promise((r) => setTimeout(r, 500));
}

async function waitForHealthCheck(baseUrl, maxWaitMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const res = await fetch(`${baseUrl}/health`);
            if (res.ok) return;
        } catch (e) {
            // ignore
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Server did not start within ${maxWaitMs}ms`);
}
