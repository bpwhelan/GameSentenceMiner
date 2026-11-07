# VOCR6 recognizers (vita-vn-ocr v0.4.1-vocr6.2): licences and attribution

`VOCR6.2_S_w8.vocr`, `VOCR6.2_N_w8.vocr` and `VOCR6.2_L_w8.vocr` are int8 weights of the CTC line recognizer of
bee-san/vita-vn-ocr (GPL-3.0-or-later code), for Rubi's Small, Normal and Large tiers. `VOCR6.2_N_w8g2.vocr` is the
Normal weights with #120's head gate (ε = 1e-4) and #122's two-level head appended; `VOCR6.2_L_w8_2l.vocr` is the
Large weights with the two-level head alone. Both are speed-only sections fit on each blob's own outputs. Small has
none: the head-gate rule kept no gate for it. This release ships no language model. Rubi pins the game-text LMs of
v0.3.7-lm6.2, whose ATTRIBUTION.md covers them.

These weights replace v0.4.0-vocr6.1's VOCR6-N and VOCR6-L (`VOCR6_N_w8*.vocr`, `VOCR6_L_w8*.vocr`) and VOCR5-S.

## What the recognizers were trained on

Each tier starts from a VOCR5 checkpoint of its tier: seed 1 of VOCR5's recipe (`v5f_S_seed1`, `v5f_N_seed1`,
`v5f_L_seed1`), trained on everything v0.3.0's ATTRIBUTION.md lists. It is then fine-tuned again on the sources below
(Normal and Large for 45,000 steps, Small for 15,000 at half the learning rate).

- **The owner's hooked PS Vita and PSP corpus (private).** These are native frames the owner captured on his own
  consoles, labelled with each game's own hooked dialogue text and line boxes (vita-vn-ocr #125,
  `docs/vocr6-data.md`). It covers 49 titles, with all pages but the test title's: train pages, the hval pages and
  their guard bands. The frames and texts are the publishers' copyrighted game data. They were used as training input
  only. Nothing of them is redistributed; the repository holds ids, hashes and counts only. The test title (Dance
  with Devils, PCSG00807) and CLANNAD were not trained on.
- **Console crops of the same pages.** The line finder Rubi ships, run on those pages, with its crops labelled from
  the hooked text (`data/console_crops.py`, crops v2). They are private and not redistributed.
- **VOCR5's real pools**, as `eval/vocr5_pools.sha256` pins them:
  - lines from PS Vita, PSP and scaled PC screenshots on VNDB (https://vndb.org; database ODbL 1.0, contents DbCL
    1.0), labelled by local OCR engines and reviewed by Claude (Anthropic), with a Codex second vote in realplus v3;
    the screenshots belong to their publishers and are not redistributed;
  - the owner's earlier console captures (owner pools v1 and v2, private).
- **Synthetic replay, as in VOCR5's fine-tune:**
  - **NVIDIA OCR-Synthetic-Multilingual-v1** (Chesler, 2026),
    https://huggingface.co/datasets/nvidia/OCR-Synthetic-Multilingual-v1, revision
    `69696a1cc543ef3a0f8e9892a89c17293e915263`, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Its
    Japanese line crops are modified (cut from the pages, grey, height 32, out-of-vocabulary lines dropped) and are not
    redistributed.
  - **synth2, synth3 v3 and synth4** (`s4v5631`). These renders use the generators' `personal` profile. That profile
    adds two fonts free for non-commercial use only (JF Dot non-commercial, Zpix), non-commercial text pools (JDD and
    NUCC: CC BY-NC-ND 4.0; BSD: CC BY-NC-SA 4.0; Aratako's gpt-4o-mini roleplay: CC BY-NC-SA 4.0 and OpenAI's
    terms), text of unclear licence (OpenSubtitles, なりきり posts) and two fonts the owner supplied
    (`data/manifests/synth3_text_sources.json`). Their scenes are crops of training-side VNDB screenshots.
- **The vocabularies.** Normal and Large use `data/vocab_vn_5631.txt` and Small uses `data/vocab_4987_proof.txt`.
  Both are ordered by Jiten's word and kanji frequency lists (https://jiten.moe/frequency-dictionaries,
  CC BY-SA 4.0).

**Use these weights for non-commercial purposes only.** The synthetic inputs above carry non-commercial terms, and
the hooked corpus is copyrighted game data used for training only.

## Disclosures for test-set numbers

- Two hooked train titles draw dialogue in a font whose 32 px glyphs are CLANNAD's own raster, re-quantised:
  PCSG00620 Grisaia Spinout and PCSG00007 Little Busters! (`docs/synth6.md`). Every VOCR6 model has seen that raster
  for 1,234 characters, though not CLANNAD's font files, text or pages.
- Little Busters! and planetarian share the Key 10th Memorial BOX with CLANNAD. Collar x Malice (PCSG00866) shares
  releases with vita-test's Collar x Malice -Unlimited-. 38 of the 49 hooked titles' VNs were already in VOCR5's own
  fine-tune pools.
