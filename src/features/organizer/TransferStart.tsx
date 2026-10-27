import { useEffect, useRef, useState } from 'react';
import type {
  CampaignDetail,
  CreateCampaignRequest,
  OrganizerEvent,
} from '../../api/generated/types.gen';
import { AppHeader } from '../../components/AppHeader';
import {
  createCampaign,
  errorMessage,
  getCampaign,
  getEvents,
  prepareCampaign,
  saveCampaign,
} from './api';
import { Button, Field, fieldIds } from './components';
import { emptyForm, toSaveRequest, validateForm } from './form';
import type { FieldErrors, FormField, OrganizerForm } from './form';
import { eventRoute } from './Events';
import {
  assistantIntroduction,
  assistantYearHint,
  beforeConfirmHint,
  EventContext,
  StageHeading,
} from './TransferPrimitives';

export function TransferStart({
  eventId,
  onDirtyChange,
}: {
  eventId: string | null;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [events, setEvents] = useState<OrganizerEvent[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [manual, setManual] = useState(false);
  const [lastIntent, setLastIntent] = useState<'assistant' | 'manual'>('assistant');
  const [prompt, setPrompt] = useState('');
  const [form, setForm] = useState<OrganizerForm>(() => ({ ...emptyForm, eventId: eventId ?? '' }));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<'saving' | 'preparing' | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  const [error, setError] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ target: FormField | 'error' } | null>(null);
  const saved = useRef<CampaignDetail | null>(null);
  const mustRefresh = useRef(false);
  const creationId = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const manualFields = useRef<Array<'event_id' | 'date' | 'time'>>([]);
  const errorRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const context = events?.find((event) => event.id === form.eventId);
  const focusOn = (target: FormField | 'error') => setFocus({ target });

  useEffect(() => {
    const previous = document.title;
    document.title = 'Перенос мероприятия · Sqoch';
    return () => {
      document.title = previous;
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    getEvents(abort.signal)
      .then((result) => {
        if (!abort.signal.aborted) {
          setEvents(result.items);
          setLoadError('');
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted)
          setLoadError(errorMessage(failure, 'Не удалось загрузить мероприятия'));
      });
    return () => abort.abort();
  }, [loadAttempt]);
  useEffect(() => {
    if (loadAttempt > 0) (loadError ? retryRef.current : events ? titleRef.current : null)?.focus();
  }, [loadAttempt, loadError, events]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!focus || pending) return;
    const target =
      focus.target === 'error' ? errorRef.current : document.getElementById(fieldIds[focus.target]);
    target?.focus();
    if (focus.target === 'error') target?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [focus, pending, manual]);

  function edit(values: Partial<OrganizerForm>, source?: 'event_id' | 'date' | 'time') {
    setForm((current) => ({ ...current, ...values }));
    if (source && !manualFields.current.includes(source)) manualFields.current.push(source);
    setDirty(true);
    const changed = Object.keys(values).map((field) => (field === 'eventId' ? 'event_id' : field));
    setFields((current) =>
      Object.fromEntries(Object.entries(current).filter(([field]) => !changed.includes(field))),
    );
    setError('');
  }
  function openSaved(result: CampaignDetail) {
    onDirtyChange(false);
    setDirty(false);
    window.location.hash = `/organizer/campaigns/${result.id}`;
  }
  async function ensureSaved(body: CreateCampaignRequest, signal: AbortSignal) {
    if (saved.current) {
      if (mustRefresh.current) {
        saved.current = await getCampaign(saved.current.id, signal);
        mustRefresh.current = false;
      }
      return saved.current;
    }
    const id = creationId.current ?? crypto.randomUUID();
    creationId.current = id;
    let result: CampaignDetail;
    try {
      result = await createCampaign(id, body, signal);
    } catch (failure) {
      if (signal.aborted) throw failure;
      const observed = await getCampaign(id, signal).catch(() => null);
      if (!observed) throw failure;
      result = observed;
    }
    if (signal.aborted) return result;
    saved.current = result;
    setSavedId(result.id);
    return result;
  }
  async function submit(intent: 'assistant' | 'manual') {
    if (inFlight.current || !events) return;
    const manualIntent = intent === 'manual';
    setLastIntent(intent);
    setFocus(null);
    setError('');
    if (!manualIntent && (!prompt.trim() || prompt.length > 4000)) {
      setFields({ prompt: 'Введите запрос длиной от 1 до 4000 символов' });
      focusOn('prompt');
      return;
    }
    const hasManualInput =
      manualFields.current.length > 0 ||
      Boolean(form.date || form.time || form.subject || form.body);
    if (manualIntent || hasManualInput) {
      const errors = validateForm(form, events, false, Date.now);
      if (form.date && !form.time) delete errors.date;
      const first = Object.keys(errors)[0] as FormField | undefined;
      if (first) {
        setManual(true);
        setFields(errors);
        focusOn(first);
        return;
      }
    }
    if (manualIntent) {
      if (
        !form.date &&
        !form.time &&
        !form.subject.trim() &&
        !form.body.trim() &&
        (!form.eventId || !manualFields.current.includes('event_id'))
      ) {
        setError('Введите новую дату, тему или текст письма, чтобы сохранить подготовку');
        focusOn('error');
        return;
      }
    }
    const abort = new AbortController();
    request.current = abort;
    inFlight.current = true;
    setPending('saving');
    const values = toSaveRequest(form, 0);
    const effectiveContext = manualFields.current.includes('event_id')
      ? form.eventId || null
      : eventId;
    const matchesFields = (result: CampaignDetail) =>
      result.event_id === values.event_id &&
      result.proposed_start === values.proposed_start &&
      result.subject === values.subject &&
      result.body === values.body;
    const matchesProvenance = (result: CampaignDetail) =>
      manualFields.current.every((field) => result.assistant_state?.manual_fields.includes(field));
    const matchesPrompt = (result: CampaignDetail) =>
      (result.assistant_state?.original_prompt ?? '') === prompt.trim();
    let saveRevision: number | null = null;
    let prepareRevision: number | null = null;
    try {
      const body: CreateCampaignRequest = manualIntent
        ? {
            mode: 'manual',
            event_id: values.event_id,
            proposed_start: values.proposed_start,
            subject: values.subject,
            body: values.body,
            manual_fields: [...manualFields.current],
            ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
          }
        : {
            mode: 'assistant',
            prompt: prompt.trim(),
            context_event_id: effectiveContext,
            ...(hasManualInput
              ? {
                  event_id: values.event_id,
                  proposed_start: values.proposed_start,
                  subject: values.subject,
                  body: values.body,
                  manual_fields: [...manualFields.current],
                }
              : {}),
          };
      const existing = saved.current;
      let result = await ensureSaved(body, abort.signal);
      if (abort.signal.aborted) return;
      if (result.phase === 'confirmed') {
        openSaved(result);
        return;
      }
      if (manualIntent || hasManualInput) {
        if (existing || !matchesFields(result) || !matchesPrompt(result)) {
          saveRevision = result.revision + 1;
          result = await saveCampaign(
            result.id,
            {
              ...values,
              expected_revision: result.revision,
              mode: 'manual',
              manual_fields: [...manualFields.current],
              prompt: prompt.trim(),
            },
            abort.signal,
          );
          if (abort.signal.aborted) return;
          saved.current = result;
        }
      }
      if (manualIntent) {
        if (!abort.signal.aborted) openSaved(result);
        return;
      }
      if (
        result.assistant_state?.original_prompt === prompt.trim() &&
        (!hasManualInput || matchesFields(result))
      ) {
        setDirty(false);
        onDirtyChange(false);
      }
      setPending('preparing');
      prepareRevision = result.revision;
      const prepared = await prepareCampaign(
        result.id,
        {
          expected_revision: result.revision,
          prompt: prompt.trim(),
          ...(manualFields.current.includes('event_id')
            ? { context_event_id: effectiveContext }
            : {}),
        },
        abort.signal,
      );
      if (!abort.signal.aborted) openSaved(prepared.campaign);
    } catch (failure) {
      if (abort.signal.aborted) return;
      if (saved.current) {
        mustRefresh.current = true;
        const observed = await getCampaign(saved.current.id, abort.signal).catch(() => null);
        if (abort.signal.aborted) return;
        if (observed) {
          saved.current = observed;
          mustRefresh.current = false;
          const fieldsSaved = matchesFields(observed) && matchesProvenance(observed);
          const manualSaved =
            saveRevision !== null &&
            observed.revision === saveRevision &&
            fieldsSaved &&
            matchesPrompt(observed);
          const requestSaved =
            observed.assistant_state?.original_prompt === prompt.trim() &&
            (!hasManualInput || fieldsSaved);
          if (!manualIntent && requestSaved) {
            setDirty(false);
            onDirtyChange(false);
          } else {
            setDirty(true);
            onDirtyChange(true);
          }
          if (
            (manualIntent && manualSaved) ||
            (prepareRevision !== null &&
              observed.assistant_state?.original_prompt === prompt.trim() &&
              observed.revision === prepareRevision + 2 &&
              observed.assistant_state?.applied_revision === observed.revision &&
              ['applied', 'needs_input'].includes(observed.assistant_state.stage))
          ) {
            openSaved(observed);
            return;
          }
        }
      }
      setError(
        errorMessage(
          failure,
          saved.current
            ? 'Не удалось подготовить перенос. Сохранённый запрос доступен для продолжения'
            : 'Не удалось сохранить подготовку',
        ),
      );
      if (
        document.activeElement === document.body ||
        formRef.current?.contains(document.activeElement)
      )
        focusOn('error');
    } finally {
      inFlight.current = false;
      if (!abort.signal.aborted) {
        request.current = null;
        setPending(null);
      }
    }
  }
  const disabled = pending !== null;
  const props = (field: FormField) => ({
    id: fieldIds[field],
    disabled,
    'aria-invalid': Boolean(fields[field]),
    'aria-describedby':
      fields[field] || field === 'prompt'
        ? `${fieldIds[field]}-description`
        : field === 'date' || field === 'time'
          ? 'transfer-timezone'
          : undefined,
  });
  const feedback = (
    <>
      {pending && (
        <output>
          {pending === 'saving'
            ? 'Сохраняем подготовку…'
            : 'Готовим перенос. Ответ помощника может занять до минуты…'}
        </output>
      )}
      {error && (
        <div
          className="notice error organizer-action-error"
          role="alert"
          tabIndex={-1}
          ref={errorRef}
        >
          {error}
        </div>
      )}
    </>
  );
  return (
    <div className="page">
      <AppHeader section="organizer" />
      <main className="layout organizer">
        <StageHeading
          eyebrow="Подготовка переноса"
          title="Перенос мероприятия"
          introduction={assistantIntroduction}
          titleRef={titleRef}
        />
        <span id="transfer-timezone" className="sr-only">
          Дата и время указаны по Москве · Europe/Moscow (UTC+3)
        </span>
        {loadError ? (
          <>
            <div id="transfer-load-error" className="notice error" role="alert">
              {loadError}
            </div>
            <Button
              ref={retryRef}
              aria-describedby="transfer-load-error"
              onClick={() => {
                setLoadError('');
                setEvents(null);
                setLoadAttempt((value) => value + 1);
              }}
            >
              Повторить загрузку
            </Button>
          </>
        ) : !events ? (
          <output>Загружаем мероприятия…</output>
        ) : eventId !== null && !events.some((event) => event.id === eventId) ? (
          <>
            <h2>Мероприятие не найдено</h2>
            <p>Выберите мероприятие в обзоре</p>
          </>
        ) : (
          <div ref={formRef}>
            {context && <EventContext event={context} canChoose />}
            <form
              className="transfer-stack"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void submit('assistant');
              }}
            >
              <Field
                label="Как переносим мероприятие?"
                field="prompt"
                error={fields.prompt}
                hint={assistantYearHint}
              >
                <textarea
                  {...props('prompt')}
                  rows={4}
                  maxLength={4000}
                  placeholder="Переносим Керамику на 2 декабря, 19:00"
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    setDirty(true);
                    setFields((current) => ({ ...current, prompt: undefined }));
                    setError('');
                  }}
                />
              </Field>
              {lastIntent === 'assistant' && feedback}
              <div className="transfer-action-row">
                <Button type="submit" loading={disabled}>
                  Подготовить перенос
                </Button>
                <Button
                  className="secondary"
                  disabled={disabled}
                  aria-expanded={manual}
                  aria-controls="transfer-manual-panel"
                  onClick={() => {
                    const opening = !manual;
                    setManual(opening);
                    focusOn(opening ? (eventId ? 'date' : 'event_id') : 'prompt');
                    setFields({});
                    setError('');
                  }}
                >
                  Заполнить вручную
                </Button>
              </div>
              <p className="transfer-muted">{beforeConfirmHint}</p>
            </form>
            {manual && (
              <section
                id="transfer-manual-panel"
                className="transfer-manual"
                aria-labelledby="transfer-manual-title"
              >
                <h2 id="transfer-manual-title">Ручная подготовка</h2>
                <p className="transfer-muted">
                  Заполните дату и письмо самостоятельно. Перед отправкой останется проверить состав
                  переноса.
                </p>
                <form
                  className="transfer-stack"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit('manual');
                  }}
                >
                  {eventId === null && (
                    <Field label="Мероприятие" field="event_id" error={fields.event_id}>
                      <select
                        {...props('event_id')}
                        value={form.eventId}
                        onChange={(event) => edit({ eventId: event.target.value }, 'event_id')}
                      >
                        <option value="">Выберите мероприятие</option>
                        {events.map((event) => (
                          <option key={event.id} value={event.id}>
                            {event.title}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <div className="organizer-date-fields">
                    <Field label="Новая дата" field="date" error={fields.date}>
                      <input
                        {...props('date')}
                        type="date"
                        value={form.date}
                        onChange={(event) => edit({ date: event.target.value }, 'date')}
                      />
                    </Field>
                    <Field label="Новое время" field="time" error={fields.time}>
                      <input
                        {...props('time')}
                        type="time"
                        value={form.time}
                        onChange={(event) => edit({ time: event.target.value }, 'time')}
                      />
                    </Field>
                  </div>
                  <Field label="Тема" field="subject">
                    <input
                      {...props('subject')}
                      maxLength={200}
                      value={form.subject}
                      onChange={(event) => edit({ subject: event.target.value })}
                    />
                  </Field>
                  <Field label="Текст письма" field="body">
                    <textarea
                      {...props('body')}
                      rows={6}
                      maxLength={10000}
                      value={form.body}
                      onChange={(event) => edit({ body: event.target.value })}
                    />
                  </Field>
                  {lastIntent === 'manual' && feedback}
                  <Button type="submit" loading={disabled}>
                    Сохранить подготовку
                  </Button>
                </form>
              </section>
            )}
            {(dirty || savedId) && (
              <p className="organizer-save-status">
                {dirty ? 'Есть несохранённые изменения' : 'Подготовка сохранена'}
              </p>
            )}
            {savedId && (
              <p className="organizer-back">
                <a href={`#/organizer/campaigns/${savedId}`}>Открыть сохранённую подготовку</a>
              </p>
            )}
          </div>
        )}
        <p className="organizer-back">
          <a href={eventId ? eventRoute(eventId) : '#/organizer'}>
            {eventId ? 'К мероприятию' : 'К мероприятиям'}
          </a>
        </p>
      </main>
      <footer className="site-footer">
        <span>Sqoch · кабинет организатора</span>
        <span>Локальная отправка в Mailpit</span>
      </footer>
    </div>
  );
}
