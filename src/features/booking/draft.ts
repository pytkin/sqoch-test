import type { Draft } from './api';

export type DraftField = 'email' | `participants.${number}.${'name' | 'age'}`;
export type OrderEditField = 'email' | `participants.${number}.name`;
export type RemovedParticipant = { index: number; person: Draft['participants'][number] };

export const emptyDraft = (): Draft => ({ participants: [{ name: '', age: '' }], email: '' });
export const emailError = 'Проверьте email, например name@example.com';
export const validAge = (value: string) =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
