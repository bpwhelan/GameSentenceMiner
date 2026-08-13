import fs from "node:fs/promises";
import path from "node:path";

const legacySourceDir = path.resolve("electron-src/assets");
const legacyTargetDir = path.resolve("electron-src/renderer/public/legacy");
const previewSourceDir = path.resolve(
  "electron-src/renderer/hoshidicts-preview"
);
const previewTargetDir = path.resolve(
  "electron-src/renderer/public/hoshidicts-preview"
);
const hoshidictsRuntimeDir = path.resolve(
  "GSM_Overlay/features/hoshidicts"
);
const hoshidictsRuntimeFiles = [
  "audio.js",
  "popup.js",
  "reader.js",
  "reader.css"
];
const htmlCspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' http://localhost:* ws://localhost:* https://localhost:*; frame-src 'self' http://localhost:* https://localhost:*; object-src 'none'; base-uri 'self';" />`;

function injectCsp(html) {
  if (/http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(html)) {
    return html;
  }

  const headMatch = html.match(/<head[^>]*>/i);
  if (!headMatch) {
    return html;
  }

  return html.replace(headMatch[0], `${headMatch[0]}\n    ${htmlCspMeta}`);
}

async function copyDirectory(source, target) {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);

      if (entry.isDirectory()) {
        await copyDirectory(sourcePath, targetPath);
        return;
      }

      if (path.extname(entry.name).toLowerCase() === ".html") {
        const html = await fs.readFile(sourcePath, "utf-8");
        const withCsp = injectCsp(html);
        await fs.writeFile(targetPath, withCsp, "utf-8");
        return;
      }

      await fs.copyFile(sourcePath, targetPath);
    })
  );
}

async function main() {
  await Promise.all([
    fs.rm(legacyTargetDir, { recursive: true, force: true }),
    fs.rm(previewTargetDir, { recursive: true, force: true })
  ]);
  await Promise.all([
    copyDirectory(legacySourceDir, legacyTargetDir),
    copyDirectory(previewSourceDir, previewTargetDir)
  ]);
  await Promise.all([
    ...hoshidictsRuntimeFiles.map((fileName) =>
      fs.copyFile(
        path.join(hoshidictsRuntimeDir, fileName),
        path.join(previewTargetDir, fileName)
      )
    ),
    copyDirectory(
      path.join(hoshidictsRuntimeDir, "icons"),
      path.join(previewTargetDir, "icons")
    )
  ]);
}

main().catch((error) => {
  console.error("[sync-legacy-assets] Failed:", error);
  process.exit(1);
});
