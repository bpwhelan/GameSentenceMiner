# HoshiDicts candidate capability report

Audit date: 2026-08-04

Candidates:

- selected MIT line:
  `Manhhao/hoshidicts@af99b554cd4ab289aa65e16fd2a4eea0d3870d3b`;
- Chimahon GPL reference:
  `sohilsayed/hoshidicts@156f586a5bc67d72e5e6b315e84464719415583c`.

Both candidates were built from recursive clean checkouts with GCC 14.2.1 on
Linux. GCC 11.5 cannot build either candidate because their pinned Glaze
versions require C++23 `<expected>`; release builds therefore require a modern
C++23 standard library.

## Capability comparison

| Capability | MIT pin | GPL reference | Decision |
| --- | --- | --- | --- |
| Yomitan ZIP term import | Yes | Yes | Required and selected |
| Term lookup and matched length | Yes | Yes | Required and selected |
| Inflection handling | Jiten deconjugator | Yomitan-derived deinflector | MIT behavior is an explicit compatibility difference |
| Frequency import/query | Yes | Yes | Required and selected |
| Pitch import/query | Positions only | Positions plus transcriptions | Positions are the first-version capability |
| Structured glossary | Preserved as raw structured JSON | Preserved as raw structured JSON | Renderer must apply its own allowlist |
| Dictionary CSS | Returned as raw dictionary CSS | Returned as raw dictionary CSS | Host/renderer must scope and sanitize it |
| Dictionary media | Byte lookup by dictionary and relative path | Same | Required with host path/MIME/size controls |
| Kanji dictionaries | Yes | Yes | Available at the selected pin |
| Cooperative cancellation | No | No | Host must isolate imports and terminate workers when needed |
| Import progress callback | No | No | Host can expose phase boundaries, but not inner-library progress |
| Native test suite | None | None | GSM must own host and fixture coverage |
| Windows x64 build | CI gate added | Not selected | Required before distribution |
| Linux x64 build | Local GCC 14 build passes; CI gate added | Local comparison build passes | Required before distribution |
| macOS arm64 build | CI gate added | Not selected | Required before distribution |

The GPL line additionally records separate frequency/pitch import counts, term
scores, pitch transcriptions, broader Japanese preprocessing, and a bloom
index. None is required to expose the initial MIT capability set. These
differences must not be hidden by claiming parity with Chimahon.

## Identical fixture evidence

The generated CC0 fixture is in
`GSM_Overlay/hoshidicts_host/fixtures/tiny-yomitan`. It contains three terms,
frequency and pitch metadata, one kanji entry, structured glossary content,
CSS, and media. Generate it with:

```sh
python3 scripts/generate_hoshidicts_fixture.py /tmp/gsm-hoshi-fixture.zip
```

Both pins imported the same ZIP successfully:

| Result | MIT pin | GPL reference |
| --- | ---: | ---: |
| Terms | 3 | 3 |
| Metadata rows | 2 | 2 |
| Kanji rows | 1 | 1 |
| Media files | 1 | 1 |

Both returned `食べる / たべる / to eat` for lookup text `食べました`,
returned frequency value `100` with display value `top 100`, exposed the
fixture CSS, and returned the same `食` kanji fields. The expected lookup
difference is the transformation trace:

```text
MIT: past polite -> (infinitive)
GPL: -た -> -ます
```

That difference comes from the approved Jiten-versus-Yomitan inflection source
and is user-visible semantics, so Hoshi must not silently fall back to Yomitan.

## Selected handshake capabilities

The first host handshake may advertise:

```text
term, frequency, pitch-position, structured-glossary, styles, media, kanji
```

It must not advertise pitch transcription, cooperative import cancellation, or
fine-grained library import progress. Worker termination may implement
cancellation at the process boundary, but that is a host capability and must be
named separately.
