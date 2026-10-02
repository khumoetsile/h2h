// cPanel "Setup Node.js App" startup file (LiteSpeed/Passenger). It is loaded via
// require(), so this module graph must not use top-level await.
// Passenger loads this file instead of running `node src/server.js`, so the
// "am I the main module" check in server.js doesn't apply; start explicitly.
import { start } from './src/server.js';

start();
