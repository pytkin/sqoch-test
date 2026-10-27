import { vi } from 'vitest';
import type {
  CampaignDetail,
  CampaignPreview,
  CampaignSummary,
  OrganizerEvent,
} from '../../api/generated/types.gen';

export const campaignId = '93ce9274-81a3-451e-8b90-993cf03be1d3';
export const campaignPath = `/api/organizer/campaigns/${campaignId}`;
export const events: OrganizerEvent[] = [
  {
    id: 'ceramics',
    title: 'Керамика',
    starts_at: '2099-11-10T19:00:00+03:00',
    timezone: 'Europe/Moscow',
    revision: 0,
  },
  {
    id: 'painting',
    title: 'Живопись',
    starts_at: '2099-11-12T18:00:00+03:00',
    timezone: 'Europe/Moscow',
    revision: 0,
  },
];

export function draft(overrides: Partial<CampaignDetail> = {}): CampaignDetail {
  return {
    id: campaignId,
    phase: 'draft',
    revision: 5,
    created_at: '2026-10-26T12:00:00Z',
    updated_at: '2026-10-26T12:00:00Z',
    event_id: 'ceramics',
    proposed_start: '2099-11-20T19:00:00+03:00',
    suggested_start: null,
    subject: 'Перенос мастер-класса «Керамика»',
    body: 'Мастер-класс состоится 20 ноября 2099 года в 19:00 по Москве.',
    text_reviewed: false,
    reviewed_event_revision: null,
    confirmed_at: null,
    event_snapshot: null,
    preview: null,
    status: 'draft',
    counters: { total: 0, pending: 0, sending: 0, retry_wait: 0, sent: 0, failed: 0, unknown: 0 },
    deliveries: [],
    assistant_state: null,
    ...overrides,
  };
}

export function preview(campaign: CampaignDetail): CampaignPreview {
  return {
    token: 'f581a810-9f4b-40af-851a-0482f53d49a9',
    campaign_id: campaign.id,
    draft_revision: campaign.revision,
    event: events[0]!,
    old_start: events[0]!.starts_at,
    proposed_start: campaign.proposed_start!,
    subject: campaign.subject,
    body: campaign.body,
    recipients: ['sent@example.com', 'unknown@example.com'],
  };
}

export function confirmed(overrides: Partial<CampaignDetail> = {}): CampaignDetail {
  return draft({
    phase: 'confirmed',
    revision: 6,
    text_reviewed: true,
    reviewed_event_revision: 0,
    confirmed_at: '2026-10-26T12:05:00Z',
    status: 'needs_attention',
    event_snapshot: {
      id: 'ceramics',
      title: 'Керамика',
      old_start: events[0]!.starts_at,
      new_start: '2099-11-20T19:00:00+03:00',
      timezone: 'Europe/Moscow',
      event_revision_before: 0,
    },
    counters: { total: 2, pending: 0, sending: 0, retry_wait: 0, sent: 1, failed: 0, unknown: 1 },
    deliveries: [
      {
        id: 'delivery-sent',
        email: 'sent@example.com',
        state: 'sent',
        attempts: 1,
        next_attempt_at: null,
        sent_at: '2026-10-26T12:05:01Z',
        error_code: null,
        error_message: null,
      },
      {
        id: 'delivery-unknown',
        email: 'unknown@example.com',
        state: 'unknown',
        attempts: 1,
        next_attempt_at: null,
        sent_at: null,
        error_code: 'not_found_in_mailpit',
        error_message: 'Результат отправки требует проверки',
      },
    ],
    ...overrides,
  });
}

export function summary(campaign: CampaignDetail): CampaignSummary {
  const hasContent = Boolean(
    campaign.event_id ||
    campaign.proposed_start ||
    campaign.suggested_start ||
    campaign.subject ||
    campaign.body ||
    campaign.assistant_state?.original_prompt,
  );
  return {
    id: campaign.id,
    phase: campaign.phase,
    revision: campaign.revision,
    created_at: campaign.created_at,
    updated_at: campaign.updated_at,
    event_id: campaign.event_id,
    event_title: 'Керамика',
    subject: campaign.subject,
    proposed_start: campaign.proposed_start,
    status: campaign.status,
    counters: campaign.counters,
    has_content: hasContent,
    preparation_stage:
      campaign.phase === 'confirmed'
        ? null
        : (campaign.assistant_state?.stage ?? (hasContent ? 'manual' : 'empty')),
    event_snapshot: campaign.event_snapshot,
  };
}

export type ApiRequest = { path: string; method: string; body: Record<string, unknown> };
export type ApiHandler = (request: ApiRequest) => Response | Promise<Response>;

export function mockOrganizerApi(handler: ApiHandler): ApiRequest[] {
  const requests: ApiRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = input instanceof Request ? input.url : String(input);
      if (path === '/api/event') {
        return Response.json({
          id: 'sqoch-event',
          title: 'Мероприятие Sqoch',
          currency: 'RUB',
          max_participants: 4,
          child_age_limit: 14,
          companion_min_age: 18,
          full_ticket_price: 2000,
          child_ticket_price: 1000,
        });
      }
      const request = {
        path,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      };
      requests.push(request);
      if (path === '/api/organizer/events') return Response.json({ items: events });
      return handler(request);
    }),
  );
  return requests;
}

export function apiNotFound(): Response {
  return Response.json(
    { detail: { code: 'not_found', message: 'Рассылка не найдена', related_campaign_id: null } },
    { status: 404 },
  );
}
