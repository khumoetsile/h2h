// cPanel "Setup Node.js App" (Phusion Passenger) startup file.
// Passenger loads this file instead of running `node src/server.js`, so the
// "am I the main module" check in server.js doesn't apply; start explicitly.
import { start } from './src/server.js';

await start();
