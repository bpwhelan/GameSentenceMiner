const { launchElectron } = require('./electron-start.cjs');

launchElectron({ exitOnClose: true }).catch((error) => {
    console.error(error);
    process.exit(1);
});
