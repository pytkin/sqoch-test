const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const whole = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const optionalWhole = (value: unknown, minimum: number, maximum: number) =>
  value === null || whole(value, minimum, maximum);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const eventId = (value: unknown): value is string => string(value) && value.length > 0;

function calendarDate(value: unknown): boolean {
  if (!string(value) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  if (!whole(Number(value.slice(0, 4)), 1, 9999)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function answers(value: unknown): boolean {
  return (
    object(value) &&
    onlyKeys(value, ['event_id', 'year', 'date', 'time']) &&
    (!('event_id' in value) || eventId(value.event_id)) &&
    (!('year' in value) || whole(value.year, 1, 9999)) &&
    (!('date' in value) || calendarDate(value.date)) &&
    (!('time' in value) ||
      (string(value.time) && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.time)))
  );
}

function partialDate(value: unknown): boolean {
  if (
    !object(value) ||
    !onlyKeys(value, ['year', 'month', 'day', 'hour', 'minute']) ||
    !optionalWhole(value.year, 1, 9999) ||
    !optionalWhole(value.month, 1, 12) ||
    !optionalWhole(value.day, 1, 31) ||
    !optionalWhole(value.hour, 0, 23) ||
    !optionalWhole(value.minute, 0, 59)
  )
    return false;
  if (typeof value.month === 'number' && typeof value.day === 'number') {
    // A leap-capable reference validates month/day; it is never a proposed year.
    const year = typeof value.year === 'number' ? value.year : 2000;
    return calendarDate(
      `${String(year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`,
    );
  }
  return true;
}

export const preparationStages = ['intake', 'applied', 'needs_input', 'failed'];

export function clarification(value: unknown): boolean {
  return (
    object(value) &&
    onlyKeys(value, ['field', 'reason', 'candidate_event_id']) &&
    string(value.field) &&
    ['event_id', 'year', 'date', 'time'].includes(value.field) &&
    string(value.reason) &&
    ['missing', 'ambiguous', 'invalid', 'past', 'conflict'].includes(value.reason) &&
    (value.candidate_event_id === null ||
      (value.field === 'event_id' && eventId(value.candidate_event_id)))
  );
}

export function assistantState(value: unknown, revision: number): boolean {
  if (value === null) return true;
  return (
    object(value) &&
    onlyKeys(value, [
      'version',
      'mode',
      'stage',
      'original_prompt',
      'answers',
      'context_event_id',
      'partial_date',
      'manual_fields',
      'clarifications',
      'intake_revision',
      'applied_revision',
      'year_source',
    ]) &&
    value.version === 1 &&
    string(value.mode) &&
    ['assistant', 'manual'].includes(value.mode) &&
    string(value.stage) &&
    preparationStages.includes(value.stage) &&
    string(value.original_prompt) &&
    value.original_prompt.length <= 4000 &&
    answers(value.answers) &&
    (value.context_event_id === null || eventId(value.context_event_id)) &&
    partialDate(value.partial_date) &&
    (value.year_source === undefined ||
      value.year_source === null ||
      (string(value.year_source) &&
        ['explicit', 'current_year', 'clarification', 'manual'].includes(value.year_source) &&
        object(value.partial_date) &&
        whole(value.partial_date.year, 1, 9999))) &&
    Array.isArray(value.manual_fields) &&
    value.manual_fields.length <= 3 &&
    new Set(value.manual_fields).size === value.manual_fields.length &&
    value.manual_fields.every(
      (field) => string(field) && ['event_id', 'date', 'time'].includes(field),
    ) &&
    Array.isArray(value.clarifications) &&
    value.clarifications.length <= 4 &&
    value.clarifications.every(clarification) &&
    optionalWhole(value.intake_revision, 0, revision) &&
    optionalWhole(value.applied_revision, 0, revision)
  );
}
