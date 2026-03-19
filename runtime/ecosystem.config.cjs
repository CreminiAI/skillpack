const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "skillpack",
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
