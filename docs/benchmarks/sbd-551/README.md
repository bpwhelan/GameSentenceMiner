# Independent PySBD / yasbd evaluation for GSM issue #551

Evaluated 2026-09-14. **Keep PySBD as the default for now. Do not accept the proposed import replacement with `clean=True`. A narrowly scoped PR is worth considering if it preserves source text and passes GSM's filtering regressions.**

Yasbd's speed and additional language support are real. Its accuracy advantage depends on language, input, and cleaning settings. The proposed adapter changes observable GSM behavior, including punctuation, newlines, and duplicate suppression. This is a reason to require a better integration, not a reason to distrust the contributor's motives.

No application code or production dependencies were changed. The benchmark dependencies live in `.tmp_test_env/sbd_issue_551/.venv`.

**Follow-up: is a linguistic segmenter necessary?** The first benchmark did not include removing the sentence-splitting dependency, so its recommendation is conditional on retaining this architecture. Inspection shows that engines such as OneOCR already return visual lines and geometry. GSM reconstructs a string from those lines, then invokes the segmenter to create comparison blocks for duplicate suppression and language filtering. Those blocks are not intrinsically required to be linguistic sentences. Before inviting a replacement dependency, evaluate keeping OCR's existing blocks or using full-text overlap comparison.

A small additional native-filter probe compared PySBD, `splitlines()`, and whole-result passthrough. Line-based splitting correctly removed a previously seen sentence when the new sentence occupied another line, but did not remove it when both sentences shared one line. Conversely, whole-result comparison recognized a whitespace-only rewrap that both finer-grained approaches treated as new text. This establishes different behavior, not an overall winner; the output is retained in `.tmp_test_env/sbd_issue_551/segmentation_ablation.json`.

The broader controller already has overlapping protections: `gsm_ocr.py::_dispatch_second_pass_result` trims the last emitted text as a literal prefix, and the V2 controller performs additional text/chunk comparison. Therefore the earlier lowercase example is a **filter-level regression**, not proof of duplicated final delivery in every mode; second-pass dispatch can remove that exact repeated prefix. Direct delivery follows a different path. Removing the segmenter should be judged across complete controller routes, including same-line growth, rewrapping, persistent UI fragments, and text-only engines. The preferred next investigation is whether this existing overlap handling can safely replace linguistic splitting, rather than assuming that another SBD library is required.

## What was measured

- Published wheels: **pysbd 0.3.4**, as pinned by GSM, and **yasbd-lib 0.16.3**, the latest PyPI release at evaluation time. Installed code was used, not yasbd's development checkout.
- Windows 11, CPython 3.13.2, AMD Ryzen 7 5800X, 8 cores / 16 logical processors; `regex==2026.7.19` matches GSM's existing environment. Full package versions are in `requirements.txt` and `results/environment.json`.
- **1,695 input cases:** 63 GSM-oriented cases, 12 separate policy/cleaning diagnostics, 1,480 independently annotated UD test contexts across 10 languages, 92 yasbd golden cases, and 48 original PySBD golden cases.
- The 63 main GSM cases and 12 diagnostics were written and frozen before running either segmenter. They are synthetic dialogue/OCR examples, including three examples from GSM's existing punctuation/filtering tests, not a representative gameplay recording.
- UD r2.16 **test** sentences were taken from Japanese-GSD, Chinese-GSD, English-EWT, Korean-GSD, French-GSD, German-GSD, Spanish-GSD, Russian-Taiga, Portuguese-Bosque, and Ukrainian-IU. Non-overlapping triples were sampled across each test file with seed 551; at most 150 triples per language. French has 138 available triples and Spanish 142. The triples contain **4,440 annotated sentences**. Source revisions, IDs, and hashes are recorded.
- Sentence texts within each triple were joined without a separator for Japanese/Chinese and with one space elsewhere. These are reconstructed contexts, sometimes crossing original document boundaries. They test annotated sentence boundaries, not authentic OCR layouts. UD is independently authored, but there is no claim that either library's author has never seen these public datasets. [UD format documentation](https://universaldependencies.org/format.html).
- Warm latency: reused segmenters, one warmup over the selected texts, seven rounds, three passes per round, randomized backend order, complete consumption of all generator outputs, GC disabled only inside timing batches. At most 32 distinct texts per language/suite were timed, identically for every backend. Individual-call median/p95 and all round batch averages are retained. Two separate full runs produced identical accuracy results; both sets of timings are retained.
- Cold measurements: five fresh Python processes per backend/language. These measure import + construction + first segmentation inside the child, excluding interpreter startup. Disk caches are not flushed. RSS changes are process measurements, not projected GSM startup/memory increases.

`pysbd_clean` is GSM's current `Segmenter(language=lang, clean=True)` plus its unsupported-language passthrough. `yasbd_clean` is the exact proposed PySBD-compatible adapter with `clean=True`. `pysbd_raw` and `yasbd_raw` use `clean=False`; `yasbd_core` calls `list(BoundaryDetector(lang=lang).segment(text))` without a cleaner.

## Speed: worthwhile for bulk text, modest for ordinary OCR snippets

Primary comparison uses `clean=True` on both sides. Times are second-run per-call medians, in milliseconds; these are segmentation times, not full OCR pipeline latency.

| Input | Median characters | PySBD | Proposed yasbd adapter | PySBD / yasbd |
|---|---:|---:|---:|---:|
| GSM Japanese cases | 15 | 0.1001 ms | 0.0794 ms | 1.26× |
| GSM English cases | 34.5 | 0.1825 ms | 0.1192 ms | 1.53× |
| GSM Chinese cases | 12.5 | 0.1178 ms | 0.0804 ms | 1.47× |
| UD Japanese triples | 131.5 | 0.2225 ms | 0.2196 ms | 1.01× |
| UD Chinese triples | 121.5 | 0.2543 ms | 0.2961 ms | 0.86× |
| UD English triples | 141.5 | 0.4148 ms | 0.2782 ms | 1.49× |
| UD Spanish triples | 339.5 | 1.9312 ms | 0.6581 ms | 2.93× |

Short Japanese snippets save about **0.021 ms per call**, and English about **0.063 ms**. Japanese triples are effectively tied: yasbd was slightly slower in the first run, and the second-run batch-average ratio is 0.99×. Chinese triples are slower with the proposed adapter in both runs. Yasbd without cleaning is faster, but changes to the configuration/API require their own correctness review.

The large-input check uses three warm repetitions after a first document run in a fresh subprocess:

| Input | PySBD, clean=True | yasbd adapter, clean=True | Observation |
|---|---:|---:|---|
| Sherlock Holmes, 593,911 characters | 5,896.5 ms | 1,269.9 ms | 4.64× speedup |
| Repeated Japanese OCR lines, 90,000 characters | 9,457.3 ms | 229.9 ms | 41.1×, but different segmentation/cleaning |
| 100,000 Japanese characters, no punctuation | 78.5 ms | 118.5 ms | yasbd is slower |

For the author's book configuration—PySBD `clean=False` versus yasbd's native API—I measured **5,851.7 ms versus 958.3 ms**, or **6.11×**. This supports a substantial bulk speed advantage, though not a universal 8× gain. Book sentence counts differed greatly (14,501 vs 5,980); neither book has gold boundaries in this experiment, so counts do not establish accuracy. The 90,000-character workload is synthetic repetition and is labelled `ja_wrapped_100k` in the raw results; the recorded character count is authoritative. Unpunctuated input was also tested at 1,000 and 10,000 characters. No bulk test timed out.

## Accuracy: an independent comparison does not show a universal winner

The following table counts **entire three-sentence contexts recovered exactly, ignoring whitespace only**. Changing punctuation or characters fails this metric. It is deliberately stricter than boundary-only accuracy because GSM emits the resulting text and tries to locate those blocks in the original OCR source.

| UD language | Contexts | Current PySBD | Proposed yasbd, clean=True | yasbd, clean=False |
|---|---:|---:|---:|---:|
| Japanese | 150 | 133 (88.7%) | 119 (79.3%) | 135 (90.0%) |
| Chinese | 150 | 145 (96.7%) | 0 (0.0%)* | 144 (96.0%) |
| English | 150 | 83 (55.3%) | 71 (47.3%) | 72 (48.0%) |
| French | 138 | 120 (87.0%) | 120 (87.0%) | 120 (87.0%) |
| German | 150 | 74 (49.3%) | 77 (51.3%) | 109 (72.7%) |
| Spanish | 142 | 120 (84.5%) | 122 (85.9%) | 122 (85.9%) |
| Russian | 150 | 76 (50.7%) | 90 (60.0%) | 92 (61.3%) |
| Korean | 150 | passthrough | 97 (64.7%) | 97 (64.7%) |
| Portuguese | 150 | passthrough | 111 (74.0%) | 111 (74.0%) |
| Ukrainian | 150 | passthrough | 90 (60.0%) | 107 (71.3%) |

**\*The Chinese 0% is a source-text preservation failure, not zero boundary accuracy.** The cleaner changed non-whitespace characters in all 150 Chinese contexts, commonly `，` → `,`, `（` → `(`, or full-width `！`/`？` → ASCII. Many sentence boundaries were otherwise correct. Japanese text changed in 19/150 contexts. PySBD's cleaner also changes text: for example, 50/150 German contexts versus yasbd's 47/150. The comparison does not excuse existing PySBD problems.

To examine boundaries separately, I compared both libraries with cleaning disabled. Internal sentence-end positions are measured in **non-whitespace character coordinates**, appropriate for unspaced CJK. The unavoidable end of input is excluded. Text changes are flagged and excluded from this conditional boundary metric, never arbitrarily aligned; scored-case counts are in the JSON. The table below uses all contexts in the listed languages because neither raw backend changed their non-whitespace text.

| Language | PySBD raw boundary F1 | yasbd raw boundary F1 |
|---|---:|---:|
| Japanese | 96.76% | 97.28% |
| Chinese | 99.16% | 98.99% |
| English | 78.53% | 74.95% |
| French | 95.94% | 95.33% |
| German | 88.85% | 91.34% |
| Spanish | 95.67% | 95.84% |
| Russian | 80.65% | 84.36% |

The Japanese gain is small: two additional exactly recovered contexts out of 150. The evidence is insufficient to claim a general Japanese accuracy improvement. Russian and German look promising; English regresses on this dataset. No cross-language average is used to disguise those differences.

On the 63 frozen GSM-oriented cases, exact non-whitespace matches were **50/63 for current PySBD**, **49/63 for proposed yasbd**, and **58/63 for yasbd without cleaning**. These totals include Korean and Portuguese, where GSM currently passes text through; they therefore mix newly supported functionality with quality on shared languages. Japanese alone was **21/24, 16/24, and 22/24**, respectively. The 12 policy diagnostics are reported separately, not folded into this main score.

## Reproduced GSM integration failures and improvements

The benchmark executes the actual repository's `_filter_text_python`, `_filter_text_native`, and source-joining helper bodies with isolated regex/history state. It also loads the installed native extension. Application services and user configuration are not started. Language classification is held fixed to the input language for all backends. This covers text filtering and duplicate suppression, not OCR capture or language-classifier accuracy.

The following behaviors occurred in both the Python reference and installed native paths:

1. **Punctuation changes:** `「返しなさいよーーーっ！！」` becomes `「返しなさいよーーーっ!!」` with the proposed cleaner. This input comes from GSM's existing punctuation-preservation test.
2. **Newlines introduced and lost:** `ＨＰが１００回復した！次へ進もう。` becomes `HPが100回復した!\n次へ進もう。`. Cleaning prevents exact source-block matching, causing GSM to use its fallback newline join. A Japanese line wrapped inside a sentence also changes from the original newline to a space.
3. **Duplicate OCR content:** after seeing `are you there?`, the next frame `are you there? please answer.` emits only `please answer.` with PySBD. Yasbd merges the sentences and emits the whole previous question again. Turning cleaning off does not fix this.
4. **Growing menu text:** the proposed cleaner merges separate Japanese menu lines, so appending a new menu entry can resend the old entries too.
5. **Disabling cleaning alone is insufficient:** the adapter attaches line-break whitespace to its returned sentences. GSM strips block edges while joining against source spans; those newlines can disappear. This reproduced in both filter paths.

There are improvements too: yasbd separates adjacent quoted Japanese utterances, which avoids resending a previously seen quote, and segments Korean where GSM currently uses passthrough. It also handled the tested `BLANK_LINE` English case better than PySBD.

I tried a minimal integration alternative in the benchmark only: a wrapper whose `segment(text)` returns `list(BoundaryDetector(lang=lang).segment(text))`, without a cleaner. It preserves the tested line breaks and punctuation. Across 11 deliberately selected integration scenarios, current PySBD passed 8, the proposed adapter 5, the uncleaned adapter 8, and the materialized native-API wrapper 10, identically in both GSM filter paths. These post-investigation probes illustrate failure mechanisms; they are not a held-out accuracy estimate. The remaining wrapper failure was the lowercase English duplicate case.

Returning a generator directly is insufficient: GSM's Python filter iterates the segment list more than once. A PR must materialize the result.

## How much weight to give the author's published results

I reproduced the advertised English golden-suite scores using the author's settings:

| Suite | PySBD, clean=False | yasbd native API |
|---|---:|---:|
| Author's modified 92-case suite | 77/92 (83.7%) | 91/92 (98.9%) |
| Original PySBD 48-case suite | 47/48 (97.9%) | 45/48 (93.8%) |

The original PySBD suite includes its explicitly marked expected failure. Both libraries were scored against the same expectations in each row, without excluding failures. Some original expectations are debatable; yasbd documents its changes. The reversal shows why neither upstream's own suite should decide adoption. It does **not** establish that the author's results are fabricated. [Benchmark wrappers](https://github.com/speedyk-005/yasbd-lib/blob/eedfe1b2bfc049151fd349a0de3364a4dccd29ac/benchmarks/bench_utils.py), [modified golden data](https://github.com/speedyk-005/yasbd-lib/blob/eedfe1b2bfc049151fd349a0de3364a4dccd29ac/benchmarks/EN_GOLDEN_DATA.py).

Their scorer uses whitespace-delimited word positions, includes each input's final boundary, and pads mismatched token arrays on the left. That is unsuitable as the sole acceptance metric for GSM's CJK or text-changing cleaners. Our scorer uses internal character boundaries and explicitly reports text changes. Five focused tests cover CJK, final-boundary inflation, content changes, harmless whitespace differences, and false splits. [Upstream scorer](https://github.com/speedyk-005/yasbd-lib/blob/eedfe1b2bfc049151fd349a0de3364a4dccd29ac/benchmarks/scorer.py).

The expanded language count is confirmed: 23 → **39 real languages**, with no PySBD language removed. `get_supported_langs()` returns 40 values because it also contains `auto`. Newly supported languages include Korean, Portuguese, Swedish, Turkish, Ukrainian, and Thai. Finnish, Norwegian, and Hebrew still use fallback. This is a useful capability increase, not a guarantee of equivalent quality in all 39 languages.

## Dependency and maintenance cost

The published yasbd wheel requires six direct runtime dependencies. GSM already has `regex` and `loguru`; this installation additionally needs `ftfy`, `retrie`, `radicli`, `beartype`, and transitive `wcwidth`. PySBD has no runtime dependencies. Neither comparison downloads an ML model.

In the isolated Japanese cold measurement, the proposed adapter took **299 ms** through first segmentation versus **18 ms** for PySBD, with approximately **14.0 MiB versus 1.1 MiB** RSS growth. Some imports are already paid for inside GSM, so these are standalone costs, not measured app startup deltas. Yasbd's native API without the adapter was approximately 233 ms / 11 MiB.

PyPI records show yasbd's first release on 2026-05-29 and 0.16.3 on 2026-09-09; its metadata marks it Beta. PySBD 0.3.4 dates to 2021. Active yasbd maintenance is a benefit; its short release history and extra dependencies favor pinning and regression coverage. License metadata changes from MIT to MPL-2.0; this report does not make a legal compatibility determination. Python requirements overlap GSM (`>=3.10`), but execution was tested only on Windows/Python 3.13.2. [yasbd on PyPI](https://pypi.org/project/yasbd-lib/0.16.3/), [PySBD on PyPI](https://pypi.org/project/pysbd/0.3.4/).

## Recommendation and PR acceptance conditions

**Do not approve the proposed blanket swap. Invite a scoped PR only if the contributor is willing to address the concrete GSM regressions.** Speed alone does not justify them for short OCR inputs.

A useful first PR would supply a source-preserving, list-returning adapter and focus on languages where the evidence supports it, especially currently unsupported languages such as Korean/Portuguese. Keep PySBD for existing languages by default until those languages have their own passing acceptance data. A Japanese switch needs stronger gameplay-specific evidence than a two-context improvement in this sample; an English switch needs to address the measured regressions.

Before merging a broader replacement, require:

1. Exact preservation of punctuation, width, whitespace, and literal OCR text unless GSM explicitly opts into a documented cleaning step. The native API wrapper is a promising starting point; neither proposed `clean=True` nor the adapter's `clean=False` is sufficient unchanged.
2. Tests with the actual segmenter in both GSM filter paths covering wrapped text, `BLANK_LINE`, punctuation, adjacent quotes, menu growth, lowercase continuations, duplicate prefixes, and language changes. Current punctuation tests use stub segmenters and would not catch the library behavior by themselves.
3. Independently labelled samples from actual game/OCR output for the languages being switched, with disagreements reviewed rather than resolved by changing expectations to fit the implementation. Report boundary quality and text preservation separately.
4. Pinned dependency versions and installation/regression checks across GSM's supported Python versions and operating systems. Both `ocr_runtime.py` and the legacy `run.py` contain segmenter initialization/refresh sites; the top-level and embedded owocr dependency declarations must stay consistent.

There is enough evidence to consider an engineering PR, but not enough to promise a default-backend migration. A contributor unwilling to narrow the proposal should be asked to fix these cases upstream first.

## Reproduction and artifacts

Run from the GSM repository root. The source checkouts are used only as data: golden assignments are parsed with `ast`, never imported. UD downloads and raw predictions remain in the ignored cache; those datasets have their own licenses.

```powershell
.venv/Scripts/uv.exe venv .tmp_test_env/sbd_issue_551/.venv --python .venv/Scripts/python.exe
.venv/Scripts/uv.exe pip install --python .tmp_test_env/sbd_issue_551/.venv/Scripts/python.exe -r docs/benchmarks/sbd-551/requirements.txt
git clone https://github.com/speedyk-005/yasbd-lib.git .tmp_test_env/sbd_issue_551/yasbd-lib
git -C .tmp_test_env/sbd_issue_551/yasbd-lib checkout eedfe1b2bfc049151fd349a0de3364a4dccd29ac
git clone https://github.com/nipunsadvilkar/pySBD.git .tmp_test_env/sbd_issue_551/pysbd-source
git -C .tmp_test_env/sbd_issue_551/pysbd-source checkout 5905f13be4fc95f407b98392e0ec303617a33d86
.tmp_test_env/sbd_issue_551/.venv/Scripts/python.exe scripts/benchmark_sentence_segmenters.py prepare
.tmp_test_env/sbd_issue_551/.venv/Scripts/python.exe scripts/benchmark_sentence_segmenters.py run
.tmp_test_env/sbd_issue_551/.venv/Scripts/python.exe scripts/benchmark_sentence_segmenters.py probe
.tmp_test_env/sbd_issue_551/.venv/Scripts/python.exe scripts/benchmark_sentence_segmenters.py bulk
```

On this machine the environment/checkouts already exist; reruns can start with `run`. The source manifest pins every UD file by Git commit and SHA-256. Verify the regenerated corpus SHA against the saved manifest when reproducing elsewhere. The native probe runs only the Python path if GSM's native extension is unavailable.

- `gsm_cases.json`: all independently written main cases and policy diagnostics.
- `corpus_manifest.json`: selection seed, source URLs/revisions, case counts and hashes.
- `upstream_metadata.json`: package artifact hashes/dependencies and installed native-extension hash.
- `results/accuracy.json`: all suites/languages/configurations, error counts, preservation counts, and conditional boundary metrics.
- `results/latency.json` and `results/latency_first_run.json`: medians, p95s, sample sizes, and seven batch means for each stratum.
- `results/environment.json`: final run's package versions, script/corpus hashes, host details, and cold-start samples.
- `results/gsm_integration.json`: all 88 concrete filter probes, expected and actual text, and both implementation paths.
- `results/bulk.json`: book/stress repetitions, sentence counts, hashes, memory measurements, and timeout status.
- `.tmp_test_env/sbd_issue_551/predictions.json`: every input, expectation, output, and score for all 8,475 case/backend pairs; retained locally rather than vendoring external corpora into the project.

Validation: **22 tests passed** across the scorer tests, existing punctuation/filtering tests, and native OCR tests. Ruff lint passed for the new Python files; the required repository-wide formatter ran, with existing files unchanged. All 8,475 comparison calls in each accuracy run completed without a library exception. No issue comment, PR, or external message was posted.
