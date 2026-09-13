/*
 * Trusted starter dictionaries shared by setup, Settings and the engine worker.
 * Everything either page says about the set, and each entry's first-install
 * option, comes from here.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const RECOMMENDED_DICTIONARIES = Object.freeze(
  [
    {
      sourceId: "jitendex",
      name: "Jitendex",
      description: "Japanese–English terms",
      publisherUrl: "https://jitendex.org/",
      downloadUrl:
        "https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip",
      indexUrl: "https://jitendex.org/static/yomitan.json",
      archiveName: "jitendex-yomitan.zip",
      githubRepository: "stephenmk/stephenmk.github.io",
      githubRepositoryId: "744330420",
      requiredCapability: "term",
      titlePattern: String.raw`^Jitendex\.org \[\d{4}-\d{2}-\d{2}\]$`,
      topic: "words",
      firstInstallOption: "compactDefinitionSummaryDictionary",
    },
    {
      sourceId: "jmnedict",
      name: "JMnedict for Yomitan",
      description: "Japanese proper names",
      publisherUrl: "https://github.com/yomidevs/jmdict-yomitan",
      downloadUrl:
        "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.zip",
      indexUrl:
        "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.json",
      archiveName: "JMnedict.zip",
      githubRepository: "yomidevs/jmdict-yomitan",
      githubRepositoryId: "696075636",
      requiredCapability: "term",
      titlePattern: String.raw`^JMnedict \[\d{4}-\d{2}-\d{2}\]$`,
      topic: "names",
      firstInstallOption: null,
    },
    {
      sourceId: "bees-ultimate-kanji-dictionary",
      name: "Bee's Ultimate Kanji Dictionary",
      description: "Rich single-kanji definitions",
      publisherUrl: "https://github.com/bee-san/bees-ultimate-kanji-dictionary",
      downloadUrl:
        "https://github.com/bee-san/bees-ultimate-kanji-dictionary/releases/latest/download/bees-ultimate-kanji-dictionary.zip",
      indexUrl:
        "https://raw.githubusercontent.com/bee-san/bees-ultimate-kanji-dictionary/main/dist/index.json",
      archiveName: "bees-ultimate-kanji-dictionary.zip",
      githubRepository: "bee-san/bees-ultimate-kanji-dictionary",
      githubRepositoryId: "1335822804",
      requiredCapability: "term",
      titlePattern: "^Bee's Ultimate Kanji Dictionary$",
      topic: "kanji",
      firstInstallOption: "kanjiClickDictionary",
    },
    {
      sourceId: "jiten",
      name: "Jiten Frequency Dictionary",
      description: "Global word frequency ranks",
      publisherUrl: "https://jiten.moe/frequency-dictionaries",
      downloadUrl:
        "https://api.jiten.moe/api/frequency-list/download?downloadType=yomitan",
      indexUrl: "https://api.jiten.moe/api/frequency-list/index",
      archiveName: "jiten-frequency.zip",
      githubRepository: null,
      githubRepositoryId: null,
      requiredCapability: "freq",
      titlePattern: "^Jiten$",
      topic: "frequency",
      firstInstallOption: null,
    },
    {
      sourceId: "bees-ultimate-grammar-dictionary",
      name: "Bee's Ultimate Grammar Dictionary",
      description: "Japanese grammar points, ten sources in one",
      publisherUrl:
        "https://github.com/bee-san/bees-ultimate-grammar-dictionary",
      downloadUrl:
        "https://github.com/bee-san/bees-ultimate-grammar-dictionary/releases/latest/download/bees-ultimate-grammar-dictionary.zip",
      indexUrl:
        "https://raw.githubusercontent.com/bee-san/bees-ultimate-grammar-dictionary/main/dist/index.json",
      archiveName: "bees-ultimate-grammar-dictionary.zip",
      githubRepository: "bee-san/bees-ultimate-grammar-dictionary",
      githubRepositoryId: "1363159785",
      requiredCapability: "term",
      titlePattern: "^Bee's Ultimate Grammar Dictionary$",
      topic: "grammar",
      firstInstallOption: null,
    },
  ].map((entry) => Object.freeze(entry)),
);

const COUNT_WORDS = Object.freeze(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);

// The set's size and topics as prose, e.g. "five" and "words, names and kanji".
export function describeRecommendedCatalogue() {
  const size = RECOMMENDED_DICTIONARIES.length;
  return {
    count: COUNT_WORDS[size - 1] ?? String(size),
    topics: new Intl.ListFormat("en-GB", { type: "conjunction" })
      .format(RECOMMENDED_DICTIONARIES.map((entry) => entry.topic)),
  };
}
