#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const electronBinary = require('electron');
const projectRoot = path.resolve(__dirname, '..');
const passthroughArgs = process.argv.slice(2);

const child = spawn(electronBinary, ['.', '--dev-chaos-update', ...passthroughArgs], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
        ...process.env,
        // Keep logs explicit while running destructive/failure scenarios.
        GSM_CHAOS_VERBOSE: '1',
    },
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 1);
});
