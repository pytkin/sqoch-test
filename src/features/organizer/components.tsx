import type { ComponentPropsWithRef, ReactNode } from 'react';
import type { FormField } from './form';

export const fieldIds: Record<FormField, string> = {
  event_id: 'organizer-event',
  date: 'organizer-date',
  time: 'organizer-time',
  subject: 'organizer-subject',
  body: 'organizer-body',
  reviewed: 'organizer-reviewed',
  prompt: 'organizer-prompt',
  instruction: 'organizer-instruction',
  year: 'organizer-year',
};

export function Button({
  loading,
  children,
  className = '',
  disabled,
  ...props
}: ComponentPropsWithRef<'button'> & { loading?: boolean }) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={`button ${className || 'primary'}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {children}
    </button>
  );
}
export function Section({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className="section-row organizer-section">
      <h2 className="section-caption">{name}</h2>
      <div className="organizer-section-content">{children}</div>
    </section>
  );
}
export function Field({
  label,
  field,
  error,
  children,
  hint,
}: {
  label: string;
  field: FormField;
  error?: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={fieldIds[field]}>{label}</label>
      {children}
      {(error || hint) && (
        <p id={`${fieldIds[field]}-description`} className={error ? 'field-error' : 'field-hint'}>
          {error || hint}
        </p>
      )}
    </div>
  );
}
