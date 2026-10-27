import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmOrder, errorMessage, getEvent, getQuote } from './api';

const draft = { participants: [{ name: 'Анна', age: '18' }], email: 'anna@example.com' };
const event = {
  id: 'sqoch-demo',
  title: 'Встреча Sqoch',
  currency: 'RUB',
  max_participants: 4,
  child_age_limit: 14,
  companion_min_age: 18,
  full_ticket_price: 2000,
  child_ticket_price: 1000,
};
const quote = {
  participants: [{ name: 'Анна', age: 18, ticket_type: 'full', price: 2000 }],
  email: draft.email,
  total: 2000,
  currency: 'RUB',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function observe(promise: Promise<unknown>) {
  const success = vi.fn();
  const failure = vi.fn();
  void promise.then(success, failure);
  return { success, failure };
}
function bodyResponse(status: number, body: Promise<unknown>): Response {
  return { status, ok: status >= 200 && status < 300, json: () => body } as Response;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Booking response and request boundaries', () => {
  it.each([
    ['event', 201, event, () => getEvent(new AbortController().signal)],
    ['quote', 201, quote, () => getQuote(draft)],
    ['confirmation', 200, { ...quote, order_id: 'demo-123' }, () => confirmOrder(draft, 'success')],
  ] as const)(
    'rejects a valid %s DTO under an unexpected successful HTTP status',
    async (_name, status, body, start) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })));
      await expect(start()).rejects.toMatchObject({ kind: 'server' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ['no participants', { ...quote, participants: [] }],
    [
      'five participants',
      { ...quote, participants: Array.from({ length: 5 }, () => quote.participants[0]) },
    ],
    ['blank name', { ...quote, participants: [{ ...quote.participants[0], name: '  ' }] }],
    ['fractional age', { ...quote, participants: [{ ...quote.participants[0], age: 1.5 }] }],
    ['negative price', { ...quote, participants: [{ ...quote.participants[0], price: -1 }] }],
    [
      'unknown ticket type',
      { ...quote, participants: [{ ...quote.participants[0], ticket_type: 'free' }] },
    ],
    ['unsafe total', { ...quote, total: Number.MAX_SAFE_INTEGER + 1 }],
    ['another currency', { ...quote, currency: 'EUR' }],
  ] as const)('rejects a quote with %s', async (_name, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    await expect(getQuote(draft)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects an event whose participant limit is zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ ...event, max_participants: 0 })),
    );
    await expect(getEvent(new AbortController().signal)).rejects.toMatchObject({ kind: 'server' });
  });

  it('serializes trimmed fields and keeps the demo scenario exclusive to confirmation', async () => {
    const entered = {
      participants: [{ name: '  Анна  ', age: '018' }],
      email: '  anna@example.com  ',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(quote))
      .mockResolvedValueOnce(Response.json({ ...quote, order_id: 'demo-123' }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await getQuote(entered);
    await confirmOrder(entered, 'sold_out');
    for (const [, options] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(JSON.parse(String(options.body))).toEqual({
        participants: [{ name: 'Анна', age: 18 }],
        email: draft.email,
      });
      expect(options.method).toBe('POST');
      expect(new Headers(options.headers).get('Content-Type')).toBe('application/json');
    }
    const quoteHeaders = new Headers(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
    );
    const confirmHeaders = new Headers(
      (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers,
    );
    expect(quoteHeaders.has('X-Demo-Scenario')).toBe(false);
    expect(confirmHeaders.get('X-Demo-Scenario')).toBe('sold_out');
    expect(entered.participants[0]!.name).toBe('  Анна  ');
  });
});

describe('API deadline and cancellation — test first', () => {
  it.each(['quote', 'confirm', 'event'] as const)(
    '%s stops a stalled fetch after 15 seconds without retrying',
    async (operation) => {
      const pending = deferred<Response>();
      const fetchMock = vi.fn(() => pending.promise);
      vi.stubGlobal('fetch', fetchMock);
      const request =
        operation === 'quote'
          ? getQuote(draft)
          : operation === 'confirm'
            ? confirmOrder(draft, 'success')
            : getEvent(new AbortController().signal);
      const result = observe(request);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(result.failure).not.toHaveBeenCalled();
      expect(result.success).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(result.failure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'timeout' }));
      expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(
        true,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      pending.resolve(Response.json(operation === 'event' ? event : quote));
      await vi.advanceTimersByTimeAsync(0);
      expect(result.success).not.toHaveBeenCalled();
    },
  );

  it('uses one deadline across response headers and a stalled success body', async () => {
    const headers = deferred<Response>();
    const body = deferred<unknown>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => headers.promise),
    );
    const result = observe(confirmOrder(draft, 'success'));
    await vi.advanceTimersByTimeAsync(4_000);
    headers.resolve(bodyResponse(201, body.promise));
    await vi.advanceTimersByTimeAsync(10_999);
    expect(result.failure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(result.failure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'timeout' }));
    body.resolve({ ...quote, order_id: 'late-order' });
    await vi.advanceTimersByTimeAsync(0);
    expect(result.success).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([422, 409])('also times out while reading an HTTP %i body', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bodyResponse(status, new Promise(() => {}))));
    const result = observe(confirmOrder(draft, 'success'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(result.failure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'timeout' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('external cancellation rejects immediately even if fetch ignores its signal', async () => {
    const external = new AbortController();
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', fetchMock);
    const result = observe(getEvent(external.signal));
    await vi.advanceTimersByTimeAsync(1_000);
    external.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.failure).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(Response.json(event));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.success).not.toHaveBeenCalled();
  });

  it('does not start fetch for an already cancelled signal', async () => {
    const external = new AbortController();
    external.abort();
    const fetchMock = vi.fn().mockResolvedValue(Response.json(event));
    vi.stubGlobal('fetch', fetchMock);
    const result = observe(getEvent(external.signal));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.failure).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['quote', 'confirm'] as const)(
    'allows %s to be cancelled on unmount',
    async (operation) => {
      const external = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            bodyResponse(operation === 'quote' ? 200 : 201, new Promise(() => {})),
          ),
      );
      const result = observe(
        operation === 'quote'
          ? getQuote(draft, external.signal)
          : confirmOrder(draft, 'success', external.signal),
      );
      await vi.advanceTimersByTimeAsync(0);
      external.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(result.failure).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('detaches cancellation and clears its timer after a successful response', async () => {
    const external = new AbortController();
    const remove = vi.spyOn(external.signal, 'removeEventListener');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(event)));
    const request = getEvent(external.signal);
    await expect(request).resolves.toEqual(event);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    external.abort();
    await expect(request).resolves.toEqual(event);
  });

  it('distinguishes a network failure and clears the deadline', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getQuote(draft)).rejects.toMatchObject({ kind: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [
      422,
      { detail: [{ loc: ['body', 'email'], msg: 'invalid', type: 'value_error' }] },
      'validation',
    ],
    [409, { detail: { code: 'sold_out' } }, 'sold_out'],
    [503, { detail: 'Unavailable' }, 'server'],
    [201, {}, 'server'],
  ] as const)(
    'preserves HTTP %i handling without automatic confirmation retry',
    async (status, body, kind) => {
      const fetchMock = vi.fn().mockResolvedValue(Response.json(body, { status }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(confirmOrder(draft, 'success')).rejects.toMatchObject({ kind });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    { label: 'invalid JSON', body: '{broken' },
    { label: 'missing details', body: '{}' },
    { label: 'empty details', body: '{"detail":[]}' },
    {
      label: 'partially malformed details',
      body: JSON.stringify({
        detail: [{ loc: ['body', 'email'], msg: 'invalid', type: 'value_error' }, {}],
      }),
    },
  ])('rejects HTTP 422 with $label as a malformed server response', async ({ body }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 422 })));
    await expect(confirmOrder(draft, 'success')).rejects.toMatchObject({ kind: 'server' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a distinct useful timeout message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    let failure: unknown;
    void getQuote(draft).catch((error) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(errorMessage(failure)).toMatch(/не ответил в течение 15 секунд/i);
    expect(errorMessage(failure)).toMatch(/повтор/i);
    expect(errorMessage(failure)).not.toContain('Заказ не создан');
  });
});
