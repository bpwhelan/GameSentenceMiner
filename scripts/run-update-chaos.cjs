#!/usr/bin/env node

const { launchElectron } = require('./electron-start.cjs');
const passthroughArgs = process.argv.slice(2);

launchElectron({
    args: ['--dev-chaos-update', ...passthroughArgs],
    env: {
        ...process.env,
        // Keep logs explicit while running destructive/failure scenarios.
        GSM_CHAOS_VERBOSE: '1',
    },
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
