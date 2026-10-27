import { describe, expect, it } from 'vitest';
import { emptyDraft, validAge } from './draft';

describe('Booking draft', () => {
  it.each([
    ['0', 0],
    ['18', 18],
    ['001', 1],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
    ['', null],
    ['-1', null],
    ['+1', null],
    ['1.5', null],
    ['18.0', null],
    ['1e2', null],
    [' 18 ', null],
    ['9007199254740992', null],
  ])('parses the entered age %j as %s', (value, expected) => {
    expect(validAge(value)).toBe(expected);
  });

  it('creates independent empty drafts for a new order', () => {
    const first = emptyDraft();
    first.participants[0]!.name = 'Анна';
    first.email = 'anna@example.com';
    expect(emptyDraft()).toEqual({ participants: [{ name: '', age: '' }], email: '' });
  });
});
