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
  ],
};
