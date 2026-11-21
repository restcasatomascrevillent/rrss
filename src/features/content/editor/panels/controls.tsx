import { useId, useState, type ReactNode } from 'react';
import { HEX_COLOR } from '../../document';
import { cn } from '@/lib/utils';

// Controles compactos del panel de propiedades. Todos avisan del cambio al
// teclear (para ver el resultado en el lienzo) y cortan el paso de deshacer al
// salir del campo (`onCommit`).

const INPUT =
  'h-9 w-full rounded-md border border-border bg-surface px-2 text-sm text-fg disabled:cursor-not-allowed disabled:opacity-60';

export function Labeled({
  label,
  children,
  className,
}: {
  label: string;
  className?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={id} className="block text-xs font-medium text-muted">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

export function NumberInput({
  label,
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  disabled,
  testId,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  testId?: string;
}) {
  // Texto propio mientras se escribe, para no pelearse con «-» o «1.» a medias.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 100) / 100);
  return (
    <Labeled label={label}>
      {(id) => (
        <input
          id={id}
          type="number"
          inputMode="decimal"
          className={INPUT}
          value={shown}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          data-testid={testId}
          onChange={(e) => {
            setDraft(e.target.value);
            const parsed = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(parsed)) {
              const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
              onChange(clamped);
            }
          }}
          onBlur={() => {
            setDraft(null);
            onCommit?.();
          }}
        />
      )}
    </Labeled>
  );
}

export function SelectInput<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <Labeled label={label}>
      {(id) => (
        <select
          id={id}
          className={INPUT}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Labeled>
  );
}

/**
 * Color: primero los de la marca (lo recomendable), y un selector libre. El
 * verificador de marca avisa si se usa un color fuera de la paleta.
 */
export function ColorInput({
  label,
  value,
  palette,
  onChange,
  onCommit,
  disabled,
}: {
  label: string;
  value: string;
  palette: { hex: string; name: string }[];
  onChange: (value: string) => void;
  onCommit?: () => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="space-y-1" disabled={disabled}>
      <legend className="text-xs font-medium text-muted">{label}</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        {palette.map((color) => (
          <button
            key={color.hex + color.name}
            type="button"
            title={color.name || color.hex}
            aria-label={`${color.name || 'Color de la marca'} ${color.hex}`}
            aria-pressed={color.hex.toUpperCase() === value.toUpperCase()}
            onClick={() => {
              onChange(color.hex.toUpperCase());
              onCommit?.();
            }}
            className="h-7 w-7 rounded-full border border-border ring-primary ring-offset-2 ring-offset-surface aria-pressed:ring-2"
            style={{ backgroundColor: color.hex }}
          />
        ))}
        <label htmlFor={id} className="sr-only">
          {`${label}: otro color`}
        </label>
        <input
          id={id}
          type="color"
          className="h-7 w-10 cursor-pointer rounded border border-border bg-surface"
          value={HEX_COLOR.test(value) ? value.toLowerCase() : '#000000'}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          onBlur={onCommit}
        />
        <span className="font-mono text-xs text-muted">{value.toUpperCase()}</span>
      </div>
    </fieldset>
  );
}

/** Deslizador con su valor a la vista. Avisa al mover y corta el paso de deshacer al soltar. */
export function RangeInput({
  label,
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  disabled,
  testId,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <Labeled label={`${label}: ${Math.round(value * 100) / 100}`}>
      {(id) => (
        <input
          id={id}
          type="range"
          className="w-full accent-primary disabled:opacity-60"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          data-testid={testId}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
          onBlur={onCommit}
        />
      )}
    </Labeled>
  );
}

export function CheckInput({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-border"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
