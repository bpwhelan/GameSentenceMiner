interface ProcessorInfo {
  id: string;
  labelKey: string;
  descKey: string;
  hasConfig: boolean;
}

export const PROCESSOR_META: ProcessorInfo[] = [
  { id: "string_replacement", labelKey: "textProcessing.processors.stringReplacement", descKey: "textProcessing.processors.stringReplacementDesc", hasConfig: true },
  { id: "remove_repeated_chars", labelKey: "textProcessing.processors.removeRepeatedChars", descKey: "textProcessing.processors.removeRepeatedCharsDesc", hasConfig: false },
  { id: "remove_repeated_lines", labelKey: "textProcessing.processors.removeRepeatedLines", descKey: "textProcessing.processors.removeRepeatedLinesDesc", hasConfig: false },
  { id: "remove_control_chars", labelKey: "textProcessing.processors.removeControlChars", descKey: "textProcessing.processors.removeControlCharsDesc", hasConfig: false },
  { id: "language_filter", labelKey: "textProcessing.processors.languageFilter", descKey: "textProcessing.processors.languageFilterDesc", hasConfig: true },
  { id: "remove_non_japanese", labelKey: "textProcessing.processors.removeNonJapanese", descKey: "textProcessing.processors.removeNonJapaneseDesc", hasConfig: false },
  { id: "remove_newlines", labelKey: "textProcessing.processors.removeNewlines", descKey: "textProcessing.processors.removeNewlinesDesc", hasConfig: false },
  { id: "remove_numbers", labelKey: "textProcessing.processors.removeNumbers", descKey: "textProcessing.processors.removeNumbersDesc", hasConfig: false },
  { id: "remove_english", labelKey: "textProcessing.processors.removeEnglish", descKey: "textProcessing.processors.removeEnglishDesc", hasConfig: false },
  { id: "remove_curly_braces", labelKey: "textProcessing.processors.removeCurlyBraces", descKey: "textProcessing.processors.removeCurlyBracesDesc", hasConfig: false },
  { id: "remove_angle_brackets", labelKey: "textProcessing.processors.removeAngleBrackets", descKey: "textProcessing.processors.removeAngleBracketsDesc", hasConfig: false },
  { id: "extract_bracketed_text", labelKey: "textProcessing.processors.extractBracketedText", descKey: "textProcessing.processors.extractBracketedTextDesc", hasConfig: false },
  { id: "extract_lines", labelKey: "textProcessing.processors.extractLines", descKey: "textProcessing.processors.extractLinesDesc", hasConfig: false },
  { id: "unicode_normalize", labelKey: "textProcessing.processors.unicodeNormalize", descKey: "textProcessing.processors.unicodeNormalizeDesc", hasConfig: false },
];
