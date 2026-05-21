import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeIpc, onIpc } from "../../lib/ipc";
import { useTranslation } from "../../i18n";

interface TextReplacementRule {
  enabled: boolean;
  mode: string;
  find: string;
  replace: string;
  case_sensitive: boolean;
  whole_word: boolean;
}

interface TextProcessingConfig {
  string_replacement: {
    enabled: boolean;
    rules: TextReplacementRule[];
  };
  processor_order: string[];
  remove_repeated_chars: boolean;
  remove_repeated_chars_config: { repeat_count: number; keep_non_repeated: boolean };
  remove_repeated_lines: boolean;
  remove_repeated_lines_config: { repeat_count: number };
  remove_control_chars: boolean;
  remove_non_japanese: boolean;
  remove_newlines: boolean;
  remove_numbers: boolean;
  remove_english: boolean;
  remove_curly_braces: boolean;
  remove_angle_brackets: boolean;
  extract_bracketed_text: boolean;
  extract_lines: boolean;
  extract_lines_config: { max_lines: number; from_end: boolean };
  unicode_normalize: boolean;
  unicode_normalize_config: { form: string };
}

interface LatestTextProcessingInput {
  text: string;
  processed_text?: string;
  source?: string;
  source_display_name?: string;
  time?: string;
}

interface ProcessorInfo {
  id: string;
  labelKey: string;
  descKey: string;
  hasConfig: boolean;
}

const PROCESSOR_META: ProcessorInfo[] = [
  { id: "string_replacement", labelKey: "textProcessing.processors.stringReplacement", descKey: "textProcessing.processors.stringReplacementDesc", hasConfig: true },
  { id: "remove_repeated_chars", labelKey: "textProcessing.processors.removeRepeatedChars", descKey: "textProcessing.processors.removeRepeatedCharsDesc", hasConfig: false },
  { id: "remove_repeated_lines", labelKey: "textProcessing.processors.removeRepeatedLines", descKey: "textProcessing.processors.removeRepeatedLinesDesc", hasConfig: false },
  { id: "remove_control_chars", labelKey: "textProcessing.processors.removeControlChars", descKey: "textProcessing.processors.removeControlCharsDesc", hasConfig: false },
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

function getDefaultConfig(): TextProcessingConfig {
  return {
    string_replacement: { enabled: false, rules: [] },
    processor_order: PROCESSOR_META.map((p) => p.id),
    remove_repeated_chars: false,
    remove_repeated_chars_config: { repeat_count: 1, keep_non_repeated: true },
    remove_repeated_lines: false,
    remove_repeated_lines_config: { repeat_count: 1 },
    remove_control_chars: false,
    remove_non_japanese: false,
    remove_newlines: false,
    remove_numbers: false,
    remove_english: false,
    remove_curly_braces: false,
    remove_angle_brackets: false,
    extract_bracketed_text: false,
    extract_lines: false,
    extract_lines_config: { max_lines: 3, from_end: true },
    unicode_normalize: false,
    unicode_normalize_config: { form: "NFKC" },
  };
}

function normalizeConfig(rawConfig: Partial<TextProcessingConfig> | null | undefined): TextProcessingConfig {
  const defaults = getDefaultConfig();
  const raw = rawConfig ?? {};
  const allIds = PROCESSOR_META.map((p) => p.id);
  const rawOrder = Array.isArray(raw.processor_order) ? raw.processor_order : defaults.processor_order;
  const missing = allIds.filter((id) => !rawOrder.includes(id));

  return {
    ...defaults,
    ...raw,
    string_replacement: {
      ...defaults.string_replacement,
      ...raw.string_replacement,
      rules: Array.isArray(raw.string_replacement?.rules) ? raw.string_replacement.rules : [],
    },
    processor_order: [...rawOrder.filter((id) => allIds.includes(id)), ...missing],
    remove_repeated_chars_config: {
      ...defaults.remove_repeated_chars_config,
      ...raw.remove_repeated_chars_config,
    },
    remove_repeated_lines_config: {
      ...defaults.remove_repeated_lines_config,
      ...raw.remove_repeated_lines_config,
    },
    extract_lines_config: {
      ...defaults.extract_lines_config,
      ...raw.extract_lines_config,
    },
    unicode_normalize_config: {
      ...defaults.unicode_normalize_config,
      ...raw.unicode_normalize_config,
    },
  };
}

function isProcessorEnabled(config: TextProcessingConfig, id: string): boolean {
  if (id === "string_replacement") return config.string_replacement.enabled;
  return (config as any)[id] ?? false;
}

function setProcessorEnabled(config: TextProcessingConfig, id: string, enabled: boolean): TextProcessingConfig {
  const next = { ...config };
  if (id === "string_replacement") {
    next.string_replacement = { ...next.string_replacement, enabled };
  } else {
    (next as any)[id] = enabled;
  }
  return next;
}

interface TextProcessingTabProps {
  active: boolean;
}

export function TextProcessingTab({ active }: TextProcessingTabProps) {
  const t = useTranslation();
  const [config, setConfig] = useState<TextProcessingConfig>(getDefaultConfig());
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [expandedProcessor, setExpandedProcessor] = useState<string | null>(null);
  const [previewInput, setPreviewInput] = useState("");
  const [previewOutput, setPreviewOutput] = useState("");
  const [followingLatestText, setFollowingLatestText] = useState(true);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragItem = useRef<number | null>(null);
  const dragOver = useRef<number | null>(null);

  const showNotice = useCallback((msg: string, type: "success" | "error") => {
    setNotice({ type, msg });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  useEffect(() => {
    if (!active) return;
    invokeIpc<Partial<TextProcessingConfig> | null>("textprocess.load").then((cfg) => {
      setConfig(normalizeConfig(cfg));
      setLoaded(true);
    });
  }, [active]);

  useEffect(() => {
    if (!active) return;

    const useLatestText = (latest: LatestTextProcessingInput | null | undefined) => {
      if (!latest || typeof latest.text !== "string" || !latest.text) return;
      setPreviewInput((current) => {
        if (!followingLatestText && current) return current;
        return latest.text;
      });
    };

    invokeIpc<LatestTextProcessingInput | null>("textprocess.latestText")
      .then(useLatestText)
      .catch(() => {});

    return onIpc("textprocess-latest-text", (_event, payload) => {
      useLatestText(payload as LatestTextProcessingInput);
    });
  }, [active, followingLatestText]);

  const updateConfig = useCallback((updater: (prev: TextProcessingConfig) => TextProcessingConfig) => {
    setConfig((prev) => {
      const next = updater(prev);
      setDirty(true);
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const result = await invokeIpc<{ success: boolean; error?: string }>("textprocess.save", config);
    setSaving(false);
    if (result.success) {
      setDirty(false);
      showNotice(t("textProcessing.saved"), "success");
    } else {
      showNotice(result.error || t("textProcessing.saveFailed"), "error");
    }
  }, [config, showNotice, t]);

  const moveProcessor = useCallback((fromIndex: number, toIndex: number) => {
    updateConfig((prev) => {
      const order = [...prev.processor_order];
      const [moved] = order.splice(fromIndex, 1);
      order.splice(toIndex, 0, moved);
      return { ...prev, processor_order: order };
    });
  }, [updateConfig]);

  const handleDragStart = useCallback((index: number) => {
    dragItem.current = index;
  }, []);

  const handleDragEnter = useCallback((index: number) => {
    dragOver.current = index;
  }, []);

  const handleDragEnd = useCallback(() => {
    if (dragItem.current !== null && dragOver.current !== null && dragItem.current !== dragOver.current) {
      moveProcessor(dragItem.current, dragOver.current);
    }
    dragItem.current = null;
    dragOver.current = null;
  }, [moveProcessor]);

  // Client-side preview
  const computePreview = useCallback((input: string) => {
    if (!input) { setPreviewOutput(""); return; }
    let text = input;
    for (const processorId of config.processor_order) {
      if (!isProcessorEnabled(config, processorId)) continue;
      text = applyProcessorPreview(text, processorId, config);
    }
    setPreviewOutput(text);
  }, [config]);

  useEffect(() => {
    computePreview(previewInput);
  }, [previewInput, computePreview]);

  const orderedProcessors = useMemo(() => {
    return config.processor_order.map((id) => PROCESSOR_META.find((p) => p.id === id)!).filter(Boolean);
  }, [config.processor_order]);

  if (!active) return null;

  if (!loaded) {
    return (
      <div className="tab-panel active text-processing-panel">
        <div className="text-processing-loading">{t("textProcessing.loading")}</div>
      </div>
    );
  }

  return (
    <div className="tab-panel active text-processing-panel">
      <div className="text-processing-container">
        {/* Header */}
        <div className="text-processing-header">
          <h2>{t("textProcessing.title")}</h2>
          <p className="text-processing-subtitle">{t("textProcessing.subtitle")}</p>
          <div className="text-processing-actions">
            <button className="btn-primary" onClick={handleSave} disabled={saving || !dirty}>
              {saving ? t("textProcessing.saving") : t("textProcessing.save")}
            </button>
            {notice && (
              <span className={`notice-badge ${notice.type}`}>{notice.msg}</span>
            )}
          </div>
        </div>

        {/* Processor List */}
        <div className="text-processing-processors">
          <h3>{t("textProcessing.processorListTitle")}</h3>
          <p className="text-processing-hint">{t("textProcessing.dragToReorder")}</p>
          <div className="processor-list">
            {orderedProcessors.map((proc, index) => (
              <div
                key={proc.id}
                className={`processor-item ${isProcessorEnabled(config, proc.id) ? "enabled" : "disabled"}`}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragEnter={() => handleDragEnter(index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => e.preventDefault()}
              >
                <div className="processor-item-main">
                  <span className="processor-drag-handle">⠿</span>
                  <label className="processor-toggle">
                    <input
                      type="checkbox"
                      checked={isProcessorEnabled(config, proc.id)}
                      onChange={(e) => updateConfig((c) => setProcessorEnabled(c, proc.id, e.target.checked))}
                    />
                    <span className="processor-name">{t(proc.labelKey)}</span>
                  </label>
                  <span className="processor-desc">{t(proc.descKey)}</span>
                  <div className="processor-item-actions">
                    <button
                      className="btn-icon"
                      onClick={() => moveProcessor(index, Math.max(0, index - 1))}
                      disabled={index === 0}
                      title={t("textProcessing.moveUp")}
                    >▲</button>
                    <button
                      className="btn-icon"
                      onClick={() => moveProcessor(index, Math.min(orderedProcessors.length - 1, index + 1))}
                      disabled={index === orderedProcessors.length - 1}
                      title={t("textProcessing.moveDown")}
                    >▼</button>
                    {proc.hasConfig && (
                      <button
                        className="btn-icon btn-config"
                        onClick={() => setExpandedProcessor(expandedProcessor === proc.id ? null : proc.id)}
                        title={t("textProcessing.configure")}
                      >⚙</button>
                    )}
                  </div>
                </div>

                {/* Expanded config panels */}
                {expandedProcessor === proc.id && proc.hasConfig && (
                  <div className="processor-config-panel">
                    {proc.id === "string_replacement" && (
                      <StringReplacementConfig
                        rules={config.string_replacement.rules}
                        onChange={(rules) => updateConfig((c) => ({
                          ...c, string_replacement: { ...c.string_replacement, rules }
                        }))}
                      />
                    )}
                    {proc.id === "remove_repeated_chars" && (
                      <div className="config-row">
                        <label>
                          {t("textProcessing.config.repeatCount")}
                          <input
                            type="number" min={1} max={100}
                            value={config.remove_repeated_chars_config.repeat_count}
                            onChange={(e) => updateConfig((c) => ({
                              ...c, remove_repeated_chars_config: { ...c.remove_repeated_chars_config, repeat_count: parseInt(e.target.value) || 1 }
                            }))}
                          />
                          <span className="config-hint">{t("textProcessing.config.repeatCountHint")}</span>
                        </label>
                        <label className="config-checkbox">
                          <input
                            type="checkbox"
                            checked={config.remove_repeated_chars_config.keep_non_repeated}
                            onChange={(e) => updateConfig((c) => ({
                              ...c, remove_repeated_chars_config: { ...c.remove_repeated_chars_config, keep_non_repeated: e.target.checked }
                            }))}
                          />
                          {t("textProcessing.config.keepNonRepeated")}
                        </label>
                      </div>
                    )}
                    {proc.id === "remove_repeated_lines" && (
                      <div className="config-row">
                        <label>
                          {t("textProcessing.config.repeatCount")}
                          <input
                            type="number" min={1} max={100}
                            value={config.remove_repeated_lines_config.repeat_count}
                            onChange={(e) => updateConfig((c) => ({
                              ...c, remove_repeated_lines_config: { ...c.remove_repeated_lines_config, repeat_count: parseInt(e.target.value) || 1 }
                            }))}
                          />
                          <span className="config-hint">{t("textProcessing.config.repeatCountHint")}</span>
                        </label>
                      </div>
                    )}
                    {proc.id === "extract_lines" && (
                      <div className="config-row">
                        <label>
                          {t("textProcessing.config.maxLines")}
                          <input
                            type="number" min={1} max={1000}
                            value={config.extract_lines_config.max_lines}
                            onChange={(e) => updateConfig((c) => ({
                              ...c, extract_lines_config: { ...c.extract_lines_config, max_lines: parseInt(e.target.value) || 3 }
                            }))}
                          />
                        </label>
                        <label className="config-checkbox">
                          <input
                            type="checkbox"
                            checked={config.extract_lines_config.from_end}
                            onChange={(e) => updateConfig((c) => ({
                              ...c, extract_lines_config: { ...c.extract_lines_config, from_end: e.target.checked }
                            }))}
                          />
                          {t("textProcessing.config.fromEnd")}
                        </label>
                      </div>
                    )}
                    {proc.id === "unicode_normalize" && (
                      <div className="config-row">
                        <label>
                          {t("textProcessing.config.normalizeForm")}
                          <select
                            value={config.unicode_normalize_config.form}
                            onChange={(e) => updateConfig((c) => ({
                              ...c, unicode_normalize_config: { ...c.unicode_normalize_config, form: e.target.value }
                            }))}
                          >
                            <option value="NFKC">NFKC</option>
                            <option value="NFC">NFC</option>
                            <option value="NFD">NFD</option>
                            <option value="NFKD">NFKD</option>
                          </select>
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Live Preview */}
        <div className="text-processing-preview">
          <h3>{t("textProcessing.preview")}</h3>
          <div className="preview-grid">
            <div className="preview-col">
              <label>{t("textProcessing.previewInput")}</label>
              <textarea
                value={previewInput}
                onChange={(e) => {
                  setFollowingLatestText(false);
                  setPreviewInput(e.target.value);
                }}
                placeholder={t("textProcessing.previewPlaceholder")}
                rows={4}
              />
            </div>
            <div className="preview-col">
              <label>{t("textProcessing.previewOutput")}</label>
              <textarea value={previewOutput} readOnly rows={4} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- String Replacement Sub-Component ---

interface StringReplacementConfigProps {
  rules: TextReplacementRule[];
  onChange: (rules: TextReplacementRule[]) => void;
}

function StringReplacementConfig({ rules, onChange }: StringReplacementConfigProps) {
  const t = useTranslation();

  const addRule = () => {
    onChange([...rules, { enabled: true, mode: "plain", find: "", replace: "", case_sensitive: false, whole_word: false }]);
  };

  const removeRule = (index: number) => {
    onChange(rules.filter((_, i) => i !== index));
  };

  const updateRule = (index: number, updates: Partial<TextReplacementRule>) => {
    onChange(rules.map((r, i) => i === index ? { ...r, ...updates } : r));
  };

  return (
    <div className="string-replacement-config">
      <div className="replacement-rules-list">
        {rules.map((rule, index) => (
          <div key={index} className={`replacement-rule ${rule.enabled ? "" : "disabled"}`}>
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => updateRule(index, { enabled: e.target.checked })}
              title={t("textProcessing.rules.toggleEnabled")}
            />
            <select
              value={rule.mode}
              onChange={(e) => updateRule(index, { mode: e.target.value })}
              className="rule-mode-select"
            >
              <option value="plain">{t("textProcessing.rules.plain")}</option>
              <option value="regex">{t("textProcessing.rules.regex")}</option>
            </select>
            <input
              type="text"
              value={rule.find}
              onChange={(e) => updateRule(index, { find: e.target.value })}
              placeholder={t("textProcessing.rules.findPlaceholder")}
              className="rule-find-input"
            />
            <span className="rule-arrow">→</span>
            <input
              type="text"
              value={rule.replace}
              onChange={(e) => updateRule(index, { replace: e.target.value })}
              placeholder={t("textProcessing.rules.replacePlaceholder")}
              className="rule-replace-input"
            />
            <label className="rule-option" title={t("textProcessing.rules.caseSensitive")}>
              <input
                type="checkbox"
                checked={rule.case_sensitive}
                onChange={(e) => updateRule(index, { case_sensitive: e.target.checked })}
              />
              Aa
            </label>
            <label className="rule-option" title={t("textProcessing.rules.wholeWord")}>
              <input
                type="checkbox"
                checked={rule.whole_word}
                onChange={(e) => updateRule(index, { whole_word: e.target.checked })}
              />
              \\b
            </label>
            <button className="btn-icon btn-danger" onClick={() => removeRule(index)} title={t("textProcessing.rules.remove")}>✕</button>
          </div>
        ))}
      </div>
      <button className="btn-secondary" onClick={addRule}>{t("textProcessing.rules.addRule")}</button>
    </div>
  );
}

// --- Client-Side Preview Logic ---

function applyProcessorPreview(text: string, processorId: string, config: TextProcessingConfig): string {
  switch (processorId) {
    case "string_replacement":
      return applyStringReplacementPreview(text, config.string_replacement.rules);
    case "remove_repeated_chars":
      return removeRepeatedCharsPreview(text, config.remove_repeated_chars_config);
    case "remove_repeated_lines":
      return removeRepeatedLinesPreview(text, config.remove_repeated_lines_config);
    case "remove_control_chars":
      return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    case "remove_non_japanese":
      // Simplified: keep CJK, kana, katakana, punctuation, ASCII
      return text.replace(/[^\u0000-\u007F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF\u2000-\u206F]/g, "");
    case "remove_newlines":
      return text.split(/\r?\n/).filter(Boolean).join(" ");
    case "remove_numbers":
      return text.replace(/[0-9]+/g, "");
    case "remove_english":
      return text.replace(/[a-zA-Z]+/g, "");
    case "remove_curly_braces": {
      let t2 = text.replace(/\{(\w+)(.*?)\}(.*?)\{\/\1\}/g, "$3");
      t2 = t2.replace(/\{([^}]?)[:/](.*?)\}/g, "$1");
      t2 = t2.replace(/\{.*?\}/g, "");
      return t2;
    }
    case "remove_angle_brackets": {
      let _prev: string;
      let _result = text;
      do {
        _prev = _result;
        _result = _result.replace(/<[^>]*>/g, "");
      } while (_result !== _prev);
      return _result;
    }
    case "extract_bracketed_text": {
      const start = text.indexOf("「");
      const end = text.lastIndexOf("」");
      if (start >= 0 && end > start) return text.slice(start + 1, end);
      return text;
    }
    case "extract_lines": {
      const lines = text.split(/\r?\n/);
      const max = config.extract_lines_config.max_lines;
      if (lines.length <= max) return text;
      if (config.extract_lines_config.from_end) return lines.slice(-max).join("\n");
      return lines.slice(0, max).join("\n");
    }
    case "unicode_normalize":
      return text.normalize(config.unicode_normalize_config.form as any);
    default:
      return text;
  }
}

function applyStringReplacementPreview(text: string, rules: TextReplacementRule[]): string {
  for (const rule of rules) {
    if (!rule.enabled || !rule.find) continue;
    if (rule.mode === "regex") {
      try {
        const flags = rule.case_sensitive ? "g" : "gi";
        let pattern = rule.find;
        if (rule.whole_word) pattern = `\\b${pattern}\\b`;
        text = text.replace(new RegExp(pattern, flags), rule.replace);
      } catch { /* invalid regex, skip */ }
    } else {
      if (rule.case_sensitive && !rule.whole_word) {
        text = text.split(rule.find).join(rule.replace);
      } else {
        let pattern = rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (rule.whole_word) pattern = `\\b${pattern}\\b`;
        const flags = rule.case_sensitive ? "g" : "gi";
        text = text.replace(new RegExp(pattern, flags), rule.replace);
      }
    }
  }
  return text;
}

function removeRepeatedCharsPreview(text: string, cfg: { repeat_count: number; keep_non_repeated: boolean }): string {
  if (!text) return text;
  let guessTimes = cfg.repeat_count;
  if (guessTimes < 2) {
    // Auto-detect
    const counts = new Map<number, number>();
    let cnt = 1;
    for (let i = 1; i <= text.length; i++) {
      if (i < text.length && text[i] === text[i - 1]) {
        cnt++;
      } else {
        counts.set(cnt, (counts.get(cnt) || 0) + 1);
        cnt = 1;
      }
    }
    if (counts.size === 0) return text;
    let maxFreq = 0;
    for (const v of counts.values()) if (v > maxFreq) maxFreq = v;
    const candidates = [...counts.entries()].filter(([, v]) => v === maxFreq).map(([k]) => k).sort((a, b) => a - b);
    if (candidates[0] === 1 && candidates.length > 1) candidates.shift();
    guessTimes = candidates[0] || 1;
  }
  if (guessTimes <= 1) return text;

  if (cfg.keep_non_repeated) {
    let result = "";
    let i = 0;
    while (i < text.length) {
      result += text[i];
      const seg = text.slice(i, i + guessTimes);
      if (seg.length === guessTimes && new Set(seg).size === 1) {
        i += guessTimes;
      } else {
        i++;
      }
    }
    return result;
  } else {
    let result = "";
    for (let i = 0; i < Math.floor(text.length / guessTimes); i++) {
      result += text[i * guessTimes];
    }
    return result;
  }
}

function removeRepeatedLinesPreview(text: string, cfg: { repeat_count: number }): string {
  if (!text) return text;
  let guessTimes = cfg.repeat_count;
  if (guessTimes < 2) {
    // Auto-detect smallest repeating unit
    guessTimes = text.length;
    while (guessTimes >= 1) {
      const unitLen = Math.floor(text.length / guessTimes);
      if (unitLen > 0 && text.slice(0, unitLen).repeat(guessTimes) === text) break;
      guessTimes--;
    }
    if (guessTimes <= 0) return text;
  }
  const unitLen = Math.floor(text.length / guessTimes);
  if (unitLen <= 0) return text;
  return text.slice(0, unitLen);
}
