import type {
  Event,
  OrderRequest,
  Quote,
  ConfirmedOrder,
  ValidationIssue,
} from './generated/types.gen';
export type { Event, Quote, ConfirmedOrder } from './generated/types.gen';
export type Draft = { participants: { name: string; age: string }[]; email: string };
export type Scenario = 'success' | 'sold_out';
export class ApiError extends Error {
  constructor(
    public kind: 'network' | 'timeout' | 'validation' | 'sold_out' | 'server',
    public issues: ValidationIssue[] = [],
  ) {
    super(kind);
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function isEvent(value: unknown): value is Event {
  return (
    object(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    value.currency === 'RUB' &&
    [
      'max_participants',
      'child_age_limit',
      'companion_min_age',
      'full_ticket_price',
      'child_ticket_price',
    ].every((key) => integer(value[key])) &&
    Number(value.max_participants) > 0
  );
}
function isQuote(value: unknown): value is Quote {
  return (
    object(value) &&
    Array.isArray(value.participants) &&
    value.participants.length >= 1 &&
    value.participants.length <= 4 &&
    value.participants.every(
      (p) =>
        object(p) &&
        typeof p.name === 'string' &&
        p.name.trim().length > 0 &&
        integer(p.age) &&
        (p.ticket_type === 'child' || p.ticket_type === 'full') &&
        integer(p.price),
    ) &&
    typeof value.email === 'string' &&
    integer(value.total) &&
    value.currency === 'RUB'
  );
}
function isConfirmed(value: unknown): value is ConfirmedOrder {
  return (
    isQuote(value) &&
    'order_id' in value &&
    typeof value.order_id === 'string' &&
    value.order_id.length > 0
  );
}
function isValidationIssue(value: unknown): value is ValidationIssue {
  return (
    object(value) &&
    Array.isArray(value.loc) &&
    value.loc.every((part) => typeof part === 'string' || typeof part === 'number') &&
    typeof value.msg === 'string' &&
    typeof value.type === 'string'
  );
}
async function readResponse<T>(
  url: string,
  expectedStatus: number,
  valid: (value: unknown) => value is T,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    if (init?.signal?.aborted) throw init.signal.reason;
    throw new ApiError('network');
  }
  if (!response.ok) {
    if (response.status === 422) {
      const body: unknown = await response.json().catch(() => null);
      if (
        object(body) &&
        Array.isArray(body.detail) &&
        body.detail.length > 0 &&
        body.detail.every(isValidationIssue)
      )
        throw new ApiError('validation', body.detail);
      throw new ApiError('server');
    }
    if (response.status === 409) {
      const body: unknown = await response.json().catch(() => null);
      if (object(body) && object(body.detail) && body.detail.code === 'sold_out')
        throw new ApiError('sold_out');
    }
    throw new ApiError('server');
  }
  if (response.status !== expectedStatus) throw new ApiError('server');
  try {
    const value: unknown = await response.json();
    if (!valid(value)) throw new ApiError('server');
    return value;
  } catch {
    if (init?.signal?.aborted) throw init.signal.reason;
    throw new ApiError('server');
  }
}
async function request<T>(
  url: string,
  expectedStatus: number,
  valid: (value: unknown) => value is T,
  init?: RequestInit,
): Promise<T> {
  const external = init?.signal;
  const cancelled = () => new DOMException('Request cancelled', 'AbortError');
  if (external?.aborted) throw cancelled();
  const controller = new AbortController();
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (error: Error) => {
    controller.abort(error);
    rejectCancellation(error);
  };
  const onAbort = () => cancel(cancelled());
  external?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => cancel(new ApiError('timeout')), 15_000);
  try {
    return await Promise.race([
      readResponse(url, expectedStatus, valid, { ...init, signal: controller.signal }),
      cancellation,
    ]);
  } finally {
    clearTimeout(deadline);
    external?.removeEventListener('abort', onAbort);
  }
}
export function getEvent(signal: AbortSignal) {
  return request<Event>('/api/event', 200, isEvent, { signal });
}
function toOrder(draft: Draft): OrderRequest {
  return {
    participants: draft.participants.map((p) => ({ name: p.name.trim(), age: Number(p.age) })),
    email: draft.email.trim(),
  };
}
export function getQuote(draft: Draft, signal?: AbortSignal) {
  return request<Quote>('/api/orders/quote', 200, isQuote, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toOrder(draft)),
    signal,
  });
}
export function confirmOrder(draft: Draft, scenario: Scenario, signal?: AbortSignal) {
  return request<ConfirmedOrder>('/api/orders', 201, isConfirmed, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Demo-Scenario': scenario },
    body: JSON.stringify(toOrder(draft)),
    signal,
  });
}
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'timeout')
      return 'Превышено время ожидания ответа. Проверьте соединение и повторите действие.';
    if (error.kind === 'network')
      return 'Не удалось связаться с сервером. Проверьте соединение и попробуйте ещё раз.';
    if (error.kind === 'validation')
      return 'Проверьте данные заказа. Сервер не принял введённые значения.';
  }
  return 'Сервер временно недоступен. Попробуйте ещё раз.';
}
