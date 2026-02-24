module.exports = {
  apps: [{
    name: 'barrier-control',
    script: 'dist/index.js',
    cwd: '/Users/skynet/operations/barrier-control',
    env: { NODE_ENV: 'production' },

    // Priority service — barriers depend on this
    max_restarts: 50,           // tolerate more restarts before giving up
    min_uptime: 5000,           // 5s min before considered "started"
    restart_delay: 1000,        // fast restart — barriers can't wait
    autorestart: true,
    kill_timeout: 3000,         // fast kill on restart
    max_memory_restart: '200M', // shouldn't use much, restart if leak
    exp_backoff_restart_delay: 100, // exponential backoff on crash loops

    // Logging
    error_file: '/Users/skynet/.pm2/logs/barrier-control-error.log',
    out_file: '/Users/skynet/.pm2/logs/barrier-control-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }]
};
