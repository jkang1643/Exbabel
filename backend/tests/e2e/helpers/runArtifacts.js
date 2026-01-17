// backend/tests/e2e/helpers/runArtifacts.js
import fs from "fs";
import path from "path";

export function createRunDir(testName = "e2e") {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.resolve(process.cwd(), "tests/e2e/artifacts", `${testName}-${ts}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function writeJsonl(filePath, rows) {
    fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function writeText(filePath, text) {
    fs.writeFileSync(filePath, text);
}
