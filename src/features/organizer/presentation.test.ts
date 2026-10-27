import { describe, expect, it } from 'vitest';
import { combineMoscow, dateLabel, formFromCampaign, moscowParts } from './presentation';
import { draft } from './test-fixtures';

describe('Organizer dates and restored form', () => {
  it.each([
    ['', '', null],
    ['2099-11-20', '', null],
    ['', '19:00', null],
    ['2099-2-01', '19:00', null],
    ['2099-11-20', '9:00', null],
    ['2099-11-20', '19:00', '2099-11-20T19:00:00+03:00'],
    ['2032-02-29', '00:00', '2032-02-29T00:00:00+03:00'],
    ['2031-02-29', '00:00', null],
    ['2099-04-31', '19:00', null],
    ['2099-11-20', '24:00', null],
    ['2099-11-20', '23:60', null],
  ])('combines %j and %j without normalizing an invalid calendar value', (date, time, expected) => {
    expect(combineMoscow(date, time)).toBe(expected);
  });

  it.each([
    [null, { date: '', time: '' }],
    ['2099-11-20T19:00:00+03:00', { date: '2099-11-20', time: '19:00' }],
    ['2099-11-20T22:30:00Z', { date: '2099-11-21', time: '01:30' }],
  ])('restores Moscow date and time from %s', (value, expected) => {
    expect(moscowParts(value)).toEqual(expected);
  });

  it('restores every saved form field without substituting the AI date suggestion', () => {
    const saved = draft({
      event_id: null,
      proposed_start: null,
      suggested_start: '2099-11-20T19:00:00+03:00',
      subject: '  Тема  ',
      body: '  Текст  ',
      text_reviewed: true,
      reviewed_event_revision: 7,
    });
    expect(formFromCampaign(saved)).toEqual({
      eventId: '',
      date: '',
      time: '',
      subject: '  Тема  ',
      body: '  Текст  ',
      reviewed: true,
      reviewedEventRevision: 7,
      canonicalStart: null,
    });
  });

  it('formats the date in Moscow even when UTC belongs to the previous day', () => {
    const label = dateLabel('2099-11-20T22:30:00Z');
    expect(label).toContain('21 ноября 2099');
    expect(label).toContain('01:30');
  });
  it('shows nonzero seconds and the original fraction when they are part of the saved timestamp', () => {
    expect(dateLabel('2099-11-20T19:00:45.123456+03:00')).toContain('19:00:45.123456');
  });
});
