# Hachidori in the overlay

Hachidori is an experimental dictionary reader for the overlay, an alternative to Yomitan.
It is a Chrome extension that runs [hoshidicts](https://github.com/bee-san/hoshidicts)
as WebAssembly. GSM vendors a pinned snapshot of it in `GSM_Overlay/hachidori/`.

## Enabling it

In GSM settings, open **Experimental** and turn on both the master experimental toggle
and **Enable Hachidori**, then restart the overlay. The overlay then loads Hachidori
instead of Yomitan. The settings chip opens Hachidori's own Settings page.

## Overlay mode

The vendored copy runs in Hachidori's
[overlay mode](https://github.com/bee-san/hachidori/blob/main/docs/overlay-mode.md),
switched on by `export const OVERLAY_MODE = true;` in `GSM_Overlay/hachidori/overlay-mode.js`.
On a fresh overlay profile, overlay mode:

- starts lookups on hover, with no activation key to hold;
- starts with the word highlight off;
- skips Hachidori's first-run setup page, which Electron has no tab to show.

These are starting defaults, so users can still change them in Hachidori Settings.

With no setup page, dictionaries are installed from Settings. An empty library shows
**Install recommended dictionaries**, which installs the whole recommended set in one click.

## Updating the snapshot

Do not edit files under `GSM_Overlay/hachidori/` by hand. Change Hachidori upstream, then
re-sync from a clean checkout of the commit to vendor:

```sh
git -C /path/to/hachidori worktree add --detach /tmp/hachidori-sync origin/main
node scripts/sync-hachidori.mjs /tmp/hachidori-sync
```

`scripts/sync-hachidori.mjs` copies `extension/` and makes the GSM changes:

- adds a fixed manifest `key`, so the extension ID stays stable;
- switches overlay mode on;
- records the source commit and both changes in `SOURCE.json`.

If upstream renames the overlay switch, the script fails instead of silently vendoring
a copy with overlay mode off.

`scripts/verify-overlay-package.mjs` checks the packaged overlay. It confirms the extension,
its wasm engines, the stable key, an exact source commit, and that overlay mode is on.
