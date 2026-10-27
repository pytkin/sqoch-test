import { withDeadline } from '../../api/abortable';
import type {
  AiActionResponse,
  CampaignDetail,
  CampaignList,
  CampaignPreview,
  CreateCampaignRequest,
  OrganizerEvent,
  OrganizerEvents,
  PrepareRequest,
  RewriteRequest,
  SaveCampaignRequest,
  ValidationIssue,
} from '../../api/generated/types.gen';
import {
  action,
  campaign,
  campaignList,
  campaignPreview,
  organizerEvents,
  record,
  text,
  uuid,
  validationIssues,
} from './responseGuards';

export type { CampaignDetail, CampaignPreview, OrganizerEvent, SaveCampaignRequest };

type ErrorKind = 'network' | 'timeout' | 'invalid_response' | 'validation' | 'domain' | 'cancelled';
export class OrganizerApiError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    public readonly code = '',
    public readonly issues: ValidationIssue[] = [],
    public readonly relatedCampaignId: string | null = null,
  ) {
    super(kind);
  }
}
function responseError(payload: unknown): OrganizerApiError {
  if (record(payload)) {
    if (validationIssues(payload.detail))
      return new OrganizerApiError('validation', '', payload.detail);
    if (
      record(payload.detail) &&
      text(payload.detail.code) &&
      payload.detail.code &&
      text(payload.detail.message) &&
      (payload.detail.related_campaign_id === null || uuid(payload.detail.related_campaign_id))
    )
      return new OrganizerApiError(
        'domain',
        payload.detail.code,
        [],
        payload.detail.related_campaign_id,
      );
  }
  return new OrganizerApiError('invalid_response');
}
async function request<T>(
  path: string,
  guard: (value: unknown) => value is T,
  options: { method?: string; body?: unknown; signal?: AbortSignal; timeout?: number } = {},
): Promise<T> {
  return withDeadline(
    async (signal) => {
      try {
        const response = await fetch(path, {
          method: options.method ?? 'GET',
          ...(options.body === undefined
            ? {}
            : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(options.body),
              }),
          signal,
        });
        const payload: unknown = await response.json().catch(() => {
          throw new OrganizerApiError('invalid_response');
        });
        if (!response.ok) throw responseError(payload);
        if (!guard(payload)) throw new OrganizerApiError('invalid_response');
        return payload;
      } catch (error) {
        if (error instanceof OrganizerApiError) throw error;
        if (signal.aborted) throw signal.reason;
        throw new OrganizerApiError('network');
      }
    },
    {
      signal: options.signal,
      timeoutMs: options.timeout ?? 15000,
      timeoutError: () => new OrganizerApiError('timeout'),
      cancelledError: () => new OrganizerApiError('cancelled'),
    },
  );
}
const path = (id: string) => `/api/organizer/campaigns/${encodeURIComponent(id)}`;
const matchingCampaign =
  (id: string) =>
  (value: unknown): value is CampaignDetail =>
    campaign(value) && value.id === id;
const matchingPreview =
  (id: string) =>
  (value: unknown): value is CampaignPreview =>
    campaignPreview(value) && value.campaign_id === id;
const matchingConfirmed =
  (id: string) =>
  (value: unknown): value is CampaignDetail =>
    campaign(value) && value.id === id && value.phase === 'confirmed';
const matchingAction =
  (id: string) =>
  (value: unknown): value is AiActionResponse =>
    action(value) && value.campaign.id === id && value.campaign.phase === 'draft';
export const getEvents = (signal?: AbortSignal) =>
  request<OrganizerEvents>('/api/organizer/events', organizerEvents, { signal });
export const listCampaigns = (signal?: AbortSignal) =>
  request<CampaignList>('/api/organizer/campaigns', campaignList, { signal });
export const getCampaign = (id: string, signal?: AbortSignal) =>
  request(path(id), matchingCampaign(id), { signal });
export const createCampaign = (
  id: string,
  body: CreateCampaignRequest = {},
  signal?: AbortSignal,
) => request(path(id), matchingCampaign(id), { method: 'PUT', body, signal });
export const saveCampaign = (id: string, body: SaveCampaignRequest, signal?: AbortSignal) =>
  request(path(id), matchingCampaign(id), { method: 'PATCH', body, signal });
export const getPreview = (id: string, revision: number, signal?: AbortSignal) =>
  request(`${path(id)}/preview`, matchingPreview(id), {
    method: 'POST',
    body: { expected_revision: revision },
    signal,
  });
export const confirmCampaign = (id: string, token: string, signal?: AbortSignal) =>
  request(`${path(id)}/confirm`, matchingConfirmed(id), {
    method: 'POST',
    body: { preview_token: token },
    signal,
  });
export const resumeCampaign = (id: string, signal?: AbortSignal) =>
  request(`${path(id)}/resume`, matchingConfirmed(id), { method: 'POST', body: {}, signal });
export const reconcileCampaign = (id: string, signal?: AbortSignal) =>
  request(`${path(id)}/reconcile`, matchingConfirmed(id), { method: 'POST', body: {}, signal });
export const prepareCampaign = (id: string, body: PrepareRequest, signal?: AbortSignal) =>
  request(`${path(id)}/prepare`, matchingAction(id), {
    method: 'POST',
    body,
    signal,
    timeout: 60000,
  });
export const rewriteCampaign = (id: string, body: RewriteRequest, signal?: AbortSignal) =>
  request(`${path(id)}/rewrite`, matchingAction(id), {
    method: 'POST',
    body,
    signal,
    timeout: 60000,
  });

const messages: Record<string, string> = {
  not_found: 'Рассылка не найдена',
  revision_conflict:
    'Черновик изменился. Ваши правки остались в форме. Обновите сохранённую версию и повторите действие.',
  text_review_required: 'Сведения о мероприятии изменились. Обновите их и проверьте текст ещё раз.',
  preview_stale:
    'Данные изменились после проверки. Обновите предпросмотр и подтвердите рассылку заново.',
  event_campaign_unsettled:
    'У этого мероприятия есть незавершённая рассылка. Проверьте её состояние.',
  no_recipients: 'Нет покупателей с действующими покупками',
  date_not_future: 'Укажите дату и время в будущем',
  date_unchanged: 'Новая дата совпадает с текущей',
  campaign_immutable: 'Рассылка уже подтверждена. Её текст и получатели больше не меняются.',
  campaign_not_confirmed: 'Сначала проверьте и подтвердите рассылку',
  confirmation_conflict: 'Рассылка уже подтверждена. Обновите её состояние.',
  ai_not_configured: 'Помощник пока недоступен. Можно заполнить форму вручную.',
  ai_unavailable:
    'Не удалось получить текст помощника. Повторите запрос или отредактируйте письмо вручную.',
  ai_invalid_response:
    'Помощник вернул неполные данные. Прежний черновик сохранён. Повторите запрос или заполните форму вручную.',
  ai_timeout:
    'Помощник не успел ответить. Прежний черновик сохранён. Повторите запрос или заполните форму вручную.',
};
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof OrganizerApiError) {
    if (error.kind === 'domain' && messages[error.code]) return messages[error.code];
    if (error.kind === 'validation') return 'Проверьте указанные поля';
    if (error.kind === 'timeout') return `${fallback}. Время ожидания истекло. Повторите действие.`;
  }
  return `${fallback}. Повторите действие.`;
}
