import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCampaign, getCampaign, listCampaigns } from './api';
import { campaignId, confirmed, draft, summary } from './test-fixtures';

afterEach(() => vi.unstubAllGlobals());

function preparation(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    mode: 'assistant',
    stage: 'needs_input',
    original_prompt: 'Переносим «Керамику» на 2 декабря, 19:00',
    answers: {},
    context_event_id: 'ceramics',
    partial_date: { year: null, month: 12, day: 2, hour: 19, minute: 0 },
    manual_fields: [],
    clarifications: [{ field: 'year', reason: 'missing', candidate_event_id: null }],
    intake_revision: 5,
    applied_revision: null,
    ...overrides,
  };
}

describe('Сохраняемая подготовка: граница HTTP-потребителя', () => {
  it('передаёт содержательный первый запрос вместе с выбранным контекстом', async () => {
    const input = {
      mode: 'assistant' as const,
      prompt: 'Переносим «Керамику» на 2 декабря 2099 года в 19:00',
      context_event_id: 'ceramics',
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json(draft()));
    vi.stubGlobal('fetch', fetcher);
    await createCampaign(campaignId, input);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/organizer/campaigns/${campaignId}`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }),
    );
  });

  it('восстанавливает известные компоненты и единственный вопрос о годе', async () => {
    const saved = { ...draft(), assistant_state: preparation() };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(saved)));
    await expect(getCampaign(campaignId)).resolves.toEqual(saved);
  });

  it('принимает явно nullable состояние старой записи', async () => {
    const saved = { ...draft(), assistant_state: null };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(saved)));
    await expect(getCampaign(campaignId)).resolves.toEqual(saved);
  });

  it.each(['explicit', 'current_year', 'clarification', 'manual', null])(
    'сохраняет источник выбранного года: %s',
    async (source) => {
      const saved = {
        ...draft(),
        assistant_state: preparation({
          partial_date: { year: 2099, month: 12, day: 2, hour: 19, minute: 0 },
          year_source: source,
        }),
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(saved)));
      await expect(getCampaign(campaignId)).resolves.toEqual(saved);
    },
  );

  it.each([{ source: 'model' }, { source: true }, { source: ['current_year'] }])(
    'не доверяет неизвестному источнику года $source',
    async ({ source }) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          Response.json({
            ...draft(),
            assistant_state: preparation({ year_source: source }),
          }),
        ),
      );
      await expect(getCampaign(campaignId)).rejects.toMatchObject({ kind: 'invalid_response' });
    },
  );

  it('не объявляет текущий год выбранным, пока год неизвестен', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ...draft(),
          assistant_state: preparation({ year_source: 'current_year' }),
        }),
      ),
    );
    await expect(getCampaign(campaignId)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('не принимает отсутствие обязательного ключа за legacy null', async () => {
    const damaged: Record<string, unknown> = { ...draft(), assistant_state: null };
    delete damaged.assistant_state;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(damaged)));
    await expect(getCampaign(campaignId)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it.each([
    ['неизвестная версия', { version: 2 }],
    ['неизвестный режим', { mode: 'chat' }],
    ['режим массивом', { mode: ['manual'] }],
    ['неизвестная стадия', { stage: 'completed' }],
    ['стадия массивом', { stage: ['applied'] }],
    ['год boolean', { answers: { year: true } }],
    ['неизвестное поле ответа', { answers: { recipients: ['other@example.com'] } }],
    ['невозможный месяц', { partial_date: { year: null, month: 13, day: 2, hour: 19, minute: 0 } }],
    [
      'невозможный день даже без года',
      { partial_date: { year: null, month: 4, day: 31, hour: 19, minute: 0 } },
    ],
    ['повтор ручного источника', { manual_fields: ['date', 'date'] }],
    ['ручной источник вложенным массивом', { manual_fields: [['date']] }],
    [
      'неизвестная причина уточнения',
      { clarifications: [{ field: 'year', reason: 'guess', candidate_event_id: null }] },
    ],
    [
      'причина уточнения массивом',
      { clarifications: [{ field: 'year', reason: ['missing'], candidate_event_id: null }] },
    ],
    ['неверный тип контекста', { context_event_id: false }],
    ['несуществующая будущая версия intake', { intake_revision: 6 }],
    ['несуществующая будущая применённая версия', { applied_revision: 6 }],
  ])('отклоняет повреждённую подготовку: %s', async (_label, changes) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({ ...draft(), assistant_state: preparation(changes) })),
    );
    await expect(getCampaign(campaignId)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('получает содержательность и стадию для обзора мероприятий', async () => {
    const item = {
      ...summary(draft()),
      has_content: true,
      preparation_stage: 'needs_input',
      event_snapshot: null,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [item] })));
    await expect(listCampaigns()).resolves.toEqual({ items: [item] });
  });

  it.each([
    ['empty', false],
    ['manual', true],
  ] as const)('принимает серверную стадию старой подготовки %s', async (stage, hasContent) => {
    const item = {
      ...summary(draft()),
      has_content: hasContent,
      preparation_stage: stage,
      event_snapshot: null,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [item] })));
    await expect(listCampaigns()).resolves.toEqual({ items: [item] });
  });

  it.each([
    ['содержательность строкой', { has_content: 'false' }],
    ['неизвестная стадия в списке', { preparation_stage: 'confirmed' }],
    ['стадия в списке массивом', { preparation_stage: ['applied'] }],
  ])('не строит обзор на повреждённых метаданных: %s', async (_label, changes) => {
    const item = {
      ...summary(draft()),
      has_content: true,
      preparation_stage: 'needs_input',
      event_snapshot: null,
      ...changes,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [item] })));
    await expect(listCampaigns()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('не показывает в истории снимок другого мероприятия', async () => {
    const saved = confirmed();
    const item = {
      ...summary(saved),
      has_content: true,
      preparation_stage: null,
      event_snapshot: { ...saved.event_snapshot, id: 'painting' },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [item] })));
    await expect(listCampaigns()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('не выдаёт подтверждённый перенос за продолжающуюся подготовку', async () => {
    const saved = confirmed();
    const item = {
      ...summary(saved),
      has_content: true,
      preparation_stage: 'manual',
      event_snapshot: saved.event_snapshot,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [item] })));
    await expect(listCampaigns()).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
