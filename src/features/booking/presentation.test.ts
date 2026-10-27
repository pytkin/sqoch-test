import { describe, expect, it } from 'vitest';
import { ageText, money, ticketCount } from './presentation';

describe('Booking presentation', () => {
  it.each([
    [0, '0 лет'],
    [1, '1 год'],
    [2, '2 года'],
    [4, '4 года'],
    [5, '5 лет'],
    [11, '11 лет'],
    [12, '12 лет'],
    [14, '14 лет'],
    [21, '21 год'],
    [22, '22 года'],
    [25, '25 лет'],
    [111, '111 лет'],
    [114, '114 лет'],
  ])('formats age %i as %s', (age, expected) => {
    expect(ageText(age)).toBe(expected);
  });

  it.each([
    [1, '1 билет'],
    [2, '2 билета'],
    [3, '3 билета'],
    [4, '4 билета'],
  ])('formats the supported order size %i', (count, expected) => {
    expect(ticketCount(count)).toBe(expected);
  });

  it('keeps the currency and grouped amount together with nonbreaking spaces', () => {
    expect(money(2000)).toBe('2\u00a0000\u00a0₽');
    expect(money(0)).toBe('0\u00a0₽');
  });
});
