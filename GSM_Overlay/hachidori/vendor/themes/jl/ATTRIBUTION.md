# JL

Based on [rampaa/JL](https://github.com/rampaa/JL), pinned at
`b490928aa3a23eb5d4fa9359961f5b686bc0eaae`.

JL is by rampaa and its contributors and is licensed under Apache-2.0; see
LICENSE.Apache-2.0. The repository's licence carries no separate copyright line.

JL is a Windows desktop app written in C# and WPF, so no code can be ported.
This renderer is new code that adapts JL's popup layout, text formats and
default settings:

- [`PopupContentGenerator.cs`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Windows/GUI/Popup/PopupContentGenerator.cs):
  one block per result, the order and margins of the wrapping top line
  (spelling, reading, audio, deconjugation, frequencies, dictionary name,
  mining button), the definitions below it and the separator line.
- [`PopupWindow.xaml`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Windows/GUI/Popup/PopupWindow.xaml)
  and [`PopupWindow.xaml.cs`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Windows/GUI/Popup/PopupWindow.xaml.cs):
  the dictionary tab row (All, then each dictionary with results in priority
  order) and its button size, spacing and DodgerBlue selection.
- [`ConfigManager.cs`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Windows/Config/ConfigManager.cs):
  default colours and font sizes, Meiryo, and the black background.
- [`PitchAccentDecorator.cs`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Windows/GUI/Popup/PitchAccentDecorator.cs),
  [`PopupWindowUtils.cs`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Windows/Utilities/PopupWindowUtils.cs)
  and [`DictOptionManager.cs`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Windows/Config/DictOptionManager.cs):
  the 1.5 px dotted DeepSkyBlue pitch marker over the reading.
- [`LookupResultUtils.cs`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Core/Lookup/LookupResultUtils.cs),
  [`ProcessNode.cs`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Core/Deconjugation/ProcessNode.cs)
  and [`JmdictRecord.cs`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Core/Dicts/JMdict/JmdictRecord.cs):
  the `#rank` and `Name: rank, …` frequency text, `matched ～step→step`
  deconjugation, and numbered senses after the tags they all share.
- [`YomichanKanjiRecord.cs`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Core/Dicts/KanjiDict/YomichanKanjiRecord.cs)
  and `PopupContentGenerator.GetKanjiText`: kanji meanings, then `On:`, `Kun:`
  and `Statistics:` lines.

Hachidori supplies lookup, deinflection, audio, Anki mining, keyboard
navigation, positioning and pitch rules. No JL engine, dictionary data or
configuration is included. The renderer and stylesheet are GPL-3.0-or-later;
the JL design they adapt keeps this attribution and JL's Apache-2.0 licence.
