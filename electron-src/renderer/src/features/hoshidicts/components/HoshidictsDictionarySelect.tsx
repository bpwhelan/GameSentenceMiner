import { HoshidictsSelectSetting } from "./HoshidictsSelectSetting";

// Hoshidicts-private settings primitive. Do not move into a shared GSM folder.

/**
 * Picks one installed dictionary by title, keeping a title that is no longer
 * installed selectable so saving the panel cannot silently drop it.
 */
export function HoshidictsDictionarySelect({
  id,
  label,
  hint,
  automaticLabel,
  unavailableLabel,
  value,
  dictionaries,
  disabled = false,
  className,
  onChange
}: {
  id: string;
  label: string;
  hint?: string;
  automaticLabel: string;
  /** Already-interpolated label for a selected-but-missing dictionary. */
  unavailableLabel: string;
  value: string | null;
  dictionaries: ReadonlyArray<{ id: string; title: string }>;
  disabled?: boolean;
  className?: string;
  onChange: (value: string | null) => void;
}) {
  const stale =
    value !== null &&
    !dictionaries.some((dictionary) => dictionary.title === value);

  return (
    <HoshidictsSelectSetting
      id={id}
      label={label}
      hint={hint}
      className={className}
      value={value ?? ""}
      disabled={disabled}
      onChange={(selected) => onChange(selected || null)}
    >
      <option value="">{automaticLabel}</option>
      {stale ? <option value={value ?? ""}>{unavailableLabel}</option> : null}
      {dictionaries.map((dictionary) => (
        <option key={dictionary.id} value={dictionary.title}>
          {dictionary.title}
        </option>
      ))}
    </HoshidictsSelectSetting>
  );
}
