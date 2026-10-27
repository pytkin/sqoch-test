import type {
  CampaignDetail,
  OrganizerEvent,
  SaveCampaignRequest,
} from '../../api/generated/types.gen';
import { combineMoscow } from './presentation';

export type OrganizerForm = {
  eventId: string;
  date: string;
  time: string;
  subject: string;
  body: string;
  reviewed: boolean;
  reviewedEventRevision: number | null;
  canonicalStart?: string | null;
};

export type FormField =
  | 'event_id'
  | 'date'
  | 'time'
  | 'subject'
  | 'body'
  | 'reviewed'
  | 'prompt'
  | 'instruction'
  | 'year';
export type FieldErrors = Partial<Record<FormField, string>>;

export const emptyForm: OrganizerForm = {
  eventId: '',
  date: '',
  time: '',
  subject: '',
  body: '',
  reviewed: false,
  reviewedEventRevision: null,
};

export function validateForm(
  form: OrganizerForm,
  events: OrganizerEvent[],
  complete: boolean,
  now: () => number,
): FieldErrors {
  const errors: FieldErrors = {};
  const proposed = form.canonicalStart ?? combineMoscow(form.date, form.time);
  if ((form.date || form.time) && !proposed) {
    if (!form.date || !proposed) errors.date = 'Укажите корректную дату переноса';
    if (!form.time) errors.time = 'Укажите время переноса';
  }
  if (complete) {
    if (!events.some((event) => event.id === form.eventId))
      errors.event_id = 'Выберите мероприятие';
    if (!proposed) errors.date = 'Укажите новую дату и время';
    else if (Date.parse(proposed) <= now()) errors.date = 'Укажите дату и время в будущем';
    if (!form.subject.trim()) errors.subject = 'Укажите тему письма';
    if (!form.body.trim()) errors.body = 'Введите текст письма';
    if (!form.reviewed) errors.reviewed = 'Проверьте соответствие текста мероприятию и новой дате';
  }
  return errors;
}

export function toSaveRequest(
  form: OrganizerForm,
  revision: CampaignDetail['revision'],
  metadata: Pick<SaveCampaignRequest, 'mode' | 'manual_fields' | 'prompt'> = {},
): SaveCampaignRequest {
  return {
    expected_revision: revision,
    event_id: form.eventId || null,
    proposed_start: form.canonicalStart ?? combineMoscow(form.date, form.time),
    subject: form.subject.trim(),
    body: form.body.trim(),
    text_reviewed: form.reviewed,
    reviewed_event_revision: form.reviewed ? form.reviewedEventRevision : null,
    ...metadata,
  };
}
