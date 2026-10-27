import { useEffect, useRef, useState } from 'react';
import type {
  CampaignDetail,
  CampaignPreview,
  CampaignSummary,
  OrganizerEvent,
  AssistantAnswersInput,
} from '../../api/generated/types.gen';
import {
  OrganizerApiError,
  confirmCampaign,
  createCampaign,
  errorMessage,
  getCampaign,
  getEvents,
  getPreview,
  listCampaigns,
  prepareCampaign,
  reconcileCampaign,
  resumeCampaign,
  rewriteCampaign,
  saveCampaign,
} from './api';
import { formFromCampaign } from './presentation';
import { emptyForm, toSaveRequest, validateForm } from './form';
import type { FieldErrors, FormField, OrganizerForm } from './form';
import { Button, fieldIds } from './components';
import type { Action } from './types';
import { AppHeader } from '../../components/AppHeader';
import { eventRoute } from './Events';
import { CampaignList } from './CampaignList';
import { CampaignPreview as CampaignPreviewView } from './CampaignPreview';
import { CampaignProgress } from './CampaignProgress';
import { CampaignDraft, clarificationReason, draftScreen, restoredAnswers } from './CampaignDraft';
import type { ClarificationInput } from './CampaignDraft';
import { assistantIntroduction, StageHeading, YearSourceHint } from './TransferPrimitives';
import { eventDateParts } from './presentation';

type Focus = { target: FormField | 'error' | 'title' | 'retry' | 'progress' };
export default function Organizer({
  campaignId,
  onDirtyChange,
}: {
  campaignId: string | null;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [events, setEvents] = useState<OrganizerEvent[]>([]);
  const [items, setItems] = useState<CampaignSummary[] | null>(null);
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [form, setForm] = useState<OrganizerForm>(emptyForm);
  const [dirty, setDirty] = useState(false);
  const [freshPreview, setFreshPreview] = useState<CampaignPreview | null>(null);
  const [prompt, setPrompt] = useState('');
  const [instruction, setInstruction] = useState('');
  const [forcedMode, setForcedMode] = useState<'assistant' | 'manual' | null>(null);
  const [eventEditor, setEventEditor] = useState(false);
  const [letterEditor, setLetterEditor] = useState(false);
  const [answers, setAnswers] = useState<ClarificationInput>({});
  const touched = useRef<Array<'event_id' | 'date' | 'time'>>([]);
  const textTouched = useRef(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [creationAttempted, setCreationAttempted] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<FieldErrors>({});
  const [info, setInfo] = useState('');
  const [feedbackAction, setFeedbackAction] = useState<Action | null>(null);
  const [progressError, setProgressError] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [uncertainConfirm, setUncertainConfirm] = useState(false);
  const [relatedCampaign, setRelatedCampaign] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const loadRetryRef = useRef<HTMLButtonElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const consumedFocus = useRef<Focus | null>(null);
  const requestInFlight = useRef(false);
  const requestEpoch = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const creationId = useRef<string | null>(null);
  const screen = campaign ? draftScreen(campaign, forcedMode) : 'assistant';
  const title = !campaignId
    ? 'Рассылки'
    : freshPreview
      ? 'Подтвердите перенос'
      : campaign?.phase === 'confirmed'
        ? 'Уведомление покупателей'
        : screen === 'prepared'
          ? 'Проверьте перенос'
          : screen === 'clarifications'
            ? campaign?.assistant_state?.clarifications.every(
                (question) => question.field === 'year',
              )
              ? 'Уточните год'
              : 'Уточните перенос'
            : screen === 'manual'
              ? 'Перенос мероприятия'
              : 'Перенос мероприятия';

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Sqoch`;
    return () => {
      document.title = previous;
    };
  }, [title]);

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
  useEffect(() => () => activeRequest.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      getEvents(abort.signal),
      campaignId ? getCampaign(campaignId, abort.signal) : listCampaigns(abort.signal),
    ])
      .then(([eventResult, result]) => {
        if (abort.signal.aborted) return;
        setEvents(eventResult.items);
        if ('phase' in result) {
          setCampaign(result);
          setPrompt(result.assistant_state?.original_prompt ?? '');
          setAnswers(restoredAnswers(result));
          const values = formFromCampaign(result);
          const selected = eventResult.items.find((event) => event.id === values.eventId);
          if (selected && values.reviewedEventRevision !== selected.revision) {
            values.reviewed = false;
            values.reviewedEventRevision = null;
          }
          setForm(values);
        } else setItems(result.items);
        setDirty(false);
        if (loadAttempt > 0) setFocus({ target: 'title' });
        else if (
          'phase' in result &&
          (document.activeElement === document.body || document.activeElement === titleRef.current)
        ) {
          const firstQuestion =
            result.phase === 'draft' && draftScreen(result, null) === 'clarifications'
              ? result.assistant_state?.clarifications[0]?.field
              : undefined;
          setFocus({ target: firstQuestion ?? 'title' });
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setError(errorMessage(failure, 'Не удалось загрузить данные кабинета'));
          if (loadAttempt > 0) setFocus({ target: 'retry' });
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [campaignId, loadAttempt]);
  useEffect(() => {
    if (!focus || focus === consumedFocus.current || pending || loading) return;
    consumedFocus.current = focus;
    const target =
      focus.target === 'error'
        ? errorRef.current
        : focus.target === 'title'
          ? titleRef.current
          : focus.target === 'retry'
            ? loadRetryRef.current
            : focus.target === 'progress'
              ? progressRef.current
              : document.getElementById(fieldIds[focus.target]);
    target?.focus();
    if (focus.target === 'error') target?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [focus, pending, loading]);
  const pollingId =
    campaign?.phase === 'confirmed' &&
    (campaign.status === 'processing' || campaign.status === 'needs_attention')
      ? campaign.id
      : null;
  useEffect(() => {
    if (!pollingId) return;
    let active = true;
    let abort: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      if (active)
        timer = setTimeout(() => {
          void poll();
        }, 2000);
    };
    const poll = async () => {
      if (requestInFlight.current) {
        schedule();
        return;
      }
      abort = new AbortController();
      const epoch = requestEpoch.current;
      try {
        const result = await getCampaign(pollingId, abort.signal);
        if (active && epoch === requestEpoch.current && !requestInFlight.current) {
          setCampaign(result);
          setProgressError('');
        }
      } catch {
        if (active && epoch === requestEpoch.current && !requestInFlight.current)
          setProgressError(
            'Не удалось обновить статус. Последние полученные данные остаются на экране.',
          );
      } finally {
        schedule();
      }
    };
    schedule();
    return () => {
      active = false;
      clearTimeout(timer);
      abort?.abort();
    };
  }, [pollingId]);

  function apply(result: CampaignDetail, preserveClarificationInput = false) {
    setCampaign(result);
    setForm(formFromCampaign(result));
    if (!preserveClarificationInput) setDirty(false);
    setFreshPreview(null);
    setNeedsRefresh(false);
    setUncertainConfirm(false);
    setProgressError('');
    setPrompt(result.assistant_state?.original_prompt ?? prompt);
    setForcedMode(null);
    setEventEditor(false);
    setLetterEditor(false);
    if (!preserveClarificationInput) setAnswers(restoredAnswers(result));
    touched.current = [];
    textTouched.current = false;
  }
  function edit(values: Partial<OrganizerForm>) {
    const sources: Array<'event_id' | 'date' | 'time'> = [];
    if ('eventId' in values) sources.push('event_id');
    if ('date' in values) sources.push('date');
    if ('time' in values) sources.push('time');
    for (const source of sources)
      if (!touched.current.includes(source)) touched.current.push(source);
    if ('subject' in values || 'body' in values) textTouched.current = true;
    setForm((current) => ({
      ...current,
      ...values,
      ...('date' in values || 'time' in values ? { canonicalStart: null } : {}),
      reviewed: false,
      reviewedEventRevision: null,
    }));
    setDirty(true);
    setFreshPreview(null);
    setInfo('');
    const changed = Object.keys(values).map((field) => (field === 'eventId' ? 'event_id' : field));
    setFields((current) =>
      Object.fromEntries(Object.entries(current).filter(([field]) => !changed.includes(field))),
    );
  }
  function report(failure: unknown, fallback: string) {
    if (failure instanceof OrganizerApiError) {
      setRelatedCampaign(failure.relatedCampaignId);
      if (failure.kind === 'validation') {
        const errors: FieldErrors = {};
        for (const issue of failure.issues) {
          const field = issue.loc[1];
          if (field === 'event_id') errors.event_id = 'Выберите мероприятие';
          if (field === 'proposed_start') errors.date = 'Укажите корректные дату и время переноса';
          if (field === 'subject') errors.subject = 'Укажите тему письма длиной до 200 символов';
          if (field === 'body') errors.body = 'Введите текст письма длиной до 10 000 символов';
          if (field === 'prompt') errors.prompt = 'Введите запрос длиной до 4000 символов';
          if (field === 'instruction')
            errors.instruction = 'Введите просьбу длиной до 4000 символов';
        }
        const first = Object.keys(errors)[0] as FormField | undefined;
        if (first) {
          setFields(errors);
          if (first === 'event_id' || first === 'date' || first === 'time') setEventEditor(true);
          if (first === 'subject' || first === 'body') setLetterEditor(true);
          setFocus({ target: first });
          return;
        }
      }
      if (
        [
          'revision_conflict',
          'text_review_required',
          'preview_stale',
          'confirmation_conflict',
          'campaign_immutable',
        ].includes(failure.code)
      ) {
        setNeedsRefresh(true);
        setFreshPreview(null);
        setForm((current) => ({ ...current, reviewed: false, reviewedEventRevision: null }));
        setDirty(true);
      }
    }
    setError(errorMessage(failure, fallback));
    setFocus({ target: 'error' });
  }
  async function run(
    action: Action,
    operation: (signal: AbortSignal) => Promise<void>,
    fallback: string,
  ) {
    if (requestInFlight.current) return;
    requestEpoch.current += 1;
    requestInFlight.current = true;
    const abort = new AbortController();
    activeRequest.current = abort;
    setPending(action);
    setFeedbackAction((current) => (action === 'refresh' ? current : action));
    setError('');
    setFields({});
    setInfo('');
    setRelatedCampaign(null);
    try {
      await operation(abort.signal);
    } catch (failure) {
      if (!abort.signal.aborted) report(failure, fallback);
    } finally {
      requestInFlight.current = false;
      if (!abort.signal.aborted) {
        activeRequest.current = null;
        setPending(null);
      }
    }
  }
  function validate(complete: boolean): boolean {
    const errors = validateForm(form, events, complete, Date.now);
    const first = Object.keys(errors)[0] as FormField | undefined;
    if (first) {
      setFields(errors);
      if (first === 'event_id' || first === 'date' || first === 'time') setEventEditor(true);
      if (first === 'subject' || first === 'body') setLetterEditor(true);
      setFocus({ target: first });
      return false;
    }
    return true;
  }
  async function saveCurrent(
    signal: AbortSignal,
    purpose: 'manual' | 'review' | 'ai' = 'review',
  ): Promise<CampaignDetail> {
    if (!campaign) throw new OrganizerApiError('invalid_response');
    const body = toSaveRequest(form, campaign.revision, {
      manual_fields: [...touched.current],
      prompt: prompt.trim(),
      ...(purpose === 'manual' || touched.current.length > 0 || textTouched.current
        ? { mode: 'manual' }
        : {}),
    });
    let saved: CampaignDetail;
    try {
      saved = await saveCampaign(campaign.id, body, signal);
    } catch (failure) {
      if (
        !(failure instanceof OrganizerApiError) ||
        !['network', 'timeout', 'invalid_response'].includes(failure.kind)
      )
        throw failure;
      const observed = await getCampaign(campaign.id, signal).catch(() => null);
      if (
        !observed ||
        observed.phase !== 'draft' ||
        observed.revision !== campaign.revision + 1 ||
        observed.event_id !== body.event_id ||
        observed.proposed_start !== body.proposed_start ||
        observed.subject !== body.subject ||
        observed.body !== body.body ||
        observed.text_reviewed !== body.text_reviewed ||
        observed.reviewed_event_revision !== body.reviewed_event_revision ||
        (body.mode !== undefined && observed.assistant_state?.mode !== body.mode) ||
        (observed.assistant_state?.original_prompt ?? '') !== body.prompt ||
        !body.manual_fields?.every((field) =>
          observed.assistant_state?.manual_fields.includes(field),
        )
      )
        throw failure;
      saved = observed;
    }
    if (!signal.aborted) apply(saved, purpose === 'ai' && screen === 'clarifications');
    return saved;
  }
  function save() {
    if (!validate(false)) return;
    void run(
      'save',
      async (signal) => {
        await saveCurrent(signal, 'manual');
        if (!signal.aborted) {
          setInfo('Подготовка сохранена');
          if (
            document.activeElement === document.body ||
            formRef.current?.contains(document.activeElement)
          )
            setFocus({ target: 'title' });
        }
      },
      'Не удалось сохранить черновик',
    );
  }
  function preparationFocus(result: CampaignDetail): Focus['target'] {
    const question = result.assistant_state?.clarifications[0];
    if (question) return question.field;
    if (result.assistant_state)
      return result.assistant_state.stage === 'applied' ? 'title' : 'prompt';
    return !result.event_id ? 'event_id' : !result.proposed_start ? 'date' : 'body';
  }
  function ai(action: 'prepare' | 'rewrite', clarificationAnswers?: AssistantAnswersInput) {
    const value = action === 'prepare' ? prompt : instruction;
    if ((!value.trim() && !clarificationAnswers) || value.length > 4000) {
      const field = action === 'prepare' ? 'prompt' : 'instruction';
      setFields({ [field]: 'Введите просьбу длиной от 1 до 4000 символов' });
      setFocus({ target: field });
      return;
    }
    if (!validate(false)) return;
    void run(
      action,
      async (signal) => {
        const original = prompt.trim();
        const changedPrompt = original !== campaign?.assistant_state?.original_prompt;
        const saved = await saveCurrent(signal, 'ai');
        let result;
        try {
          result =
            action === 'prepare'
              ? await prepareCampaign(
                  saved.id,
                  {
                    expected_revision: saved.revision,
                    ...(clarificationAnswers
                      ? { answers: clarificationAnswers }
                      : changedPrompt || !saved.assistant_state
                        ? { prompt: value.trim() }
                        : {}),
                  },
                  signal,
                )
              : await rewriteCampaign(
                  saved.id,
                  { expected_revision: saved.revision, instruction: value.trim() },
                  signal,
                );
        } catch (failure) {
          if (signal.aborted) return;
          const observed = await getCampaign(saved.id, signal).catch(() => null);
          if (signal.aborted) return;
          const matchingClarificationIntake = Boolean(
            clarificationAnswers &&
            observed?.assistant_state?.intake_revision === saved.revision + 1 &&
            observed.assistant_state.original_prompt === original &&
            Object.entries(clarificationAnswers).every(
              ([field, answer]) =>
                observed.assistant_state!.answers[field as keyof AssistantAnswersInput] === answer,
            ),
          );
          if (
            clarificationAnswers &&
            observed &&
            observed.revision > saved.revision &&
            !matchingClarificationIntake
          )
            throw new OrganizerApiError('domain', 'revision_conflict');
          if (observed) {
            setCampaign(observed);
            setForm((current) => ({ ...current, reviewed: false, reviewedEventRevision: null }));
            if (matchingClarificationIntake) setDirty(false);
            if (
              action === 'prepare' &&
              (!clarificationAnswers || matchingClarificationIntake) &&
              observed.assistant_state?.original_prompt === original &&
              observed.assistant_state.applied_revision === observed.revision &&
              observed.revision === saved.revision + 2 &&
              ['applied', 'needs_input'].includes(observed.assistant_state.stage)
            ) {
              const focusResult =
                document.activeElement === document.body ||
                formRef.current?.contains(document.activeElement);
              apply(observed);
              setInfo('Сохранённый результат подготовки восстановлен');
              if (focusResult) setFocus({ target: preparationFocus(observed) });
              return;
            }
          }
          if (action === 'rewrite') setLetterEditor(true);
          else if (observed?.assistant_state || saved.assistant_state)
            setForcedMode(
              draftScreen(observed ?? saved, null) === 'clarifications' ? null : 'assistant',
            );
          throw failure;
        }
        if (signal.aborted) return;
        apply(result.campaign);
        if (action === 'rewrite') {
          setInstruction('');
          setLetterEditor(true);
        }
        setInfo(result.message);
        if (
          document.activeElement === document.body ||
          formRef.current?.contains(document.activeElement)
        ) {
          setFocus({
            target:
              result.outcome === 'out_of_scope'
                ? action === 'prepare'
                  ? 'prompt'
                  : 'instruction'
                : action === 'rewrite'
                  ? 'body'
                  : preparationFocus(result.campaign),
          });
        }
      },
      'Не удалось получить ответ помощника',
    );
  }
  function check() {
    if (!validate(true)) return;
    void run(
      'preview',
      async (signal) => {
        const saved = await saveCurrent(signal);
        const result = await getPreview(saved.id, saved.revision, signal);
        if (signal.aborted) return;
        setFreshPreview(result);
        setFocus({ target: 'title' });
      },
      'Не удалось проверить рассылку',
    );
  }
  function continuePreparation() {
    const questions = campaign?.assistant_state?.clarifications ?? [];
    const errors: FieldErrors = {};
    const typed: AssistantAnswersInput = {};
    for (const question of questions) {
      const value = answers[question.field]?.trim() ?? '';
      if (question.field === 'year') {
        if (!/^\d{4}$/.test(value) || Number(value) < 1 || Number(value) > 9999)
          errors.year = 'Укажите год четырьмя цифрами';
        else typed.year = Number(value);
      } else if (question.field === 'event_id') {
        if (!events.some((event) => event.id === value)) errors.event_id = 'Выберите мероприятие';
        else typed.event_id = value;
      } else if (question.field === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.date = 'Укажите корректную дату';
        else typed.date = value;
      } else if (question.field === 'time') {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) errors.time = 'Укажите корректное время';
        else typed.time = value;
      }
    }
    const first = Object.keys(errors)[0] as FormField | undefined;
    if (first) {
      setFields(errors);
      setFocus({ target: first });
      return;
    }
    ai('prepare', typed);
  }
  function confirm() {
    if (!campaign || !freshPreview || dirty) return;
    void run(
      'confirm',
      async (signal) => {
        try {
          const result = await confirmCampaign(campaign.id, freshPreview.token, signal);
          if (!signal.aborted) {
            apply(result);
            setFocus({ target: 'title' });
          }
        } catch (failure) {
          if (signal.aborted) return;
          if (
            failure instanceof OrganizerApiError &&
            (failure.kind === 'validation' ||
              (failure.kind === 'domain' && failure.code !== 'storage_unavailable'))
          )
            throw failure;
          const observed = await getCampaign(campaign.id, signal).catch(() => null);
          if (signal.aborted) return;
          if (observed?.phase === 'confirmed') {
            apply(observed);
            setFocus({ target: 'title' });
            return;
          }
          setUncertainConfirm(true);
          setError(
            'Результат подтверждения неизвестен. Проверьте состояние этой рассылки перед следующим действием.',
          );
          setFocus({ target: 'error' });
        }
      },
      'Не удалось подтвердить перенос и отправку',
    );
  }
  function refresh() {
    if (!campaign) return;
    void run(
      'refresh',
      async (signal) => {
        const [eventResult, result] = await Promise.all([
          getEvents(signal),
          getCampaign(campaign.id, signal),
        ]);
        if (signal.aborted) return;
        setEvents(eventResult.items);
        const restoreFocus =
          document.activeElement === document.body ||
          formRef.current?.contains(document.activeElement) ||
          errorRef.current?.contains(document.activeElement);
        if (result.phase === 'confirmed') {
          apply(result);
          if (restoreFocus) setFocus({ target: 'title' });
        } else {
          setCampaign(result);
          setForm((current) => ({ ...current, reviewed: false, reviewedEventRevision: null }));
          setDirty(true);
          setFreshPreview(null);
          setNeedsRefresh(false);
          setUncertainConfirm(false);
          setInfo(
            'Сохранённая версия обновлена. Ваши правки остались в форме. Проверьте их и сохраните.',
          );
          if (restoreFocus) {
            const nextScreen = draftScreen(result, forcedMode);
            setFocus({
              target:
                nextScreen === 'clarifications'
                  ? (result.assistant_state?.clarifications[0]?.field ?? 'title')
                  : nextScreen === 'manual'
                    ? 'event_id'
                    : nextScreen === 'assistant'
                      ? 'prompt'
                      : 'title',
            });
          }
        }
      },
      'Не удалось обновить сведения',
    );
  }
  function recover(action: 'resume' | 'reconcile') {
    if (!campaign) return;
    void run(
      action,
      async (signal) => {
        const result =
          action === 'resume'
            ? await resumeCampaign(campaign.id, signal)
            : await reconcileCampaign(campaign.id, signal);
        if (!signal.aborted) {
          apply(result);
          setInfo(
            action === 'resume'
              ? 'Запрос на продолжение отправки принят'
              : result.counters.unknown > 0
                ? `Проверка завершена. Требуют проверки: ${result.counters.unknown}. Результат отправки этих писем пока не подтверждён. Причины указаны у адресов ниже. Повторная отправка этих писем не выполняется.`
                : 'Результаты сверены с Mailpit. Подтверждённые письма отмечены как отправленные.',
          );
          setFocus({ target: 'progress' });
        }
      },
      action === 'resume'
        ? 'Не удалось продолжить отправку'
        : 'Не удалось проверить результат в Mailpit',
    );
  }
  function create() {
    const id = creationId.current ?? crypto.randomUUID();
    creationId.current = id;
    setCreationAttempted(true);
    void run(
      'create',
      async (signal) => {
        let result: CampaignDetail;
        try {
          result = await createCampaign(id, {}, signal);
        } catch (failure) {
          const observed = await getCampaign(id, signal).catch(() => null);
          if (!observed) throw failure;
          result = observed;
        }
        if (!signal.aborted) window.location.hash = `/organizer/campaigns/${result.id}`;
      },
      'Не удалось создать черновик',
    );
  }
  const selectedEvent = events.find((event) => event.id === form.eventId);
  const disabled = pending !== null;
  const requestError = (error || needsRefresh) && (
    <div
      id="organizer-request-error"
      className={`notice ${error ? 'error' : ''} organizer-action-error`}
      role={error ? 'alert' : 'status'}
      tabIndex={-1}
      ref={errorRef}
    >
      {error ||
        (pending === 'refresh'
          ? 'Обновляем сохранённые сведения. Ваши правки останутся в форме.'
          : 'Сведения изменились. Обновите их перед следующей проверкой.')}
      {relatedCampaign && (
        <p>
          <a href={`#/organizer/campaigns/${relatedCampaign}`}>Открыть незавершённую рассылку</a>
        </p>
      )}
      {needsRefresh && (
        <div className="organizer-actions">
          <Button className="secondary" onClick={refresh} loading={disabled}>
            {pending === 'refresh' ? 'Обновляем сведения…' : 'Обновить сведения'}
          </Button>
        </div>
      )}
    </div>
  );
  const headingEyebrow =
    campaign?.phase === 'confirmed'
      ? 'Результат переноса'
      : freshPreview
        ? 'Подтверждение'
        : screen === 'prepared'
          ? 'Подготовка завершена'
          : 'Подготовка переноса';
  const confirmedDate = campaign?.event_snapshot
    ? eventDateParts(campaign.event_snapshot.new_start)
    : null;
  const headingIntroduction =
    campaign?.phase === 'confirmed' && confirmedDate
      ? `Дата мероприятия изменена. ${campaign.event_snapshot!.title}: ${confirmedDate.date}, ${confirmedDate.time} по Москве.`
      : freshPreview
        ? 'После подтверждения дата мероприятия изменится и начнётся уведомление покупателей.'
        : screen === 'prepared'
          ? campaign?.assistant_state?.mode === 'manual'
            ? 'Вы подготовили мероприятие, дату и письмо. Проверьте данные и при необходимости измените их.'
            : 'Помощник заполнил мероприятие, дату и письмо из вашего запроса. Проверьте данные и при необходимости измените их.'
          : screen === 'clarifications'
            ? campaign?.assistant_state?.clarifications.length === 1 &&
              campaign.assistant_state.clarifications[0]?.field === 'year'
              ? clarificationReason(
                  campaign.assistant_state.clarifications[0],
                  campaign.assistant_state,
                )
              : 'Дополните необходимые сведения. Ваш запрос и известные данные сохраняются.'
            : assistantIntroduction;

  return (
    <div className="page">
      <AppHeader section="organizer" />
      <main className="layout organizer">
        <section aria-label="Кабинет организатора">
          <StageHeading
            eyebrow={headingEyebrow}
            title={title}
            introduction={headingIntroduction}
            titleRef={titleRef}
            introductionId="organizer-stage-introduction"
          />
          <span id="organizer-timezone" className="sr-only">
            Дата и время указаны по Москве · Europe/Moscow (UTC+3)
          </span>
          {campaign?.phase === 'confirmed' && (
            <YearSourceHint state={campaign.assistant_state} final />
          )}
          {loading ? (
            <output className="content-column">Загружаем данные…</output>
          ) : !campaignId ? (
            <div className="content-column">
              {requestError}
              {items && (
                <CampaignList
                  items={items}
                  pending={pending}
                  creationAttempted={creationAttempted}
                  hasError={!!error}
                  onCreate={create}
                />
              )}
              {!items && (
                <Button
                  ref={loadRetryRef}
                  aria-describedby="organizer-request-error"
                  onClick={() => {
                    setLoading(true);
                    setError('');
                    setLoadAttempt((value) => value + 1);
                  }}
                >
                  Повторить загрузку
                </Button>
              )}
            </div>
          ) : !campaign ? (
            <div className="content-column">
              {requestError}
              <Button
                ref={loadRetryRef}
                aria-describedby="organizer-request-error"
                onClick={() => {
                  setLoading(true);
                  setError('');
                  setLoadAttempt((value) => value + 1);
                }}
              >
                Повторить загрузку
              </Button>
              <p className="organizer-back">
                <a href="#/organizer">К мероприятиям</a>
              </p>
            </div>
          ) : campaign.phase === 'confirmed' ? (
            <CampaignProgress
              campaign={campaign}
              pending={pending}
              progressError={progressError}
              info={info}
              requestError={requestError}
              progressRef={progressRef}
              onRecover={recover}
            />
          ) : freshPreview ? (
            <CampaignPreviewView
              preview={freshPreview}
              pending={pending}
              needsRefresh={needsRefresh}
              uncertainConfirm={uncertainConfirm}
              requestError={requestError}
              onRefresh={refresh}
              onConfirm={confirm}
              onEdit={() => {
                setFreshPreview(null);
                setError('');
                setFocus({ target: 'title' });
              }}
              assistantState={campaign.assistant_state}
            />
          ) : (
            <form
              ref={formRef}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (screen === 'manual') save();
                else if (screen === 'assistant') ai('prepare');
                else if (screen === 'clarifications') continuePreparation();
                else check();
              }}
            >
              <CampaignDraft
                campaign={campaign}
                events={events}
                form={form}
                prompt={prompt}
                instruction={instruction}
                screen={screen}
                answers={answers}
                fields={fields}
                pending={pending}
                dirty={dirty}
                eventEditor={eventEditor}
                letterEditor={letterEditor}
                requestError={requestError}
                info={info}
                feedbackAction={feedbackAction}
                onEdit={edit}
                onPrompt={(value) => {
                  setPrompt(value);
                  setDirty(true);
                  setInfo('');
                  setFields((current) => ({ ...current, prompt: undefined }));
                }}
                onInstruction={(value) => {
                  setInstruction(value);
                  setInfo('');
                  setFields((current) => ({ ...current, instruction: undefined }));
                }}
                onAnswer={(field, value) => {
                  setAnswers((current) => ({ ...current, [field]: value }));
                  setDirty(true);
                  setInfo('');
                  setFields((current) => ({ ...current, [field]: undefined }));
                }}
                onReview={(value) => {
                  setForm((current) => ({
                    ...current,
                    reviewed: value,
                    reviewedEventRevision: value ? (selectedEvent?.revision ?? null) : null,
                  }));
                  setDirty(true);
                  setInfo('');
                  setFreshPreview(null);
                }}
                onSave={save}
                onCheck={check}
                onPrepare={() => ai('prepare')}
                onContinue={continuePreparation}
                onRewrite={() => ai('rewrite')}
                onManual={() => {
                  setForcedMode('manual');
                  setFocus({ target: 'event_id' });
                }}
                onAssistant={() => {
                  setForcedMode('assistant');
                  setFocus({ target: 'prompt' });
                }}
                onEventEditor={() => {
                  setEventEditor(!eventEditor);
                  setFocus({ target: eventEditor ? 'title' : 'date' });
                }}
                onLetterEditor={() => {
                  setLetterEditor(!letterEditor);
                  setFocus({ target: letterEditor ? 'title' : 'subject' });
                }}
              />
            </form>
          )}
          {campaignId && campaign && (
            <p className="content-column organizer-back">
              <a href={campaign.event_id ? eventRoute(campaign.event_id) : '#/organizer'}>
                {campaign.event_id ? 'К мероприятию' : 'К мероприятиям'}
              </a>
            </p>
          )}
        </section>
      </main>
      <footer className="site-footer">
        <span>Sqoch · кабинет организатора</span>
        <span>Локальная отправка в Mailpit</span>
      </footer>
    </div>
  );
}
