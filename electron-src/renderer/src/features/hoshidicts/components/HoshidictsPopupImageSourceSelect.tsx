import type { HoshidictsPopupImageSource } from "../../../../../shared/features/hoshidicts";
import { HoshidictsSelectSetting } from "./HoshidictsSelectSetting";

// Hoshidicts-private settings primitive. Do not move into a shared GSM folder.

interface ImageDictionary {
  id: string;
  title: string;
}

interface ImageTabGroup {
  id: string;
  name: string;
}

/** Encodes a discriminated source into a flat <option> value. */
function encodeSource(source: HoshidictsPopupImageSource | null): string {
  if (source === null) return "";
  return source.kind === "dictionary"
    ? `dictionary:${source.title}`
    : `tabGroup:${source.id}`;
}

/** Decodes an <option> value back into the discriminated source. */
function decodeSource(value: string): HoshidictsPopupImageSource | null {
  if (value === "") return null;
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator);
  const rest = value.slice(separator + 1);
  if (kind === "dictionary") return { kind: "dictionary", title: rest };
  if (kind === "tabGroup") return { kind: "tabGroup", id: rest };
  return null;
}

/**
 * Picks the one dictionary or tab group permitted to contribute images to the
 * popup. Only dictionaries that ship images and tab groups containing at least
 * one such dictionary are offered; a stale selection stays visible so autosave
 * cannot silently drop it. When nothing can show images the control disables
 * itself, leaving only Automatic.
 */
export function HoshidictsPopupImageSourceSelect({
  id,
  label,
  hint,
  automaticLabel,
  missingDictionaryLabel,
  missingTabGroupLabel,
  value,
  dictionaries,
  tabGroups,
  disabled = false,
  className,
  onChange
}: {
  id: string;
  label: string;
  hint?: string;
  automaticLabel: string;
  /** Already-interpolated label for a selected-but-missing dictionary. */
  missingDictionaryLabel: string;
  /** Label for a selected-but-missing tab group. */
  missingTabGroupLabel: string;
  value: HoshidictsPopupImageSource | null;
  /** Dictionaries that already ship at least one image, in display order. */
  dictionaries: ReadonlyArray<ImageDictionary>;
  /** Tab groups with at least one image dictionary, in display order. */
  tabGroups: ReadonlyArray<ImageTabGroup>;
  disabled?: boolean;
  className?: string;
  onChange: (value: HoshidictsPopupImageSource | null) => void;
}) {
  const staleDictionary =
    value?.kind === "dictionary" &&
    !dictionaries.some((dictionary) => dictionary.title === value.title);
  const staleTabGroup =
    value?.kind === "tabGroup" &&
    !tabGroups.some((group) => group.id === value.id);

  return (
    <HoshidictsSelectSetting
      id={id}
      label={label}
      hint={hint}
      className={className}
      value={encodeSource(value)}
      disabled={
        disabled ||
        (dictionaries.length === 0 &&
          tabGroups.length === 0 &&
          !staleDictionary &&
          !staleTabGroup)
      }
      onChange={(selected) => onChange(decodeSource(selected))}
    >
      <option value="">{automaticLabel}</option>
      {staleDictionary ? (
        <option value={encodeSource(value)}>{missingDictionaryLabel}</option>
      ) : null}
      {staleTabGroup ? (
        <option value={encodeSource(value)}>{missingTabGroupLabel}</option>
      ) : null}
      {dictionaries.map((dictionary) => (
        <option
          key={`dictionary:${dictionary.id}`}
          value={`dictionary:${dictionary.title}`}
        >
          {dictionary.title}
        </option>
      ))}
      {tabGroups.map((group) => (
        <option key={`tabGroup:${group.id}`} value={`tabGroup:${group.id}`}>
          {group.name}
        </option>
      ))}
    </HoshidictsSelectSetting>
  );
}
