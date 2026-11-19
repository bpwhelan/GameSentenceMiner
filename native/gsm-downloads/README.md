# GSM downloads

GSM uses existing installed files and the shared data directory's `downloads/v1` cache first. A missing asset is fetched from Cloudflare R2, then the GitHub `gsm-assets-v1` release, then its original URL when one is available. The Rust downloader checks the length and any pinned SHA-256 before replacing a file. Desktop updates still use Tauri's signature verification for each source.

`assets.json` pins the VOCR graphs, Yomitan fonts, and optional desktop icons. For a new or changed asset, update its source path, SHA-256, size, and optional immutable origin. Native packaging reads the same catalog to exclude those files from the installer.

From the checkout, run `node scripts/publish-download-assets.mjs` to verify the publish inputs. Use `--publish` to upload with `GH_TOKEN` or an authenticated GitHub CLI. Set `R2_STORAGE` and install `rclone` to publish the same bytes to R2. Credentials are used only during publication. The native release workflow publishes the catalog assets before the desktop release and mirrors the signed installers and Agent runtime if R2 is configured.

An existing upstream download can be staged with `--asset URL LOCAL_FILE SHA256`. Use `-` in place of SHA-256 only for a legacy caller without a checksum. Its mirror object is then keyed by the URL. Preserve the original URL for fallback and use a new URL or pinned checksum for a new immutable version.
