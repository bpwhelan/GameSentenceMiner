import type { ReactNode } from "react";

// Hoshidicts-private settings primitive. Do not move into a shared GSM folder.

export function HoshidictsSelectSetting({
  id,
  label,
  hint,
  value,
  options,
  disabled = false,
  className,
  children,
  onChange
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  /** Simple `value`/`label` choices; use `children` for optgroups. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`hoshidicts-setting${className ? ` ${className}` : ""}`}>
      <span>{label}</span>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options?.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
        {children}
      </select>
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}
