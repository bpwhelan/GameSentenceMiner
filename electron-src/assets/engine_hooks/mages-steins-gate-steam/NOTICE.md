# STEINS;GATE engine-hook resources

`charset.utf8` and `compound_chars.map` are sourced from Committee of Zero's
[`sc3tools`](https://github.com/CommitteeOfZero/sc3tools) project and are used
under the MIT License:

Copyright (c) Committee of Zero

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The Frida payload and GSM integration code in this directory were implemented
independently for GameSentenceMiner. They do not load, modify, or invoke Agent
scripts.

`charset_overrides.json` records the slot-specific display-character choices
used by the installed `PC_Steam_MAGES_Steins;Gate.js` Agent script. Keeping
these overrides separate from the upstream charset is necessary because some
source glyphs, such as `曰`, `棲`, and `風`, are also legitimate characters in
other slots and cannot safely be replaced globally.
