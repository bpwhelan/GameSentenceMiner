# FireRed preprocessing regressions

These are original pre-VAD audio clips collected through GSM's VAD debug
recorder on October 30, 2026. Keep the long background sections: cropping them
out removes the filter history needed to reproduce the failure.

With the unchanged FireRed model and 0.4 speech threshold, GSM's previous
`afftdn,dialoguenhance` preprocessing added false speech segments much later
than the opening dialogue. Converting to 16 kHz mono PCM without these filters
keeps the correct early endpoint in both clips.

`cases.json` records the original capture IDs, input hashes, durations and
before/after speech endpoints. The regression tests use the bundled model on
CPU and the real audio conversion path.
