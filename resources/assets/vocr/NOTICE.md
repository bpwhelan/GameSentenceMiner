# VOCR models

These are GSM's FP32 ONNX conversions of bee-san/vita-vn-ocr release
v0.5.0, revision `205f47ec4e56ca87c00e7dba0a61c9aaec726707`:

| GSM graph | Original weights |
| --- | --- |
| small-faithful.onnx | VOCR6.2_S_w8.vocr |
| normal-faithful.onnx | VOCR6.2_N_w8g2.vocr |
| large-faithful.onnx | VOCR6.2_L_w8_2l.vocr |
| large-fast.onnx | VOCR6.2_L_w8_2l.vocr |
| textspot8-faithful.onnx | textspot8_t64n8c16_w8.vtsp |

The models were converted, not retrained. `manifest.json` pins the exported
graphs' SHA-256 hashes; each graph embeds its original weight hash and provenance.
The MIDA pairing uses the fast large recognizer. GSM runs these graphs with ONNX Runtime's CPU provider.

Original notices are preserved in `VOCR6-ATTRIBUTION.md`,
`SPOTTER-ATTRIBUTION.md`, and `COPYING`. The upstream code is GPL-3.0-or-later.
The upstream model notices require **non-commercial use only**, including for
these converted weights. Conversion does not change those terms.

Conversion source and reproduction instructions are archived in the [export script](https://github.com/bpwhelan/GameSentenceMiner/blob/107f310ea86b55add2d2ee9e2a1abbfd29b32d07/scripts/export_vocr_onnx.py) and the [model build notes](https://github.com/bpwhelan/GameSentenceMiner/blob/107f310ea86b55add2d2ee9e2a1abbfd29b32d07/docs/VOCR_ONNX.md).
