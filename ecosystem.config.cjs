module.exports = {
  apps: [
    {
      name: "regen-market-monitor",
      script: "dist/index.js",
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
        PORT: "3099",
      },
      max_memory_restart: "256M",
      autorestart: true,
      watch: false,
    },
    {
      name: "trading-desk",
      script: "dist/trading-desk.js",
      node_args: "--enable-source-maps",
      cron_restart: "15 */4 * * *",  // every 4 hours at :15
      autorestart: false,             // one-shot: exit after scan
      env: {
        NODE_ENV: "production",
        POLYMARKET_DRY_RUN: "true",   // paper mode by default
        HYPERLIQUID_DRY_RUN: "true",
        GMX_DRY_RUN: "true",
      },
      max_memory_restart: "256M",
      watch: false,
    },
  ],
};
