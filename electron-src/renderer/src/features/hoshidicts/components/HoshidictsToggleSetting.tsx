// Hoshidicts-private settings primitive. Do not move into a shared GSM folder.

export function HoshidictsToggleSetting({
  id,
  label,
  hint,
  checked,
  disabled = false,
  className,
  variant = "block",
  onChange
}: {
  id?: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  className?: string;
  /** `inline` renders a single-line label without the emphasized title. */
  variant?: "block" | "inline";
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={`hoshidicts-toggle${
        variant === "inline" ? " hoshidicts-toggle--inline" : ""
      }${className ? ` ${className}` : ""}`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      {variant === "inline" ? (
        <span>{label}</span>
      ) : (
        <span>
          <strong>{label}</strong>
          {hint ? <small>{hint}</small> : null}
        </span>
      )}
    </label>
  );
}
