// PM2 runs the self-contained Go binary directly (no Node in the runtime path).
// The binary loads .env itself, so it must run from the repo root (start-pm2.sh
// cds there). `npm run deploy` builds dist/ then reloads this config.
module.exports = {
  apps: [
    {
      name: 'hycanvas-app',
      script: './dist/hycanvas',
      interpreter: 'none',
      exec_mode: 'fork',
      kill_timeout: 5000,
      env: {
        PORT: 8005,
      },
    },
  ],
};
