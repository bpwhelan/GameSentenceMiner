# HoshiDicts dependency provenance

## Decision

GameSentenceMiner's optional HoshiDicts host uses **Path A**, the MIT-licensed
`main-mit` line from `Manhhao/hoshidicts`, pinned at:

```text
af99b554cd4ab289aa65e16fd2a4eea0d3870d3b
```

This is the dependency selected for implementation in the `bee-san` fork on
2026-08-04. It is a project licensing decision, not legal advice. The GPL
`sohilsayed/hoshidicts` line must not be linked into or substituted for the
LGPL-3.0-only GameSentenceMiner package without a separate written review.

The source is a recursive Git submodule at
`GSM_Overlay/hoshidicts_host/vendor/hoshidicts`. Updates require a reviewed
change to the gitlink, `provenance.json`, capability report, notices, and
cross-platform build evidence. Moving branch heads are never build inputs.

## Embedded source

The MIT line replaced Yomitan-derived GPL deinflection code in HoshiDicts pull
request 7. Its deconjugator is a port of Apache-2.0 Jiten data. The embedded
rules exactly match `Sirush/Jiten` commit:

```text
0146ce2f83548d81c3ec9557a4f123d30242e1d7
Shared/resources/deconjugator.json
SHA-256 62acb90912f45956710e2414a9d5b113a7c21998dfc67f43b9c73993ccb6af25
```

HoshiDicts wraps that JSON in
`src/deconjugator/deconjugation_rules.hpp`; the pinned wrapper has SHA-256
`1303fc92ecf62014546ecbc69ad5f44552deb0798798c0d8e5aaeaafc1eb03a9`.
The Apache-2.0 text is retained at `external/Jiten/LICENSE`.

## Recursive dependency inventory

| Dependency | Commit | License |
| --- | --- | --- |
| HoshiDicts | `af99b554cd4ab289aa65e16fd2a4eea0d3870d3b` | MIT |
| Jiten rules | `0146ce2f83548d81c3ec9557a4f123d30242e1d7` | Apache-2.0 |
| glaze | `be5159d80c480ec0d97db40f685983e2f7ade2d3` | MIT |
| libdeflate | `4b6db597a58a92cf7f1e171211d718ac1faea845` | MIT |
| unordered_dense | `7b55cab8418da1603496462ce3ccdb4cb1dc3368` | MIT |
| utfcpp | `cfc9112cee3e817e8b72948a675f78479546f0cf` | BSL-1.0 |
| xxHash | `82cead715cbfddd9e6093db8df95155077ce6e64` | BSD-2-Clause |
| zstd | `0532fe3e8ac1caf48f11603847ac3176064189d1` | BSD-3-Clause |

Zstandard is dual-licensed BSD-3-Clause or GPL-2.0. This project selects its
BSD-3-Clause license. No GPL option is selected for the Hoshi host.

Exact license hashes live in
`GSM_Overlay/hoshidicts_host/provenance.json`; the verifier checks the source
gitlink, every recursive checkout, tracked-worktree cleanliness, and every
selected license. File hashes are computed from the pinned Git blobs so
platform checkout line-ending conversion cannot change provenance:

```sh
git submodule update --init --recursive
npm run verify:hoshidicts-provenance
```

## Distribution obligations

The host is an MIT/permissive aggregation distributed with the LGPL
GameSentenceMiner application. Packages containing the host must also contain:

- `THIRD_PARTY_NOTICES.md`;
- the HoshiDicts MIT license;
- Jiten's Apache-2.0 license;
- each recursive dependency's selected license text;
- the exact HoshiDicts source commit and source URL.

Package verification must fail if those notices or the matching host provenance
metadata are absent. The host must report the pinned HoshiDicts commit at
runtime; Goal 2 adds that executable metadata and Goal 10 checks it in packaged
artifacts.

## Approval and update policy

Path A is approved for technical implementation in this fork. Before stable
distribution, a human repository owner must review this inventory and the
packaged notice output as part of the Goal 13 release evidence. A failed review
removes or hides the backend; it does not permit substitution of the GPL line.
