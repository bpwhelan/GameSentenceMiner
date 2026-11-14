import fs from "node:fs/promises";
import path from "node:path";

const sourceDir = path.resolve("electron-src/assets");
const targetDir = path.resolve("electron-src/renderer/public/legacy");
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

async function main() {
  await fs.rm(targetDir, { recursive: true, force: true });
  // Only this remaining legacy editor is opened by the React renderer. Main
  // process windows use assets/ directly; copying those resources here embeds
  // native hooks, release videos and a second set of icons in every build.
  await fs.mkdir(targetDir, { recursive: true });
  for (const name of ['ocr_replacements.html', 'style.css', 'shared.js']) {
    const content = await fs.readFile(path.join(sourceDir, name), 'utf8');
    await fs.writeFile(path.join(targetDir, name), name.endsWith('.html') ? injectCsp(content) : content);
  }
}

main().catch((error) => {
  console.error("[sync-legacy-assets] Failed:", error);
  process.exit(1);
});
