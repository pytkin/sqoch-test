import { withDeadline } from '../../api/abortable';
import type {
  Event,
  OrderRequest,
  Quote,
  ConfirmedOrder,
  ValidationIssue,
} from '../../api/generated/types.gen';
export type { Event, Quote, ConfirmedOrder } from '../../api/generated/types.gen';
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
  return withDeadline((signal) => readResponse(url, expectedStatus, valid, { ...init, signal }), {
    signal: init?.signal ?? undefined,
    timeoutMs: 15000,
    timeoutError: () => new ApiError('timeout'),
    cancelledError: () => new DOMException('Request cancelled', 'AbortError'),
  });
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
export function errorMessage(
  error: unknown,
  operation: 'event' | 'quote' | 'confirm' = 'quote',
): string {
  if (error instanceof ApiError && error.kind === 'sold_out')
    return 'Не удалось оформить заказ: места закончились. Заказ не создан. Данные участников, email и расчёт остались на этой странице. Чтобы проверить успешное оформление в демо, выберите «Успех» и нажмите «Повторить подтверждение».';
  if (error instanceof ApiError && error.kind === 'validation')
    return 'Сервер не принял данные заказа. Проверьте введённые значения и состав участников, затем нажмите «Проверить заказ».';
  const reason =
    error instanceof ApiError && error.kind === 'timeout'
      ? 'Сервер не ответил в течение 15 секунд.'
      : error instanceof ApiError && error.kind === 'network'
        ? 'Не удалось связаться с сервером.'
        : 'Сервер вернул ошибку или некорректный ответ.';
  if (operation === 'confirm')
    return `Результат подтверждения неизвестен. ${reason} Сервер мог создать заказ, но ответ не получен. Участники, email и расчёт остались на этой странице. Если решите повторить попытку, нажмите «Подтвердить заказ». Автоматически запрос не повторяется.`;
  if (operation === 'event')
    return `Не удалось загрузить данные мероприятия. ${reason} Проверьте соединение и нажмите «Повторить загрузку».`;
  return `Не удалось рассчитать стоимость заказа. ${reason} Данные участников и email остались на этой странице. Повторите расчёт кнопкой «Проверить заказ».`;
}
