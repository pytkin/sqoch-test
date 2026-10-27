import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmCampaign,
  getCampaign,
  getEvents,
  getPreview,
  listCampaigns,
  prepareCampaign,
  rewriteCampaign,
} from './api';
import { campaignId, campaignPath, confirmed, draft, preview } from './test-fixtures';

afterEach(() => vi.useRealTimers());

describe('Organizer transport — test first', () => {
  it('получает проверенный сохранённый draft по его постоянному ID', async () => {
    const saved = draft();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(saved)));
    await expect(getCampaign(campaignId)).resolves.toEqual(saved);
    expect(fetch).toHaveBeenCalledWith(campaignPath, expect.objectContaining({ method: 'GET' }));
  });

  it('не выдаёт повреждённые counters подтверждённой рассылки за успех', async () => {
    const damaged = confirmed();
    damaged.counters.total = 900;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(damaged)));
    await expect(getCampaign(campaignId)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('различает 422 с бизнес-кодом и полевым массивом', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              detail: {
                code: 'no_recipients',
                message: 'Нет покупателей',
                related_campaign_id: null,
              },
            },
            { status: 422 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            { detail: [{ loc: ['body', 'subject'], msg: 'Укажите тему', type: 'value_error' }] },
            { status: 422 },
          ),
        ),
    );
    await expect(getCampaign(campaignId)).rejects.toMatchObject({
      kind: 'domain',
      code: 'no_recipients',
    });
    await expect(getCampaign(campaignId)).rejects.toMatchObject({
      kind: 'validation',
      issues: [{ loc: ['body', 'subject'], msg: 'Укажите тему', type: 'value_error' }],
    });
  });

  it('15-секундный deadline покрывает также зависшее чтение body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) }),
    );
    const result = getCampaign(campaignId).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(15000);
    await expect(result).resolves.toMatchObject({ kind: 'timeout' });
  });

  it('AI использует 60 секунд и тоже не применяет зависший body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) }),
    );
    const result = prepareCampaign(campaignId, {
      expected_revision: 5,
      prompt: 'Перенос Керамики',
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60000);
    await expect(result).resolves.toMatchObject({ kind: 'timeout' });
  });

  it('не превращает повреждённую 422 в доказанную полевую ошибку', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ detail: [] }, { status: 422 })),
    );
    await expect(getCampaign(campaignId)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('отвергает корректный DTO другой рассылки вместо применения к текущему ID', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json(draft({ id: '9a31c709-113b-4b1c-bc9e-55d389fb01c9' }))),
    );
    await expect(getCampaign(campaignId)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('ответ confirm с draft не считается подтверждённой рассылкой', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(draft())));
    await expect(confirmCampaign(campaignId, preview(draft()).token)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('предпросмотр без получателей не применяется как допустимый результат', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ ...preview(draft()), recipients: [] })),
    );
    await expect(getPreview(campaignId, 5)).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});

describe('Organizer transport boundaries', () => {
  it.each([
    ['ordinary request', 15000, () => getCampaign(campaignId)],
    [
      'AI request',
      60000,
      () => prepareCampaign(campaignId, { expected_revision: 5, prompt: 'Перенос Керамики' }),
    ],
  ] as const)('%s does not expire before its full deadline', async (_name, timeout, start) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const settled = vi.fn();
    const result = start().then(settled, (error: unknown) => {
      settled();
      return error;
    });
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ kind: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start fetch for an already cancelled external signal', async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    external.abort();
    vi.stubGlobal('fetch', vi.fn());
    await expect(getCampaign(campaignId, external.signal)).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['fetch', 'body'] as const)(
    'external cancellation settles a stalled %s and ignores its late result',
    async (stage) => {
      vi.useFakeTimers();
      const external = new AbortController();
      const remove = vi.spyOn(external.signal, 'removeEventListener');
      let finish!: (value: unknown) => void;
      const pending = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          stage === 'fetch'
            ? pending
            : Promise.resolve({ ok: true, status: 200, json: () => pending }),
        ),
      );
      const success = vi.fn();
      const failure = vi.fn();
      const result = getCampaign(campaignId, external.signal).then(success, failure);
      await vi.advanceTimersByTimeAsync(0);
      external.abort();
      await result;
      expect(failure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cancelled' }));
      expect(vi.getTimerCount()).toBe(0);
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      finish(stage === 'fetch' ? Response.json(draft()) : draft());
      await vi.advanceTimersByTimeAsync(0);
      expect(success).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('clears timer and external listener after success without changing a settled result', async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const remove = vi.spyOn(external.signal, 'removeEventListener');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(draft())));
    const result = getCampaign(campaignId, external.signal);
    await expect(result).resolves.toEqual(draft());
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    external.abort();
    await expect(result).resolves.toEqual(draft());
  });

  it('keeps network errors distinct and cleans their deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(getCampaign(campaignId)).rejects.toMatchObject({ kind: 'network' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Organizer response guard boundaries', () => {
  it.each([
    ['pending', 'processing'],
    ['sending', 'processing'],
    ['retry_wait', 'processing'],
    ['unknown', 'needs_attention'],
    ['failed', 'completed_with_errors'],
    ['sent', 'completed'],
  ] as const)('accepts confirmed %s deliveries and their %s status', async (state, status) => {
    const saved = confirmed({
      status,
      counters: {
        total: 2,
        pending: 0,
        sending: 0,
        retry_wait: 0,
        sent: 0,
        failed: 0,
        unknown: 0,
        [state]: 2,
      },
      deliveries: confirmed().deliveries.map((item) => ({
        ...item,
        state,
        attempts: state === 'pending' ? 0 : 1,
        sent_at: state === 'sent' ? '2026-10-26T12:05:01Z' : null,
      })),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(saved)));
    await expect(getCampaign(campaignId)).resolves.toEqual(saved);
  });

  it.each([
    [
      'state counters disagree with deliveries',
      () => ({
        ...confirmed(),
        counters: { ...confirmed().counters, sent: 0, failed: 1 },
      }),
    ],
    [
      'status disagrees with otherwise valid counters',
      () => ({ ...confirmed(), status: 'completed' }),
    ],
    ['confirmed campaign has no deliveries', () => ({ ...confirmed(), deliveries: [] })],
    [
      'delivery exceeded its attempt limit',
      () => ({
        ...confirmed(),
        deliveries: confirmed().deliveries.map((item) => ({ ...item, attempts: 6 })),
      }),
    ],
    [
      'delivery has an unknown state',
      () => ({
        ...confirmed(),
        deliveries: confirmed().deliveries.map((item) => ({ ...item, state: 'delivered' })),
      }),
    ],
    ['draft has confirmed counters', () => ({ ...draft(), counters: confirmed().counters })],
    [
      'draft has a confirmation timestamp',
      () => ({ ...draft(), confirmed_at: '2026-10-26T12:05:00Z' }),
    ],
    [
      'timestamp lacks an explicit timezone',
      () => ({ ...draft(), created_at: '2026-10-26T12:00:00' }),
    ],
    ['revision is fractional', () => ({ ...draft(), revision: 1.5 })],
    [
      'saved preview belongs to another campaign',
      () => ({
        ...draft(),
        preview: { ...preview(draft()), campaign_id: '9a31c709-113b-4b1c-bc9e-55d389fb01c9' },
      }),
    ],
  ] as const)('rejects a response where %s', async (_name, payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload())));
    await expect(getCampaign(campaignId)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it.each([
    [
      'duplicate recipients',
      { ...preview(draft()), recipients: ['same@example.com', 'same@example.com'] },
    ],
    [
      'another campaign ID',
      { ...preview(draft()), campaign_id: '9a31c709-113b-4b1c-bc9e-55d389fb01c9' },
    ],
  ] as const)('rejects a new preview with %s', async (_name, payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(getPreview(campaignId, 5)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects a confirmed campaign returned from an AI draft action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          campaign: confirmed(),
          outcome: 'applied',
          message: 'Готово',
          fields_to_complete: [],
          clarifications: [],
        }),
      ),
    );
    await expect(
      rewriteCampaign(campaignId, {
        expected_revision: 5,
        instruction: 'Сделай короче',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects an event outside the organizer timezone contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          items: [{ ...preview(draft()).event, timezone: 'UTC' }],
        }),
      ),
    );
    await expect(getEvents()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects a summary whose counter-derived status disagrees', async () => {
    const saved = confirmed();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          items: [{ ...saved, event_title: 'Керамика', status: 'completed' }],
        }),
      ),
    );
    await expect(listCampaigns()).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
