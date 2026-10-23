import type { ComponentPropsWithRef, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'text' | 'destructive';
  loading?: boolean;
  loadingLabel?: string;
};
export function Button({
  variant = 'primary',
  loading = false,
  loadingLabel,
  disabled,
  className = '',
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`button ${variant} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      <span className="button-label" aria-hidden={(loading && !!loadingLabel) || undefined}>
        {children}
      </span>
      {loadingLabel && (
        <span className="button-loading" aria-hidden={!loading}>
          {loadingLabel}
        </span>
      )}
    </button>
  );
}
type FieldProps = ComponentPropsWithRef<'input'> & {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  labelHelp?: string;
};
export function Field({
  label,
  error,
  hint,
  labelHelp,
  id,
  'aria-describedby': describedBy,
  ...props
}: FieldProps) {
  const description = error || hint;
  const descriptionIds = [
    describedBy,
    description ? `${id}-description` : !describedBy && labelHelp ? `${id}-help` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field">
      {labelHelp ? (
        <div className="field-label">
          <label htmlFor={id}>{label}</label>
          <FieldHelp id={`${id}-help`} label={label}>
            {labelHelp}
          </FieldHelp>
        </div>
      ) : (
        <label htmlFor={id}>{label}</label>
      )}
      <input
        {...props}
        id={id}
        aria-invalid={!!error}
        aria-describedby={descriptionIds || undefined}
      />
      {description && (
        <p className={error ? 'field-error' : 'field-hint'} id={`${id}-description`}>
          {description}
        </p>
      )}
    </div>
  );
}
function FieldHelp({ id, label, children }: { id: string; label: string; children: string }) {
  const [state, setState] = useState<'closed' | 'transient' | 'pinned'>('closed');
  const root = useRef<HTMLSpanElement>(null);
  const open = state !== 'closed';
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setState('closed');
    };
    document.addEventListener('pointerdown', dismiss);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setState('closed');
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <span
      ref={root}
      className="field-help"
      onMouseEnter={() => setState((current) => (current === 'closed' ? 'transient' : current))}
      onMouseLeave={() =>
        setState((current) =>
          current === 'pinned' || root.current?.contains(document.activeElement)
            ? current
            : 'closed',
        )
      }
      onFocus={() => setState((current) => (current === 'closed' ? 'transient' : current))}
      onBlur={() => setState('closed')}
    >
      <button
        type="button"
        className="field-help-trigger"
        aria-label={`Подсказка к полю «${label}»`}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setState((current) => (current === 'pinned' ? 'closed' : 'pinned'))}
      >
        <Icon name="info" />
      </button>
      <span id={id} role="tooltip" className="field-tooltip" hidden={!open}>
        {children}
      </span>
    </span>
  );
}
type NoticeProps = ComponentPropsWithRef<'div'> & {
  kind?: 'error' | 'success' | 'warning' | 'info';
  children: ReactNode;
};
export function Notice({ kind = 'info', role, className = '', ...props }: NoticeProps) {
  return (
    <div
      {...props}
      className={`notice ${kind} ${className}`}
      role={role ?? (kind === 'error' ? 'alert' : 'status')}
    />
  );
}
export function StepIndicator({ current }: { current: number }) {
  if (current >= 2) return null;
  return (
    <p className="steps">
      <span aria-current="step">
        Шаг {current + 1} из 2 · {current === 0 ? 'Данные' : 'Проверка'}
      </span>
    </p>
  );
}
export function Icon({ name }: { name: 'plus' | 'pencil' | 'trash-2' | 'check' | 'info' }) {
  return <span className={`icon icon-${name}`} aria-hidden="true" />;
}
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="help-tip">
      <summary
        onKeyDown={(event) => {
          const details = event.currentTarget.parentElement as HTMLDetailsElement;
          if (event.key === 'Escape' && details.open) {
            event.preventDefault();
            details.open = false;
            event.currentTarget.focus();
          }
        }}
      >
        <Icon name="info" />
        {label}
      </summary>
      <div className="help-content">{children}</div>
    </details>
  );
}
