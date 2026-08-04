# HoshiDicts host artifacts

GameSentenceMiner ships the optional HoshiDicts backend as a separate native
process. The host is not rebuilt inside desktop release jobs. The
`Build HoshiDicts Host` workflow builds and publishes provenance-checked bundles
to the rolling `hoshidicts-host` prerelease on `main`. Development builds use
the separate `hoshidicts-host-dev` prerelease so an in-progress host cannot
replace the stable channel.

## Supported artifacts

| Platform | Architecture | Executable |
| --- | --- | --- |
| Windows | x64 | `gsm_hoshidicts_host.exe` |
| Linux | x64 | `gsm_hoshidicts_host` |
| macOS | arm64 | `gsm_hoshidicts_host` |

Each `gsm-hoshidicts-host-<platform>-<arch>.tar.gz` contains:

- the native executable;
- `hoshidicts-host-manifest.json` with binary, source-tree, protocol, and trust
  metadata;
- `hoshidicts-provenance.json`;
- `THIRD_PARTY_NOTICES.md`;
- complete license texts under `licenses/`.

Desktop workflows fetch bundles into
`GSM_Overlay/hoshidicts_host/bin/<platform>-<arch>`. These directories are
generated and ignored by Git.

## Local build

Initialize recursive submodules before configuring:

```sh
git submodule update --init --recursive
cmake -S GSM_Overlay/hoshidicts_host -B build/hoshidicts-host \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
cmake --build build/hoshidicts-host --config Release --parallel 4
ctest --test-dir build/hoshidicts-host --build-config Release \
  --output-on-failure
```

The Linux release build uses Ubuntu 22.04 and GCC 12. `libstdc++` and `libgcc`
are linked into the host. Artifact verification rejects newer than
`GLIBC_2.35` or unexpected dynamic dependencies.

Create and verify a bundle from a clean checkout:

```sh
python scripts/generate_hoshidicts_fixture.py build/gsm-hoshi-fixture.zip
node scripts/hoshidicts-host-artifact.mjs create \
  --executable build/hoshidicts-host/gsm_hoshidicts_host \
  --bundle-dir build/hoshidicts-host-bundle \
  --smoke-fixture build/gsm-hoshi-fixture.zip
```

The verifier checks PE, ELF, or Mach-O architecture; checksums; executable
mode; protocol and host versions; the pinned HoshiDicts commit; the host Git
tree; notices and license texts; platform signatures; and a real fixture
import/lookup from a path containing spaces and non-ASCII characters.

## Consuming the rolling release

Stable builds require a trusted bundle:

```sh
node scripts/fetch-hoshidicts-host.mjs \
  --repo owner/GameSentenceMiner \
  --smoke-fixture build/gsm-hoshi-fixture.zip
```

Development builds in forks without signing credentials must opt in to an
unsigned bundle:

```sh
node scripts/fetch-hoshidicts-host.mjs \
  --repo owner/GameSentenceMiner \
  --release-tag hoshidicts-host-dev \
  --allow-unsigned-development \
  --smoke-fixture build/gsm-hoshi-fixture.zip
```

The opt-in does not affect stable releases. `release_exe.yml` omits that flag,
passes `--require-trusted` during package verification, and fails if a Windows
or macOS bundle is unsigned.

## Signing configuration

Windows host signing uses SignPath with:

- secret `SIGNPATH_APITOKEN`;
- project `GameSentenceMiner`;
- artifact configuration `gsm_hoshidicts_host`;
- policy `release-signing`.

If SignPath is unavailable, the host workflow may publish an explicit
`unsigned-development` bundle. It never labels that bundle as signed. The
stable Windows workflow also verifies Authenticode on the nested host after
SignPath returns the signed unpacked application.

macOS host and stable application signing use:

- `MACOS_CERTIFICATE_BASE64`;
- `MACOS_CERTIFICATE_PASSWORD`;
- optional `MACOS_SIGNING_IDENTITY`;
- `APPLE_ID`;
- `APPLE_APP_SPECIFIC_PASSWORD`;
- `APPLE_TEAM_ID`.

The host workflow imports the Developer ID certificate and signs the host
before creating its manifest. Electron Builder leaves that nested signature
intact, signs and notarizes the application, and the stable workflow checks
`codesign`, Gatekeeper, and the stapled notarization ticket. Missing macOS
credentials fail the stable release job.

## Updating the host

1. Update the pinned submodule and `provenance.json`.
2. Run `node scripts/verify-hoshidicts-provenance.mjs`.
3. Build and run native tests on all three platforms.
4. Publish the `hoshidicts-host` rolling release.
5. Confirm a desktop release fetches the new host-tree manifest and passes
   packaged verification.

The fetch helper rejects a rolling artifact whose host tree does not match the
desktop source checkout, so stale host releases fail closed.
