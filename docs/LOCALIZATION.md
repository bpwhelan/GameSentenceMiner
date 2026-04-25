# Localization Guide

GSM's Electron UI uses a lightweight React-based i18n system.  
All translatable strings live in JSON files under `electron-src/renderer/src/i18n/`.

## Supported Locales

| Code | Label    | File      |
|------|----------|-----------|
| `en` | English  | `en.json` |
| `ja` | 日本語   | `ja.json` |
| `ukr` | Українська | `ukr.json` |

English is the **fallback locale** — if a key is missing in another locale, the English value is shown.

## File Structure

Each locale file is a flat JSON object with dot-path key namespaces:

```
{
  "home": { ... },
  "app": { ... },
  "wizard": { ... },
  "install": { ... },
  "settings": { ... },
  "launcher": { ... },
  "ocr": { ... }
}
```

Namespaces map to UI areas:

| Namespace   | Component(s)                |
|-------------|-----------------------------|
| `home`      | `HomeTab.tsx`               |
| `app`       | `App.tsx` (tabs, console)   |
| `wizard`    | `SetupWizard.tsx`           |
| `install`   | `InstallSessionModal.tsx`   |
| `settings`  | `SettingsTab.tsx`           |
| `launcher`  | `LauncherTab.tsx`           |
| `ocr`       | `OCRTab.tsx`                |

## Adding a New Locale

1. **Create the locale file** — copy `en.json` to `{code}.json` (e.g. `ko.json`) and translate every value.  
2. **Register in `index.ts`** — add the import and entry:
   ```ts
   import ko from "./ko.json";
   
   const locales: Record<string, Record<string, unknown>> = {
     en,
     ja,
     ukr,
     ko   // ← add here
   };
   
   export const SUPPORTED_LOCALES = [
     { code: "en", label: "English" },
     { code: "ja", label: "日本語" },
     { code: "ukr", label: "Українська" },
     { code: "ko", label: "한국어" }   // ← add here
   ];
   ```
3. **Test** — switch language in Settings → Desktop → Language.

## Key Naming Conventions

- **Dot paths**: `namespace.section.key` (e.g. `settings.desktop.iconStyle`)
- **Headings**: `*.title`
- **Labels**: descriptive name matching the UI element (e.g. `agentPath`, `scanRate`)
- **Buttons**: action verb or short label (e.g. `browse`, `download`, `refresh`)
- **Tooltips**: `*.tooltips.keyName` — stored as i18n key references in code, translated at render time
- **Status messages**: `*.status.eventName` (e.g. `launcher.status.savedShared`)

## Interpolation

Use `{variableName}` placeholders in locale strings:

```json
"savedScene": "Saved automation for scene: {scene}"
```

In code:
```tsx
t("launcher.status.savedScene", { scene: configuredScene.name })
```

## Patterns

### Inside React Components

```tsx
import { useTranslation } from "../../i18n";

function MyComponent() {
  const t = useTranslation();
  return <h1>{t("namespace.key")}</h1>;
}
```

### Module-Scope Constants with `labelKey`

When an array of options is defined outside a component, store i18n keys instead of display strings:

```tsx
const TABS = [
  { id: "home", labelKey: "app.tabs.home" },
  { id: "settings", labelKey: "app.tabs.settings" }
];

// In render:
{TABS.map(tab => <span>{t(tab.labelKey)}</span>)}
```

### Tooltip Key Maps

For large tooltip objects defined at module scope, store i18n key paths as values:

```tsx
const TOOLTIPS = {
  agentPath: "launcher.tooltips.agentPath",
  scanRate: "launcher.tooltips.scanRate"
} as const;

// In render:
<label title={t(TOOLTIPS.agentPath)}>...</label>
```

### Rich Text (HTML in translations)

For strings containing HTML tags (e.g. `<strong>`), use `dangerouslySetInnerHTML`:

```tsx
<p dangerouslySetInnerHTML={{ __html: t("wizard.finish.tipHome") }} />
```

Only use this for trusted, developer-authored content in locale files.

## Standalone `t()` (Non-Component Code)

The standalone `t()` export always resolves against English. Use it only when a React context is unavailable and English fallback is acceptable.

```ts
import { t } from "../../i18n";
// Always returns English value
```

## Build Verification

After adding or modifying locale files, run the TypeScript build to catch import or type errors:

```bash
npm run build
```
