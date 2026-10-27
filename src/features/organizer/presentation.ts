import type { CampaignDetail } from '../../api/generated/types.gen';

import type { OrganizerForm } from './form';

export function moscowParts(value: string | null): { date: string; time: string } {
  if (!value) return { date: '', time: '' };
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === name)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}

export function formFromCampaign(campaign: CampaignDetail): OrganizerForm {
  return {
    eventId: campaign.event_id ?? '',
    ...moscowParts(campaign.proposed_start),
    subject: campaign.subject,
    body: campaign.body,
    reviewed: campaign.text_reviewed,
    reviewedEventRevision: campaign.reviewed_event_revision,
    canonicalStart: campaign.proposed_start,
  };
}

export function combineMoscow(date: string, time: string): string | null {
  if (!date && !time) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const value = `${date}T${time}:00+03:00`;
  if (!Number.isFinite(Date.parse(value))) return null;
  const roundtrip = moscowParts(value);
  return roundtrip.date === date && roundtrip.time === time ? value : null;
}

export function dateLabel(value: string): string {
  const precision = /T\d{2}:\d{2}:(\d{2})(?:\.(\d+))?/.exec(value);
  const showSeconds = Number(precision?.[1]) > 0 || /[1-9]/.test(precision?.[2] ?? '');
  const label = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(showSeconds ? { second: '2-digit' as const } : {}),
    hourCycle: 'h23',
  }).format(new Date(value));
  return showSeconds && precision?.[2] ? `${label}.${precision[2]}` : label;
}
export function eventDateParts(value: string): { date: string; time: string } {
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
    .format(new Date(value))
    .replace(/\s*г\.$/, ' года');
  const precise = dateLabel(value);
  const time = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.exec(precise)?.[0] ?? moscowParts(value).time;
  return { date, time };
}
export function metadataDateLabel(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}
export function partialDateLabel(value: {
  year: number | null;
  month: number | null;
  day: number | null;
}): string {
  if (value.month === null || value.day === null) return '';
  const date = new Date(0);
  date.setUTCFullYear(value.year ?? 2000, value.month - 1, value.day);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    ...(value.year ? { year: 'numeric' as const } : {}),
  })
    .format(date)
    .replace(/\s*г\.$/, ' года');
}
export function recipientCountLabel(count: number): string {
  const last = count % 10;
  const lastTwo = count % 100;
  return `${count} ${last === 1 && lastTwo !== 11 ? 'адрес' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'адреса' : 'адресов'}`;
}

export const campaignStatus: Record<CampaignDetail['status'], string> = {
  draft: 'Черновик',
  processing: 'Отправка продолжается',
  needs_attention: 'Требует проверки',
  completed: 'Рассылка завершена',
  completed_with_errors: 'Завершена с ошибками',
};
export const deliveryStatus: Record<CampaignDetail['deliveries'][number]['state'], string> = {
  pending: 'Ожидает отправки',
  sending: 'Отправляется',
  retry_wait: 'Ожидает повторной попытки',
  sent: 'Отправлено',
  failed: 'Не отправлено',
  unknown: 'Требует проверки',
};
