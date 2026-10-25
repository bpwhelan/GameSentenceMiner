const fs = require("node:fs");
const path = require("node:path");

// Source-level checks and isolated render fixtures must follow the page's assets
// now that settings.html contains only the shell and control markup.
function readSettingsSource() {
  const directory = path.resolve(__dirname, "../..");
  const html = fs.readFileSync(path.join(directory, "settings.html"), "utf8");
  const read = (relative) => fs.readFileSync(path.join(directory, relative), "utf8");
  return {
    html,
    scripts: [...html.matchAll(/<script\b[^>]*\bsrc="(\.\/[^"\n]+)"[^>]*><\/script>/g)]
      .map((match) => read(match[1]))
      .join("\n"),
    styles: [...html.matchAll(/<link\b(?=[^>]*\brel="stylesheet")[^>]*\bhref="(\.\/[^"\n]+)"[^>]*>/g)]
      .map((match) => read(match[1]))
      .join("\n"),
  };
}

module.exports = { readSettingsSource };
