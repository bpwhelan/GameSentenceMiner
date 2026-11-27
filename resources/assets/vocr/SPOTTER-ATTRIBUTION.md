# Text spotter textspot8, pre-release v0.3.10-textspot8.1: licences and attribution

`textspot8_t64n8c16_w8.vtsp` (52,176 B) holds the int8 weights of a dialogue-line spotter from textspot8 (issue #149,
`docs/textspot8.md`, `eval/textspot8_protocol.json`). The code is bee-san/vita-vn-ocr's (GPL-3.0-or-later). The blob
is a VTSP version 4 file with a VTDT trunk (textspot6's family T, shape `t64n8c16`), run by `runtime/vocr_textspot6.c`
(it runs with or without `VOCR_TEXTSPOT6_NO_MS`).

**Selected.** textspot8's pre-registered rule picked this model: `t8_t64n8c16`, the crop decode, seed 3
(`eval/textspot8_dev_20261027.json`, `eval/textspot8_confirm_20261027.json`). This blob is that recipe and seed
retrained on the hooked pool's train, guard and hval pages, as the rule says.

## What the spotter was trained on

The shards are pinned by these manifests:
- `data/manifests/textspot6_pages_v1.json`
- `data/manifests/textspot_shards_v1.json`
- `data/manifests/textspot2_shards_v1.json`

None of them is redistributed. The mix per training window was hooked pages 0.5, synthetic frames 0.25 and real
screenshots 0.25 (the run's own record, `run.json` `pool`). textspot8 drew synthetic animated-icon marks (spinners,
page cursors, stars, rings) on the windows procedurally; no further data was used.

- **The owner's hooked pages** (issue #125): 54,771 native PS Vita and PSP frames of 48 titles, the page pool's
  train, guard and hval splits, captured by the owner. Each frame comes with the game's own text from a memory hook and the
  renderer's line boxes.
  - The positives are the verified dialogue and speaker-name lines, their boxes refined to ink.
  - Text the hook does not cover got "not dialogue" labels: boxes from MeikiOCR's detector (`teacher/engines.Meiki`;
    Apache-2.0 code, LGPL-3.0 weights). MeikiOCR gave training labels only; its weights are not in this blob and are
    not shipped.
  - The frames are copyrighted game images and stay private.
- **Synthetic whole frames** (80,000, of which 12,070 are text-free): textspot's, rendered in synth3's `personal`
  profile. That profile includes:
  - two fonts free for non-commercial use only (JF Dot non-commercial, Zpix);
  - non-commercial text pools: JDD and NUCC (CC BY-NC-ND 4.0), BSD (CC BY-NC-SA 4.0), and Aratako's gpt-4o-mini
    roleplay (CC BY-NC-SA 4.0 and OpenAI's terms);
  - text of unclear licence (OpenSubtitles, なりきり posts).

  The full lists with licences are `data/manifests/synth3_fonts.json` and `data/manifests/synth3_text_sources.json`.
  Because of these inputs, **use these weights for non-commercial purposes only**.

  The scenes are crops of training-side VNDB screenshots (textgate's clean pool; VNDB's terms as below). They belong
  to their publishers and are not redistributed.
- **Real screenshots** (52,785 canvases): textspot2's real half.
  - PS Vita, PSP and scaled PC screenshots on VNDB (https://vndb.org; database ODbL 1.0, contents DbCL 1.0), with
    MeikiOCR's boxes refined to ink as labels: the distillation set.
  - The owner's own console captures (private), among them planetarian's PSP port (v34).
  - The screenshots belong to their publishers and are not redistributed.
- **Not used:**
  - NVIDIA OCR-Synthetic-Multilingual-v1;
  - CLANNAD's own releases;
  - the hooked test title (Dance with Devils, PCSG00807);
  - the frames of vita-test, psp-test, the development sample and vocr6-spotter3's confirmation set (whose 41 VNs
    the training sources do not hold: checked before its read).
- **Related titles, disclosed:**
  - The hooked training titles include one development VN, v12188 (PCSG00576). The headline development score
    leaves it out.
  - Three training titles share a VNDB release with a protected set: PCSG00007 (v5) and ULJM05383 (v34) share
    release r3748 with CLANNAD (v4), and PCSG00866 (v18160) shares four releases with v21789, one of vita-test's VNs.
  - The owner's 2026-10-25 data policy allows them: it excludes only CLANNAD's own releases.

## Licence of the weights

The weights are released under the repository's licence (GPL-3.0-or-later), subject to the non-commercial terms of
the training inputs above.
