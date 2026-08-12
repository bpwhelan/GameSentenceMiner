// Hoshidicts-private settings primitive. Do not move into a shared GSM folder.

export function HoshidictsNumberSetting({
  id,
  label,
  hint,
  unit,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  className,
  onChange
}: {
  id: string;
  label: string;
  hint?: string;
  unit?: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  onChange: (value: number) => void;
}) {
  const input = (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
    />
  );

  return (
    <label className={`hoshidicts-setting${className ? ` ${className}` : ""}`}>
      <span>{label}</span>
      {unit ? (
        <div className="hoshidicts-number">
          {input}
          <span>{unit}</span>
        </div>
      ) : (
        input
      )}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}
