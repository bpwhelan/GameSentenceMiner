import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pngToIco from "png-to-ico";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "..", "electron-src", "assets");
const BASE_ICON_PATH = path.join(ASSETS_DIR, "gsm.png");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const BADGE_SCALE = 0.34;
const BADGE_MARGIN_SCALE = 0.04;

const VARIANTS = [
  { name: "paused" },
  { name: "loading" },
  { name: "ready" },
];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function makeBadgeSvg(iconSize, variant) {
  const badgeSize = Math.round(iconSize * BADGE_SCALE);
  const radius = badgeSize / 2;
  const strokeWidth = Math.max(2, Math.round(badgeSize * 0.08));
  const cx = radius;
  const cy = radius;

  let inner = "";
  let fill = "#1f2937";

  if (variant === "paused") {
    fill = "#1f2937";
    const barWidth = badgeSize * 0.14;
    const barHeight = badgeSize * 0.42;
    const gap = badgeSize * 0.1;
    const leftX = cx - gap / 2 - barWidth;
    const rightX = cx + gap / 2;
    const y = cy - barHeight / 2;
    inner = `
      <rect x="${leftX}" y="${y}" width="${barWidth}" height="${barHeight}" rx="${barWidth * 0.25}" fill="#FFFFFF"/>
      <rect x="${rightX}" y="${y}" width="${barWidth}" height="${barHeight}" rx="${barWidth * 0.25}" fill="#FFFFFF"/>
    `;
  } else if (variant === "loading") {
    fill = "#1D4ED8";
    const r = badgeSize * 0.23;
    const arcStroke = Math.max(2, Math.round(badgeSize * 0.1));
    inner = `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#FFFFFF" stroke-width="${arcStroke}" stroke-linecap="round"
        stroke-dasharray="${Math.PI * 2 * r * 0.58} ${Math.PI * 2 * r * 0.42}"
        transform="rotate(-35 ${cx} ${cy})"/>
    `;
  } else if (variant === "ready") {
    fill = "#15803D";
    inner = `
      <path d="M ${badgeSize * 0.26} ${badgeSize * 0.54} L ${badgeSize * 0.42} ${badgeSize * 0.7} L ${badgeSize * 0.73} ${badgeSize * 0.34}"
        fill="none" stroke="#FFFFFF" stroke-width="${Math.max(2, badgeSize * 0.12)}" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  } else {
    throw new Error(`Unsupported badge variant: ${variant}`);
  }

  return Buffer.from(`
    <svg width="${badgeSize}" height="${badgeSize}" viewBox="0 0 ${badgeSize} ${badgeSize}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="${Math.max(1, Math.round(badgeSize * 0.04))}" stdDeviation="${Math.max(
            1,
            Math.round(badgeSize * 0.05)
          )}" flood-color="rgba(0,0,0,0.35)"/>
        </filter>
      </defs>
      <g filter="url(#shadow)">
        <circle cx="${cx}" cy="${cy}" r="${radius - strokeWidth / 2}" fill="${escapeXml(fill)}" fill-opacity="0.97"/>
        <circle cx="${cx}" cy="${cy}" r="${radius - strokeWidth / 2}" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="${strokeWidth}"/>
        ${inner}
      </g>
    </svg>
  `);
}

function makeCenterOverlaySvg(iconSize, variant) {
  const overlaySize = Math.round(iconSize * 0.68);
  const radius = overlaySize / 2;
  const cx = radius;
  const cy = radius;
  const strokeWidth = Math.max(1, Math.round(overlaySize * 0.08));

  let inner = "";
  let fill = "#1f2937";

  if (variant === "paused") {
    fill = "#C63B33";
    const barWidth = Math.max(2, overlaySize * 0.15);
    const barHeight = overlaySize * 0.46;
    const gap = overlaySize * 0.12;
    const leftX = cx - gap / 2 - barWidth;
    const rightX = cx + gap / 2;
    const y = cy - barHeight / 2;
    inner = `
      <rect x="${leftX}" y="${y}" width="${barWidth}" height="${barHeight}" rx="${Math.max(1, barWidth * 0.25)}" fill="#FFFFFF"/>
      <rect x="${rightX}" y="${y}" width="${barWidth}" height="${barHeight}" rx="${Math.max(1, barWidth * 0.25)}" fill="#FFFFFF"/>
    `;
  } else if (variant === "loading") {
    fill = "#1D4ED8";
    const r = overlaySize * 0.28;
    inner = `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#FFFFFF" stroke-width="${Math.max(2, overlaySize * 0.12)}" stroke-linecap="round"
        stroke-dasharray="${Math.PI * 2 * r * 0.56} ${Math.PI * 2 * r * 0.44}"
        transform="rotate(-40 ${cx} ${cy})"/>
    `;
  } else if (variant === "ready") {
    fill = "#15803D";
    inner = `
      <path d="M ${overlaySize * 0.26} ${overlaySize * 0.54} L ${overlaySize * 0.43} ${overlaySize * 0.71} L ${overlaySize * 0.74} ${overlaySize * 0.34}"
        fill="none" stroke="#FFFFFF" stroke-width="${Math.max(2, overlaySize * 0.14)}" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  } else {
    throw new Error(`Unsupported overlay variant: ${variant}`);
  }

  return Buffer.from(`
    <svg width="${overlaySize}" height="${overlaySize}" viewBox="0 0 ${overlaySize} ${overlaySize}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="${Math.max(1, Math.round(overlaySize * 0.03))}" stdDeviation="${Math.max(
            1,
            Math.round(overlaySize * 0.05)
          )}" flood-color="rgba(0,0,0,0.42)"/>
        </filter>
      </defs>
      <g filter="url(#shadow)">
        <circle cx="${cx}" cy="${cy}" r="${radius - strokeWidth / 2}" fill="${escapeXml(fill)}" fill-opacity="0.98"/>
        <circle cx="${cx}" cy="${cy}" r="${radius - strokeWidth / 2}" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="${strokeWidth}"/>
        ${inner}
      </g>
    </svg>
  `);
}

async function renderVariantBuffer(iconSize, variant) {
  const base = sharp(BASE_ICON_PATH).resize(iconSize, iconSize, { fit: "contain" });

  if (iconSize <= 32) {
    const overlaySize = Math.round(iconSize * 0.68);
    return await base
      .composite([
        {
          input: makeCenterOverlaySvg(iconSize, variant),
          left: Math.round((iconSize - overlaySize) / 2),
          top: Math.round((iconSize - overlaySize) / 2),
        },
      ])
      .png()
      .toBuffer();
  }

  const badgeSize = Math.round(iconSize * BADGE_SCALE);
  const margin = Math.round(iconSize * BADGE_MARGIN_SCALE);
  return await base
    .composite([
      {
        input: makeBadgeSvg(iconSize, variant),
        left: iconSize - badgeSize - margin,
        top: iconSize - badgeSize - margin,
      },
    ])
    .png()
    .toBuffer();
}

async function main() {
  await fs.access(BASE_ICON_PATH);

  const metadata = await sharp(BASE_ICON_PATH).metadata();
  const fullSize = Math.max(metadata.width ?? 0, metadata.height ?? 0);
  if (!fullSize) {
    throw new Error(`Unable to determine image size for ${BASE_ICON_PATH}`);
  }

  const generated = [];
  for (const variant of VARIANTS) {
    const pngPath = path.join(ASSETS_DIR, `gsm-${variant.name}.png`);
    const icoPath = path.join(ASSETS_DIR, `gsm-${variant.name}.ico`);

    const pngBuffer = await renderVariantBuffer(fullSize, variant.name);
    await fs.writeFile(pngPath, pngBuffer);

    const icoBuffers = await Promise.all(
      ICO_SIZES.map((size) => renderVariantBuffer(size, variant.name))
    );
    const icoBuffer = await pngToIco(icoBuffers);
    await fs.writeFile(icoPath, icoBuffer);

    generated.push(pngPath, icoPath);
  }

  console.log("Generated tray state icons:");
  for (const filePath of generated) {
    console.log(` - ${filePath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
