import { describe, expect, it, vi } from 'vitest';
import { emptyForm, toSaveRequest, validateForm } from './form';
import { formFromCampaign } from './presentation';
import { draft, events } from './test-fixtures';

const readyForm = () =>
  formFromCampaign(draft({ text_reviewed: true, reviewed_event_revision: 0 }));
const beforeProposedStart = () => Date.parse('2099-11-20T18:59:59+03:00');

describe('Organizer form validation', () => {
  it('allows an incomplete draft to be saved without applying complete-form rules', () => {
    const now = vi.fn();
    expect(validateForm(emptyForm, events, false, now)).toEqual({});
    expect(now).not.toHaveBeenCalled();
  });

  it('preserves validation order for the first focused field', () => {
    const errors = validateForm(emptyForm, events, true, beforeProposedStart);
    expect(Object.keys(errors)).toEqual(['event_id', 'date', 'subject', 'body', 'reviewed']);
    expect(errors).toEqual({
      event_id: 'Выберите мероприятие',
      date: 'Укажите новую дату и время',
      subject: 'Укажите тему письма',
      body: 'Введите текст письма',
      reviewed: 'Проверьте соответствие текста мероприятию и новой дате',
    });
  });

  it('keeps partial date errors ahead of the remaining required fields', () => {
    const errors = validateForm(
      { ...emptyForm, date: '2099-11-20' },
      events,
      true,
      beforeProposedStart,
    );
    expect(Object.keys(errors)).toEqual([
      'date',
      'time',
      'event_id',
      'subject',
      'body',
      'reviewed',
    ]);
    expect(errors.time).toBe('Укажите время переноса');
  });

  it('accepts a reviewed form with a selected event and future date', () => {
    expect(validateForm(readyForm(), events, true, beforeProposedStart)).toEqual({});
  });

  it.each([0, 1])('rejects a transfer at or before the injected clock (+%i ms)', (elapsed) => {
    const now = () => Date.parse('2099-11-20T19:00:00+03:00') + elapsed;
    expect(validateForm(readyForm(), events, true, now)).toEqual({
      date: 'Укажите дату и время в будущем',
    });
  });

  it('does not treat a removed event as a selectable event', () => {
    expect(
      validateForm({ ...readyForm(), eventId: 'removed-event' }, events, true, beforeProposedStart),
    ).toEqual({
      event_id: 'Выберите мероприятие',
    });
  });

  it('treats whitespace-only subject and body as missing', () => {
    expect(
      validateForm(
        { ...readyForm(), subject: '  ', body: '\n' },
        events,
        true,
        beforeProposedStart,
      ),
    ).toEqual({
      subject: 'Укажите тему письма',
      body: 'Введите текст письма',
    });
  });
});

describe('Organizer save request', () => {
  it('trims persisted text, combines Moscow time, and keeps the expected revision', () => {
    const form = { ...readyForm(), subject: '  Тема  ', body: '  Текст\n' };
    expect(toSaveRequest(form, 12)).toEqual({
      expected_revision: 12,
      event_id: 'ceramics',
      proposed_start: '2099-11-20T19:00:00+03:00',
      subject: 'Тема',
      body: 'Текст',
      text_reviewed: true,
      reviewed_event_revision: 0,
    });
    expect(form.subject).toBe('  Тема  ');
    expect(form.body).toBe('  Текст\n');
  });

  it('clears a stale reviewed revision when review is unchecked', () => {
    const request = toSaveRequest({ ...readyForm(), reviewed: false, reviewedEventRevision: 7 }, 5);
    expect(request.text_reviewed).toBe(false);
    expect(request.reviewed_event_revision).toBeNull();
  });

  it('sends empty selection and incomplete date as null for a partial draft', () => {
    expect(toSaveRequest({ ...emptyForm, date: '2099-11-20' }, 0)).toEqual({
      expected_revision: 0,
      event_id: null,
      proposed_start: null,
      subject: '',
      body: '',
      text_reviewed: false,
      reviewed_event_revision: null,
    });
  });
});
