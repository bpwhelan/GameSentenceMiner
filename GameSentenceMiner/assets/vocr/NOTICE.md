# Bundled VOCR models

These are GSM's FP32 faithful ONNX conversions of bee-san/vita-vn-ocr release
v0.5.0, revision `205f47ec4e56ca87c00e7dba0a61c9aaec726707`:

| Bundled graph | Original weights |
| --- | --- |
| small-faithful.onnx | VOCR6.2_S_w8.vocr |
| normal-faithful.onnx | VOCR6.2_N_w8g2.vocr |
| large-faithful.onnx | VOCR6.2_L_w8_2l.vocr |
| textspot8-faithful.onnx | textspot8_t64n8c16_w8.vtsp |

The models were converted, not retrained. `manifest.json` pins the exported
graphs' SHA-256 hashes; each graph embeds its original weight hash and provenance.
Only faithful graphs are distributed. GSM runs them with ONNX Runtime's CPU
provider, one inference thread, and the Python geometry/decoding implementation.

Original notices are preserved in `VOCR6-ATTRIBUTION.md`,
`SPOTTER-ATTRIBUTION.md`, and `COPYING`. The upstream code is GPL-3.0-or-later.
The upstream model notices require **non-commercial use only**, including for
these converted weights. Conversion does not change those terms.

Conversion source and reproduction instructions are included in GSM's
`scripts/export_vocr_onnx.py` and `docs/VOCR_ONNX.md` at
https://github.com/bpwhelan/GameSentenceMiner.
Pinned upstream source:
https://github.com/bee-san/vita-vn-ocr/tree/205f47ec4e56ca87c00e7dba0a61c9aaec726707.
