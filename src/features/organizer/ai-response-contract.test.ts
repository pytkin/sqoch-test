import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareCampaign } from './api';
import { campaignId, draft } from './test-fixtures';

afterEach(() => vi.unstubAllGlobals());

function result(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'applied',
    campaign: draft(),
    fields_to_complete: [],
    clarifications: [],
    message: 'Проверьте подготовленный перенос',
    ...overrides,
  };
}

function prepare() {
  return prepareCampaign(campaignId, {
    expected_revision: 4,
    prompt: 'Переносим «Керамику» на 2 декабря, 19:00',
  });
}

describe('AI response: структурированные уточнения', () => {
  it('принимает готовый результат без вопросов', async () => {
    const payload = result();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(prepare()).resolves.toEqual(payload);
  });

  it('принимает адресный вопрос и предложение другого существующего контекста', async () => {
    const payload = result({
      outcome: 'needs_input',
      fields_to_complete: ['event_id'],
      clarifications: [{ field: 'event_id', reason: 'conflict', candidate_event_id: 'painting' }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(prepare()).resolves.toEqual(payload);
  });

  it.each([
    [
      'список вопросов отсутствует',
      () => {
        const payload: Record<string, unknown> = result();
        delete payload.clarifications;
        return payload;
      },
    ],
    ['вопросы строкой', () => result({ clarifications: 'year' })],
    [
      'неизвестное поле вопроса',
      () =>
        result({
          clarifications: [{ field: 'recipients', reason: 'missing', candidate_event_id: null }],
        }),
    ],
    [
      'неизвестная причина',
      () =>
        result({ clarifications: [{ field: 'year', reason: 'guess', candidate_event_id: null }] }),
    ],
    [
      'кандидат события у поля года',
      () =>
        result({
          clarifications: [{ field: 'year', reason: 'conflict', candidate_event_id: 'painting' }],
        }),
    ],
    ['результат массивом', () => result({ outcome: ['applied'] })],
  ] as const)('отклоняет повреждённый ответ: %s', async (_label, payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload())));
    await expect(prepare()).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
