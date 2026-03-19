const path = require("node:path");
const fs = require("node:fs");

const fallbackName = path.basename(__dirname) || "skillpack";
let appName = fallbackName;

try {
  const skillpackPath = path.join(__dirname, "skillpack.json");
  if (fs.existsSync(skillpackPath)) {
    const parsed = JSON.parse(fs.readFileSync(skillpackPath, "utf-8"));
    if (typeof parsed.name === "string" && parsed.name.trim()) {
      appName = parsed.name.trim();
    }
  }
} catch (err) {
  console.warn("[PM2] Failed to read skillpack.json for app name:", err);
}

module.exports = {
  apps: [
    {
      name: appName,
      cwd: path.join(__dirname, "server"),
      script: "dist/index.js",
      autorestart: true,
      stop_exit_codes: [64],
      restart_delay: 1000,
      kill_timeout: 3000,
      env: {
        NODE_ENV: "production",
        PACK_ROOT: __dirname,
        SKILLPACK_PROCESS_MANAGER: "pm2",
      },
    },
  ],
};
