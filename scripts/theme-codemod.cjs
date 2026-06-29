// One-shot codemod: replace raw hex literals in the renderer styles.css with
// semantic --gsm-* theme tokens. Run with `--apply` to write; default is dry-run.
// Usage: node scripts/theme-codemod.cjs [--apply]
const fs = require("fs");
const path = require("path");

const FILE = path.resolve(__dirname, "../electron-src/renderer/src/styles.css");
const APPLY = process.argv.includes("--apply");

// Explicit overrides win over the heuristic. Keys are normalized 6-digit hex.
const OVERRIDES = {
  "#111827": "--gsm-on-accent-dark", // dark text on accent fills (selected checks)
  "#ffffff": "--gsm-text-on-accent",
  "#f4f8ff": "--gsm-text-on-accent",
  "#fff2f0": "--gsm-text-on-accent",
  "#eef3ff": "--gsm-text-on-accent",
  "#f0f6ed": "--gsm-text-on-accent",
  "#eef2f7": "--gsm-text-on-accent",
  "#f2f4f8": "--gsm-text-on-accent",
  "#edf3ff": "--gsm-text-on-accent",
  "#d8ffe3": "--gsm-success-text",
  "#d8e7ff": "--gsm-accent-text",
  "#ffe0d9": "--gsm-danger-text",
  "#fff0c8": "--gsm-warning-text",
  "#90ee90": "--gsm-success-text",
  "#a8ddb9": "--gsm-success-text",
  "#7fdbff": "--gsm-accent-text",
  "#d6a4ff": "--gsm-accent-text",
  "#f4d38a": "--gsm-warning-text",
  "#dec37a": "--gsm-warning-text",
  "#8c6d2f": "--gsm-warning-border", // dark amber, not red
  "#7a3f2f": "--gsm-danger-border", // dark red OCR/error border
};

function parse(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}
function lum([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function classify(hex) {
  if (OVERRIDES[hex]) return OVERRIDES[hex];
  const [r, g, b] = parse(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const L = lum([r, g, b]);

  // Low-chroma => neutral / blue-gray. Classify by luminance.
  if (chroma < 60) {
    if (L <= 30) return "--gsm-surface-0";
    if (L <= 47) return "--gsm-surface-1";
    if (L <= 62) return "--gsm-surface-2";
    if (L <= 95) return "--gsm-border-default";
    if (L <= 150) return "--gsm-text-muted";
    if (L <= 210) return "--gsm-text-secondary";
    return "--gsm-text-primary";
  }

  // Saturated => semantic colour. Pick family by hue.
  const isYellow = r >= 130 && g >= 95 && b < Math.min(r, g) - 25;
  const isRed = r === max && g < r - 30 && b < r - 20;
  const isGreen = g === max && g > r && g > b;
  const isBlue = b === max && (b - r > 15 || b - g > 0);

  let fam;
  if (isGreen) fam = "success";
  else if (isYellow) fam = "warning";
  else if (isRed) fam = "danger";
  else if (isBlue) fam = "accent";
  else fam = "accent"; // purple/cyan fall back to accent

  // Sub-role by luminance: bright => text/icon, dark => border, mid => fill.
  const suffix = L >= 175 ? "-text" : L <= 72 ? "-border" : "";
  if (fam === "accent") return "--gsm-accent" + suffix;
  return "--gsm-" + fam + suffix;
}

const src = fs.readFileSync(FILE, "utf8");

// Only operate below the token-definition header so we don't rewrite the
// bridge block itself. Marker is added by the styles.css edit; if absent
// (dry run before edit), operate on the whole file.
const MARKER = "/* @gsm-codemod-boundary */";
const idx = src.indexOf(MARKER);
const head = idx >= 0 ? src.slice(0, idx + MARKER.length) : "";
const body = idx >= 0 ? src.slice(idx + MARKER.length) : src;

const counts = {};
const samples = {};
const newBody = body.replace(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g, (m) => {
  let hex = m.toLowerCase();
  if (hex.length === 4) hex = "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  const token = classify(hex);
  counts[token] = (counts[token] || 0) + 1;
  (samples[token] = samples[token] || new Set()).add(hex);
  return `var(${token}, ${m})`;
});

if (APPLY) {
  fs.writeFileSync(FILE, head + newBody, "utf8");
  console.log("APPLIED. Replacements:", Object.values(counts).reduce((a, b) => a + b, 0));
} else {
  // Dry-run: print every distinct hex and its assigned token, grouped.
  const byToken = {};
  for (const [tok, set] of Object.entries(samples)) byToken[tok] = [...set].sort();
  for (const tok of Object.keys(byToken).sort()) {
    console.log(`\n${tok}  (${counts[tok]} refs, ${byToken[tok].length} colors)`);
    console.log("  " + byToken[tok].join(" "));
  }
}
