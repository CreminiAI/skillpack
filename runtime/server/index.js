import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { registerRoutes } from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rootDir = process.env.PACK_ROOT || path.join(__dirname, "..");

const webDir = fs.existsSync(path.join(rootDir, "web"))
  ? path.join(rootDir, "web")
  : path.join(__dirname, "..", "web");

const app = express();
app.use(express.json());

// Static file serving
app.use(express.static(webDir));

const server = createServer(app);

// Register API routes
registerRoutes(app, server, rootDir);

const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PORT = 26313;

server.once("listening", () => {
  const address = server.address();
  const actualPort = typeof address === "string" ? address : address.port;
  const url = `http://${HOST}:${actualPort}`;
  console.log(`\n  Skills Pack Server`);
  console.log(`  Running at ${url}\n`);

  // Open the browser automatically
  const cmd =
    process.platform === "darwin"
      ? `open ${url}`
      : process.platform === "win32"
        ? `start ${url}`
        : `xdg-open ${url}`;
  exec(cmd, () => {});
});

function tryListen(port) {
  server.listen(port, HOST);

  server.once("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`  Port ${port} is in use, trying ${port + 1}...`);
      server.close();
      tryListen(port + 1);
    } else {
      throw err;
    }
  });
}

const startPort = Number(process.env.PORT) || DEFAULT_PORT;
tryListen(startPort);
