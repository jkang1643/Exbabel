/**
 * Load environment variables FIRST
 * This must be imported before anything else to ensure .env is loaded
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env
dotenv.config({ path: path.join(__dirname, '.env') });

console.log('[loadEnv] Environment loaded. ENABLE_XENOVA_GRAMMAR:', process.env.ENABLE_XENOVA_GRAMMAR);

