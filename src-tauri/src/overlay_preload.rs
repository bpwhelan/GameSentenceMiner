//! Pure-Rust WebView preload builders for GSM Overlay windows.
//!
//! Replaces `desktop-runtime/platform.cjs`'s `nodeIntegration: true` and `contextIsolation`
//! shims with an explicit, sandboxed browser module loader (`window.require`) and Tauri IPC
//! bridges while keeping upstream overlay/extension JS compatible.

use serde_json::json;
use std::fs;
use std::path::Path;

const PRELOAD_JS_TEMPLATE: &str = include_str!("../preloads/desktop_preload.js");
const FIND_IN_PAGE_JS: &str = include_str!("../preloads/find_in_page.js");
const OVERLAY_PRELOAD_JS: &str = include_str!("../../GSM_Overlay/preload.js");
const FIND_IN_PAGE_PRELOAD_JS: &str = include_str!("../../GSM_Overlay/find-in-page-preload.js");
const VN_GUIDE_PRELOAD_JS: &str = include_str!("../../GSM_Overlay/vn_guide_preload.js");

const EMBEDDED_PINYIN_PRO_JS: &str = include_str!("../../GSM_Overlay/vendor/pinyin-pro.js");
const EMBEDDED_OVERLAY_UTILS_JS: &str = include_str!("../../GSM_Overlay/overlay_utils.js");
const EMBEDDED_FURIGANA_UTILS_JS: &str = include_str!("../../GSM_Overlay/furigana_utils.js");
const EMBEDDED_READING_OVERLAY_UTILS_JS: &str =
    include_str!("../../GSM_Overlay/reading_overlay_utils.js");
const EMBEDDED_BLOCK_DETECTION_JS: &str = include_str!("../../GSM_Overlay/block_detection.js");
const EMBEDDED_MAGPIE_JS: &str = include_str!("../../GSM_Overlay/magpie.js");
const EMBEDDED_MAGPIE_HIT_TEST_JS: &str = include_str!("../../GSM_Overlay/magpie_hit_test.js");
const EMBEDDED_TEXT_HOVER_JS: &str = include_str!("../../GSM_Overlay/text_hover.js");

fn read_overlay_asset_or(overlay_root: &Path, relative: &str, fallback: &str) -> String {
    let candidate = overlay_root.join(relative);
    if let Ok(content) = fs::read_to_string(candidate) {
        if !content.is_empty() {
            return content;
        }
    }
    fallback.to_string()
}

/// Escape `</script` and wrap a CommonJS module body cleanly inside a factory function.
fn cjs_factory(source: &str) -> String {
    let escaped = source.replace("</script", "<\\/script");
    format!("function(module, exports, require) {{\n{escaped}\n}}")
}

const PRELOAD_PLATFORM_JSON: &str = if cfg!(windows) {
    "\"win32\""
} else if cfg!(target_os = "macos") {
    "\"darwin\""
} else {
    "\"linux\""
};

pub(crate) fn apply_preload_tokens(template: &str, token: &str) -> String {
    let token_json = json!(token).to_string();
    template
        .replace("__GSM_WINDOW_TOKEN__", &token_json)
        .replace("__GSM_PLATFORM__", PRELOAD_PLATFORM_JSON)
}

pub(crate) fn render_desktop_preload(token: &str) -> String {
    apply_preload_tokens(PRELOAD_JS_TEMPLATE, token)
}

pub(crate) fn render_desktop_window_preload(token: &str, theme: Option<&str>) -> String {
    let base = render_desktop_preload(token);
    let theme_json = json!(theme.filter(|s| !s.is_empty()).unwrap_or("gsm-dark")).to_string();
    format!("{base}\nwindow.gsmEnv.theme={theme_json};\n{FIND_IN_PAGE_JS}\n")
}

fn desktop_base_preload(token: &str) -> String {
    render_desktop_preload(token)
}

/// Initialization script for the main transparent overlay (`index.html`).
/// Exposes `window.ipcRenderer`, `window.clipboard`, `window.gsmEnv`, strict allowlisted
/// `window.require(...)` (including `electron`, `pinyin-pro`, and overlay CJS helpers),
/// and `GSM_Overlay/preload.js` after the DOM parses.
pub fn overlay_main_init_script(
    token: &str,
    overlay_root: &Path,
    portable_extra: Option<&str>,
) -> String {
    let base = desktop_base_preload(token);
    let pinyin =
        read_overlay_asset_or(overlay_root, "vendor/pinyin-pro.js", EMBEDDED_PINYIN_PRO_JS);
    let overlay_utils =
        read_overlay_asset_or(overlay_root, "overlay_utils.js", EMBEDDED_OVERLAY_UTILS_JS);
    let furigana_utils = read_overlay_asset_or(
        overlay_root,
        "furigana_utils.js",
        EMBEDDED_FURIGANA_UTILS_JS,
    );
    let reading_overlay_utils = read_overlay_asset_or(
        overlay_root,
        "reading_overlay_utils.js",
        EMBEDDED_READING_OVERLAY_UTILS_JS,
    );
    let block_detection = read_overlay_asset_or(
        overlay_root,
        "block_detection.js",
        EMBEDDED_BLOCK_DETECTION_JS,
    );
    let magpie = read_overlay_asset_or(overlay_root, "magpie.js", EMBEDDED_MAGPIE_JS);
    let magpie_hit_test = read_overlay_asset_or(
        overlay_root,
        "magpie_hit_test.js",
        EMBEDDED_MAGPIE_HIT_TEST_JS,
    );
    let text_hover = read_overlay_asset_or(overlay_root, "text_hover.js", EMBEDDED_TEXT_HOVER_JS);
    let overlay_preload = read_overlay_asset_or(overlay_root, "preload.js", OVERLAY_PRELOAD_JS);

    let mut out = String::with_capacity(base.len() + pinyin.len() + 65_536);
    out.push_str(&base);
    out.push_str("\n;(() => {\n");
    out.push_str("  if (globalThis.__GSM_OVERLAY_SHIM__) return;\n");
    out.push_str("  globalThis.__GSM_OVERLAY_SHIM__ = true;\n");
    out.push_str("  const electronShim = { ipcRenderer: window.ipcRenderer, clipboard: window.clipboard };\n");
    out.push_str("  const factories = Object.create(null);\n");
    out.push_str(
        "  const register = (aliases, fn) => { for (const k of aliases) factories[k] = fn; };\n",
    );
    out.push_str(
        "  register(['pinyin-pro', 'pinyin-pro/dist/index.js', './vendor/pinyin-pro.js'], ",
    );
    out.push_str(&cjs_factory(&pinyin));
    out.push_str(");\n");
    out.push_str("  register(['./overlay_utils.js', './overlay_utils'], ");
    out.push_str(&cjs_factory(&overlay_utils));
    out.push_str(");\n");
    out.push_str("  register(['./furigana_utils.js', './furigana_utils'], ");
    out.push_str(&cjs_factory(&furigana_utils));
    out.push_str(");\n");
    out.push_str("  register(['./reading_overlay_utils.js', './reading_overlay_utils'], ");
    out.push_str(&cjs_factory(&reading_overlay_utils));
    out.push_str(");\n");
    out.push_str("  register(['./block_detection.js', './block_detection'], ");
    out.push_str(&cjs_factory(&block_detection));
    out.push_str(");\n");
    out.push_str("  register(['./magpie.js', './magpie'], ");
    out.push_str(&cjs_factory(&magpie));
    out.push_str(");\n");
    out.push_str("  register(['./magpie_hit_test.js', './magpie_hit_test'], ");
    out.push_str(&cjs_factory(&magpie_hit_test));
    out.push_str(");\n");
    out.push_str("  register(['./text_hover.js', './text_hover'], ");
    out.push_str(&cjs_factory(&text_hover));
    out.push_str(");\n");
    out.push_str(
        r#"  const cache = Object.create(null);
  function gsmRequire(specifier) {
    const id = String(specifier || '');
    if (id === 'electron') return electronShim;
    if (cache[id]) return cache[id].exports;
    const factory = factories[id];
    if (!factory) {
      throw new Error('Unsupported overlay require(' + JSON.stringify(id) + ')');
    }
    const mod = { exports: {} };
    cache[id] = mod;
    try {
      factory(mod, mod.exports, gsmRequire);
      return mod.exports;
    } catch (err) {
      delete cache[id];
      throw err;
    }
  }
  window.require = gsmRequire;
  globalThis.require = gsmRequire;
})();
"#,
    );
    out.push_str("\n;(() => {\n");
    out.push_str(&overlay_preload);
    out.push_str("\n})();\n");
    if let Some(extra) = portable_extra {
        if !extra.is_empty() {
            out.push_str("\n;");
            out.push_str(extra);
        }
    }
    out
}

/// Initialization script for `settings.html`, adding `window.require('electron')` and the
/// in-page find-in-page controller (`__GSM_FIND__` + `find-in-page-preload.js`).
pub fn overlay_settings_init_script(token: &str, overlay_root: &Path) -> String {
    let base = desktop_base_preload(token);
    let find_preload = read_overlay_asset_or(
        overlay_root,
        "find-in-page-preload.js",
        FIND_IN_PAGE_PRELOAD_JS,
    );
    format!(
        "{base}\n;{FIND_IN_PAGE_JS}\n;(() => {{\n  const electronShim = {{ ipcRenderer: window.ipcRenderer, clipboard: window.clipboard }};\n  const req = id => {{ if (id === 'electron') return electronShim; throw new Error('Unsupported require(' + id + ')'); }};\n  window.require = req;\n  globalThis.require = req;\n}})();\n;(() => {{\n{find_preload}\n}})();\n"
    )
}

/// Initialization script for simple overlay helper/dialog windows (`offset-helper.html`,
/// recommendation banners, startup notification) that only need `{ ipcRenderer, clipboard }`.
pub fn overlay_simple_ipc_init_script(token: &str) -> String {
    let base = desktop_base_preload(token);
    format!(
        "{base}\n;(() => {{\n  const electronShim = {{ ipcRenderer: window.ipcRenderer, clipboard: window.clipboard }};\n  const req = id => {{ if (id === 'electron') return electronShim; throw new Error('Unsupported require(' + id + ')'); }};\n  window.require = req;\n  globalThis.require = req;\n}})();\n"
    )
}

/// Context-isolated initialization script for `vn_guide_hud.html` (`window.vnGuide` only).
pub fn overlay_vn_guide_hud_init_script(token: &str, overlay_root: &Path) -> String {
    let base = desktop_base_preload(token);
    let vn_preload =
        read_overlay_asset_or(overlay_root, "vn_guide_preload.js", VN_GUIDE_PRELOAD_JS);
    // Run the standard vn_guide_preload.js inside an isolated closure with contextBridge/ipcRenderer
    // shims and do NOT expose raw require/ipcRenderer globals on the HUD page.
    format!(
        r#"(() => {{
{base}
  const localIpc = window.ipcRenderer;
  try {{ delete window.ipcRenderer; delete window.clipboard; delete window.require; }} catch {{}}
  const contextBridge = {{
    exposeInMainWorld(name, api) {{
      Object.defineProperty(window, name, {{ value: api, configurable: false, enumerable: true, writable: false }});
    }},
  }};
  const hudIpc = {{
    invoke: (...args) => localIpc.invoke(...args),
    on(channel, callback) {{
      const result = localIpc.on(channel, callback);
      // The first state can arrive before the HUD document subscribes.
      if (channel === 'vn-guide-state') void localIpc.invoke(channel)
        .then(state => callback({{}}, state)).catch(() => {{}});
      return result;
    }},
  }};
  const require = id => {{
    if (id === 'electron') return {{ contextBridge, ipcRenderer: hudIpc }};
    throw new Error('Unsupported require(' + id + ')');
  }};
  // The Electron preload declares its own contextBridge and ipcRenderer.
  (() => {{
{vn_preload}
  }})();
}})();
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Instant;

    #[test]
    fn generates_valid_overlay_preloads_and_benchmarks_speed() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../GSM_Overlay");
        let started = Instant::now();
        let script = overlay_main_init_script("test-token", &root, None);
        let elapsed = started.elapsed();

        assert!(script.contains("pinyinPro"));
        assert!(script.contains("magpiePointerToViewport"));
        assert!(script.contains("createTextHoverController"));
        assert!(script.contains("update-window-shape"));
        assert!(!script.contains("__GSM_WINDOW_TOKEN__"));
        assert!(!script.contains("__GSM_PLATFORM__"));
        assert!(!script.contains("node:fs"));
        println!(
            "[bench] overlay_main_init_script len_bytes={} build_ms={:.3}",
            script.len(),
            elapsed.as_secs_f64() * 1000.0
        );

        let settings = overlay_settings_init_script("test-token", &root);
        assert!(settings.contains("gsm-find-in-page-host"));

        let hud = overlay_vn_guide_hud_init_script("test-token", &root);
        assert!(hud.contains("vn-guide-state"));
        assert!(hud.contains("delete window.ipcRenderer"));
    }
}
