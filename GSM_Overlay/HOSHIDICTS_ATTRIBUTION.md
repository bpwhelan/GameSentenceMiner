# Hoshidicts Overlay Attribution

The Hoshidicts overlay integration contains or adapts GPL-licensed work from
the following projects:

- [Hoshidicts](https://github.com/Manhhao/hoshidicts/tree/7bfdc8cbfa27f0e94665d76be77d21658bea2f5f),
  pinned as the recursive `GSM_Overlay/input_server/hoshidicts` submodule and
  statically linked into `gsm_overlay_server`. Hoshidicts is licensed under
  GPL-3.0; its complete license is included at
  `GSM_Overlay/input_server/hoshidicts/LICENSE`.
- [Hoshi Reader](https://github.com/Manhhao/Hoshi-Reader/tree/c31c9d0ce376ff83bf6a91d908bf9f8e0fb4947b/Features/Popup),
  whose popup structure and furigana presentation informed
  `features/hoshidicts/reader.js`, `features/hoshidicts/popup.js`, and
  `features/hoshidicts/reader.css`. Hoshi Reader is licensed under GPL-3.0.
- [Yomitan GSM](https://github.com/bpwhelan/yomitan-gsm/tree/006dd464a50a468c71093dc8a8311f6110bf1996),
  the pinned source base for the bundled Yomitan extension and the dark popup
  palette adapted by `features/hoshidicts/reader.css`. Yomitan GSM is licensed under
  GPL-3.0-or-later.

The adapted reader sources and stylesheet carry
`SPDX-License-Identifier: GPL-3.0-or-later` headers. The repository's root
`LICENSE` contains the full GNU GPL version 3 text.

The optional one-click dictionary installer downloads JMdict English (without
proper names) and JMnedict directly from
[yomidevs/jmdict-yomitan](https://github.com/yomidevs/jmdict-yomitan). Those
dictionary releases are licensed under CC BY-SA 4.0 and include EDRDG
attribution in their metadata. Hoshidicts preserves that metadata during
import. KANJIDIC is not included in the recommended term-dictionary bundle.
