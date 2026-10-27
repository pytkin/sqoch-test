import type {
  AiActionResponse,
  CampaignCounters,
  CampaignDelivery,
  CampaignDetail,
  CampaignList,
  CampaignPreview,
  CampaignSummary,
  OrganizerEvent,
  OrganizerEvents,
  ValidationIssue,
} from '../../api/generated/types.gen';
import { assistantState, clarification } from './preparationGuards';

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown): value is string => typeof value === 'string';
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string =>
  text(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown): value is string | null => value === null || date(value);
export const uuid = (value: unknown): value is string =>
  text(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const states = ['pending', 'sending', 'retry_wait', 'sent', 'failed', 'unknown'] as const;
const statuses = ['draft', 'processing', 'needs_attention', 'completed', 'completed_with_errors'];
const summaryStages: Record<NonNullable<CampaignSummary['preparation_stage']>, true> = {
  empty: true,
  manual: true,
  intake: true,
  applied: true,
  needs_input: true,
  failed: true,
};
function counters(value: unknown): value is CampaignCounters {
  return (
    record(value) &&
    integer(value.total) &&
    states.every((state) => integer(value[state])) &&
    states.reduce((sum, state) => sum + Number(value[state]), 0) === value.total
  );
}
function event(value: unknown): value is OrganizerEvent {
  return (
    record(value) &&
    text(value.id) &&
    !!value.id &&
    text(value.title) &&
    date(value.starts_at) &&
    value.timezone === 'Europe/Moscow' &&
    integer(value.revision)
  );
}
function snapshot(value: unknown): value is NonNullable<CampaignDetail['event_snapshot']> {
  return (
    record(value) &&
    text(value.id) &&
    text(value.title) &&
    date(value.old_start) &&
    date(value.new_start) &&
    value.timezone === 'Europe/Moscow' &&
    integer(value.event_revision_before)
  );
}
function delivery(value: unknown): value is CampaignDelivery {
  return (
    record(value) &&
    text(value.id) &&
    text(value.email) &&
    text(value.state) &&
    states.some((state) => value.state === state) &&
    integer(value.attempts) &&
    value.attempts <= 5 &&
    nullableDate(value.next_attempt_at) &&
    nullableDate(value.sent_at) &&
    nullableText(value.error_code) &&
    nullableText(value.error_message)
  );
}
export function campaignPreview(value: unknown): value is CampaignPreview {
  return (
    record(value) &&
    uuid(value.token) &&
    uuid(value.campaign_id) &&
    integer(value.draft_revision) &&
    event(value.event) &&
    date(value.old_start) &&
    date(value.proposed_start) &&
    text(value.subject) &&
    text(value.body) &&
    Array.isArray(value.recipients) &&
    value.recipients.length > 0 &&
    value.recipients.every(text) &&
    new Set(value.recipients).size === value.recipients.length
  );
}
function expectedStatus(value: CampaignCounters): CampaignDetail['status'] {
  if (value.pending + value.sending + value.retry_wait > 0) return 'processing';
  if (value.unknown > 0) return 'needs_attention';
  return value.failed > 0 ? 'completed_with_errors' : 'completed';
}
export function campaign(value: unknown): value is CampaignDetail {
  if (
    !record(value) ||
    !uuid(value.id) ||
    !integer(value.revision) ||
    !assistantState(value.assistant_state, value.revision) ||
    !date(value.created_at) ||
    !date(value.updated_at) ||
    !nullableText(value.event_id) ||
    !nullableDate(value.proposed_start) ||
    !nullableDate(value.suggested_start) ||
    !text(value.subject) ||
    !text(value.body) ||
    typeof value.text_reviewed !== 'boolean' ||
    !(value.reviewed_event_revision === null || integer(value.reviewed_event_revision)) ||
    !nullableDate(value.confirmed_at) ||
    !(value.preview === null || campaignPreview(value.preview)) ||
    !counters(value.counters) ||
    !Array.isArray(value.deliveries) ||
    !value.deliveries.every(delivery)
  )
    return false;
  if (value.preview && value.preview.campaign_id !== value.id) return false;
  if (value.phase === 'draft')
    return (
      value.status === 'draft' &&
      value.confirmed_at === null &&
      value.event_snapshot === null &&
      value.counters.total === 0 &&
      value.deliveries.length === 0
    );
  if (
    value.phase !== 'confirmed' ||
    !snapshot(value.event_snapshot) ||
    !date(value.confirmed_at) ||
    !date(value.proposed_start) ||
    !text(value.event_id) ||
    !value.subject.trim() ||
    !value.body.trim() ||
    value.counters.total === 0 ||
    value.counters.total !== value.deliveries.length ||
    value.status !== expectedStatus(value.counters)
  )
    return false;
  const checkedCounters = value.counters;
  const checkedDeliveries = value.deliveries;
  return states.every(
    (state) =>
      checkedCounters[state] === checkedDeliveries.filter((item) => item.state === state).length,
  );
}
function summary(value: unknown): value is CampaignSummary {
  return (
    record(value) &&
    uuid(value.id) &&
    (value.phase === 'draft' || value.phase === 'confirmed') &&
    integer(value.revision) &&
    date(value.created_at) &&
    date(value.updated_at) &&
    typeof value.has_content === 'boolean' &&
    (value.preparation_stage === null ||
      (text(value.preparation_stage) && Object.hasOwn(summaryStages, value.preparation_stage))) &&
    nullableText(value.event_id) &&
    nullableText(value.event_title) &&
    text(value.subject) &&
    (value.proposed_start === null || date(value.proposed_start)) &&
    counters(value.counters) &&
    text(value.status) &&
    statuses.includes(value.status) &&
    (value.phase === 'draft'
      ? value.status === 'draft' && value.counters.total === 0 && value.event_snapshot === null
      : value.status === expectedStatus(value.counters) &&
        value.preparation_stage === null &&
        snapshot(value.event_snapshot) &&
        value.event_snapshot.id === value.event_id &&
        value.event_snapshot.new_start === value.proposed_start)
  );
}
export function action(value: unknown): value is AiActionResponse {
  return (
    record(value) &&
    campaign(value.campaign) &&
    text(value.outcome) &&
    ['applied', 'needs_input', 'out_of_scope'].includes(value.outcome) &&
    text(value.message) &&
    Array.isArray(value.fields_to_complete) &&
    value.fields_to_complete.every((field) =>
      ['event_id', 'proposed_start', 'subject', 'body'].includes(field),
    ) &&
    Array.isArray(value.clarifications) &&
    value.clarifications.every(clarification)
  );
}
export function validationIssues(value: unknown): value is ValidationIssue[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (issue) =>
        record(issue) &&
        Array.isArray(issue.loc) &&
        issue.loc.length > 0 &&
        issue.loc.every((part) => text(part) || integer(part)) &&
        text(issue.msg) &&
        text(issue.type),
    )
  );
}
export function organizerEvents(value: unknown): value is OrganizerEvents {
  return record(value) && Array.isArray(value.items) && value.items.every(event);
}

export function campaignList(value: unknown): value is CampaignList {
  return record(value) && Array.isArray(value.items) && value.items.every(summary);
}
