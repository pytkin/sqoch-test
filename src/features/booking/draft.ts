import type { Draft } from './api';

export type DraftField = 'email' | `participants.${number}.${'name' | 'age'}`;
export type OrderEditField = 'email' | `participants.${number}.name`;
export type RemovedParticipant = { index: number; person: Draft['participants'][number] };

export const emptyDraft = (): Draft => ({ participants: [{ name: '', age: '' }], email: '' });
export const nameError = 'Введите имя участника: поле не должно быть пустым';
export const ageError = 'Введите возраст в полных годах: целое число от 0';
export const ageHelp = 'Укажите число полных лет. Если ребёнку ещё нет года, введите 0';
export const emailError = 'Введите email в формате name@example.com, без пробелов';
export const validAge = (value: string) =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
