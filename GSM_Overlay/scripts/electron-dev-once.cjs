const { spawn } = require("node:child_process");
const path = require("node:path");

const electronBinary = path.resolve(
  __dirname,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron"
);
const child = spawn(electronBinary, ["."], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  // For dev, closing Electron normally should end nodemon/concurrently.
  process.exit(code === 0 ? 1 : (code ?? 1));
});
