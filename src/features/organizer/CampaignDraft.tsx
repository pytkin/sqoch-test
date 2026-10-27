import type { ReactNode } from 'react';
import type {
  AssistantState,
  CampaignDetail,
  Clarification,
  OrganizerEvent,
} from '../../api/generated/types.gen';
import type { FieldErrors, FormField, OrganizerForm } from './form';
import type { Action } from './types';
import { Button, Field, fieldIds } from './components';
import { combineMoscow, dateLabel, partialDateLabel } from './presentation';
import {
  assistantYearHint,
  beforeConfirmHint,
  DateComparison,
  EditButton,
  EventContext,
  YearSourceHint,
} from './TransferPrimitives';

export function clarificationReason(question: Clarification, state: AssistantState | null): string {
  if (question.field === 'year') {
    const reason =
      question.reason === 'past'
        ? 'Эта дата уже прошла. Укажите будущий год.'
        : question.reason === 'conflict'
          ? 'В сведениях о годе есть противоречие. Укажите нужный год.'
          : question.reason === 'invalid'
            ? 'Год указан некорректно. Укажите год четырьмя цифрами.'
            : question.reason === 'ambiguous'
              ? 'Год не определён однозначно. Укажите нужный год.'
              : 'Укажите год проведения.';
    const dayKnown = state?.partial_date.day != null && state?.partial_date.month != null;
    const timeKnown = state?.partial_date.hour != null && state?.partial_date.minute != null;
    const retained =
      dayKnown && timeKnown
        ? 'День и время сохранены'
        : dayKnown
          ? 'День и месяц сохранены'
          : timeKnown
            ? 'Время сохранено'
            : '';
    return retained ? `${reason} ${retained}` : reason;
  }
  return question.reason === 'past'
    ? 'Указанная дата уже прошла. Уточните будущую дату.'
    : question.reason === 'conflict'
      ? 'Сведения противоречат выбранным данным. Подтвердите правильное значение.'
      : question.reason === 'ambiguous'
        ? 'Найдено несколько подходящих вариантов. Выберите нужный.'
        : question.reason === 'invalid'
          ? 'Значение некорректно. Укажите его заново.'
          : 'Дополните недостающие сведения';
}

export type ClarificationInput = Partial<Record<'event_id' | 'year' | 'date' | 'time', string>>;
export type DraftScreen = 'assistant' | 'clarifications' | 'prepared' | 'manual';
export function restoredAnswers(campaign: CampaignDetail): ClarificationInput {
  const answers: ClarificationInput = {};
  for (const question of campaign.assistant_state?.clarifications ?? []) {
    if (question.field === 'event_id') continue;
    const value = campaign.assistant_state?.answers[question.field];
    if (value !== undefined) answers[question.field] = String(value);
  }
  return answers;
}
export function draftScreen(
  campaign: CampaignDetail,
  forced: 'assistant' | 'manual' | null,
): DraftScreen {
  if (forced) return forced;
  const state = campaign.assistant_state;
  const complete = Boolean(
    campaign.event_id && campaign.proposed_start && campaign.subject && campaign.body,
  );
  if (!state)
    return campaign.event_id ||
      campaign.proposed_start ||
      campaign.subject ||
      campaign.body ||
      campaign.suggested_start
      ? 'manual'
      : 'assistant';
  if (state.stage === 'applied' && complete) return 'prepared';
  if (state.mode === 'manual') return 'manual';
  return state.stage === 'needs_input' && state.clarifications.length > 0
    ? 'clarifications'
    : 'assistant';
}

export function CampaignDraft({
  campaign,
  events,
  form,
  prompt,
  instruction,
  screen,
  answers,
  fields,
  pending,
  dirty,
  eventEditor,
  letterEditor,
  requestError,
  info,
  feedbackAction,
  onEdit,
  onPrompt,
  onInstruction,
  onAnswer,
  onReview,
  onSave,
  onCheck,
  onPrepare,
  onContinue,
  onRewrite,
  onManual,
  onAssistant,
  onEventEditor,
  onLetterEditor,
}: {
  campaign: CampaignDetail;
  events: OrganizerEvent[];
  form: OrganizerForm;
  prompt: string;
  instruction: string;
  screen: DraftScreen;
  answers: ClarificationInput;
  fields: FieldErrors;
  pending: Action | null;
  dirty: boolean;
  eventEditor: boolean;
  letterEditor: boolean;
  requestError: ReactNode;
  info: string;
  feedbackAction: Action | null;
  onEdit: (values: Partial<OrganizerForm>) => void;
  onPrompt: (value: string) => void;
  onInstruction: (value: string) => void;
  onAnswer: (field: keyof ClarificationInput, value: string) => void;
  onReview: (value: boolean) => void;
  onSave: () => void;
  onCheck: () => void;
  onPrepare: () => void;
  onContinue: () => void;
  onRewrite: () => void;
  onManual: () => void;
  onAssistant: () => void;
  onEventEditor: () => void;
  onLetterEditor: () => void;
}) {
  const disabled = pending !== null;
  const state = campaign.assistant_state;
  const selected = events.find((event) => event.id === form.eventId);
  const proposed = form.canonicalStart ?? combineMoscow(form.date, form.time);
  const previous =
    state &&
    (state.stage === 'failed' || state.stage === 'intake') &&
    Boolean(campaign.subject || campaign.body || campaign.proposed_start);
  const props = (field: FormField) => ({
    id: fieldIds[field],
    disabled,
    'aria-invalid': Boolean(fields[field]),
    'aria-describedby':
      [
        fields[field] || field === 'prompt' || field === 'instruction'
          ? `${fieldIds[field]}-description`
          : undefined,
        field === 'date' || field === 'time' ? 'organizer-timezone' : undefined,
      ]
        .filter(Boolean)
        .join(' ') || undefined,
  });
  const singleYear =
    state?.clarifications.length === 1 && state.clarifications[0]?.field === 'year';
  const questionProps = (question: Clarification, index: number) => ({
    ...props(question.field),
    'aria-describedby': [
      props(question.field)['aria-describedby'],
      question.candidate_event_id ? `organizer-clarification-${index}-candidate` : undefined,
      singleYear ? 'organizer-stage-introduction' : `organizer-clarification-${index}-reason`,
      singleYear && !fields.year ? `${fieldIds.year}-description` : undefined,
    ]
      .filter(Boolean)
      .join(' '),
  });
  const questionReason = (question: Clarification) => clarificationReason(question, state);
  const actionFeedback = (action: Action) =>
    feedbackAction === action && (
      <>
        {requestError}
        {info && <output className="organizer-info">{info}</output>}
      </>
    );
  const assistant = (
    <fieldset className="transfer-stack transfer-assistant">
      <legend className="sr-only">Подготовка с помощником</legend>
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
          onChange={(event) => onPrompt(event.target.value)}
        />
      </Field>
      {actionFeedback('prepare')}
      <div className="transfer-action-row">
        <Button onClick={onPrepare} loading={disabled}>
          {pending === 'prepare' ? 'Готовим перенос…' : 'Подготовить перенос'}
        </Button>
        <Button
          className="secondary"
          disabled={disabled}
          aria-expanded={screen === 'manual'}
          aria-controls="saved-manual-panel"
          onClick={screen === 'manual' ? onAssistant : onManual}
        >
          Заполнить вручную
        </Button>
      </div>
      <p className="transfer-muted">{beforeConfirmHint}</p>
    </fieldset>
  );
  const eventFields = (
    <div className="transfer-stack">
      <Field label="Мероприятие" field="event_id" error={fields.event_id}>
        <select
          {...props('event_id')}
          value={form.eventId}
          required
          onChange={(event) => onEdit({ eventId: event.target.value })}
        >
          <option value="">Выберите мероприятие</option>
          {events.map((event) => (
            <option key={event.id} value={event.id}>
              {event.title}
            </option>
          ))}
        </select>
      </Field>
      <div className="organizer-date-fields">
        <Field label="Новая дата" field="date" error={fields.date}>
          <input
            {...props('date')}
            type="date"
            value={form.date}
            required
            onChange={(event) => onEdit({ date: event.target.value })}
          />
        </Field>
        <Field label="Новое время" field="time" error={fields.time}>
          <input
            {...props('time')}
            type="time"
            value={form.time}
            required
            onChange={(event) => onEdit({ time: event.target.value })}
          />
        </Field>
      </div>
      {campaign.suggested_start && !form.canonicalStart && (
        <p className="field-hint">
          Помощник предложил: {dateLabel(campaign.suggested_start)}. Введите дату и время в поля
          выше.
        </p>
      )}
    </div>
  );
  const letterFields = (
    <div className="transfer-stack">
      <Field label="Тема" field="subject" error={fields.subject}>
        <input
          {...props('subject')}
          value={form.subject}
          required
          maxLength={200}
          onChange={(event) => onEdit({ subject: event.target.value })}
        />
      </Field>
      <Field label="Текст письма" field="body" error={fields.body}>
        <textarea
          {...props('body')}
          rows={6}
          maxLength={10000}
          required
          value={form.body}
          onChange={(event) => onEdit({ body: event.target.value })}
        />
      </Field>
      {(screen === 'prepared' || !state) && (
        <>
          <Field
            label="Что изменить с помощником?"
            field="instruction"
            error={fields.instruction}
            hint="Мероприятие и новая дата останутся прежними."
          >
            <textarea
              {...props('instruction')}
              rows={2}
              maxLength={4000}
              placeholder="Например, сделай обращение менее официальным"
              value={instruction}
              onChange={(event) => onInstruction(event.target.value)}
            />
          </Field>
          {actionFeedback('rewrite')}
          <Button className="secondary" onClick={onRewrite} loading={disabled}>
            {pending === 'rewrite' ? 'Меняем текст…' : 'Изменить текст'}
          </Button>
        </>
      )}
    </div>
  );
  const editing = eventEditor || letterEditor;
  const reviewVisible = screen === 'prepared' || (screen === 'manual' && !state);
  return (
    <>
      {!previous && state && (state.stage === 'intake' || state.stage === 'failed') && (
        <output className="notice warning transfer-spaced">
          {state.stage === 'intake'
            ? 'Подготовка не завершена. Повторите запрос явно или заполните данные вручную.'
            : 'Не удалось подготовить перенос. Сохранённый запрос можно повторить или заполнить данные вручную.'}
        </output>
      )}
      {previous && (
        <output className="notice warning organizer-prior-result">
          <p>
            Показан предыдущий результат.{' '}
            {state.stage === 'intake'
              ? 'Подготовка нового запроса не завершена. Повторите её явно.'
              : 'Новый запрос пока не подготовлен. Повторите запрос или измените данные вручную.'}
          </p>
          {campaign.subject && <p className="transfer-subject">{campaign.subject}</p>}
          {campaign.body && <p className="organizer-letter">{campaign.body}</p>}
        </output>
      )}
      {(pending === 'prepare' || pending === 'rewrite') && (
        <output className="transfer-muted transfer-spaced">
          {pending === 'rewrite'
            ? 'Обновляем текст уведомления. Ответ помощника может занять до минуты.'
            : screen === 'clarifications'
              ? 'Уточняем сведения и готовим перенос. Ответ помощника может занять до минуты.'
              : 'Сохраняем ввод и готовим перенос. Ответ помощника может занять до минуты.'}
        </output>
      )}
      {(screen === 'assistant' || screen === 'manual' || screen === 'clarifications') &&
        selected && <EventContext event={selected} canChoose={screen !== 'clarifications'} />}
      {(screen === 'assistant' || screen === 'manual') && assistant}
      {screen === 'clarifications' && (
        <>
          <div className="transfer-request">
            <p className="transfer-muted">Ваш запрос</p>
            <p>{state!.original_prompt}</p>
          </div>
          <dl className="transfer-facts">
            {state!.partial_date.day && state!.partial_date.month && (
              <div>
                <dt>Новый день</dt>
                <dd>{partialDateLabel(state!.partial_date)}</dd>
              </div>
            )}
            {state!.partial_date.hour !== null && state!.partial_date.minute !== null && (
              <div>
                <dt>Время</dt>
                <dd>
                  {String(state!.partial_date.hour).padStart(2, '0')}:
                  {String(state!.partial_date.minute).padStart(2, '0')} по Москве
                </dd>
              </div>
            )}
          </dl>
          <div className="transfer-stack">
            {state!.clarifications.map((question, index) => (
              <div
                key={`${question.field}-${index}`}
                className={question.field === 'year' ? 'transfer-year' : undefined}
              >
                {question.candidate_event_id && (
                  <p className="field-hint" id={`organizer-clarification-${index}-candidate`}>
                    Помощник предложил мероприятие «
                    {events.find((event) => event.id === question.candidate_event_id)?.title ??
                      question.candidate_event_id}
                    ». Подтвердите нужное мероприятие выбором.
                  </p>
                )}
                {!singleYear && (
                  <p className="field-hint" id={`organizer-clarification-${index}-reason`}>
                    {questionReason(question)}
                  </p>
                )}
                {question.field === 'year' ? (
                  <Field
                    label="В каком году состоится мероприятие?"
                    field="year"
                    error={fields.year}
                    hint={
                      singleYear
                        ? 'Укажите год четырьмя цифрами. Уже выбранные день и время повторно вводить не нужно.'
                        : undefined
                    }
                  >
                    <input
                      {...questionProps(question, index)}
                      inputMode="numeric"
                      maxLength={4}
                      value={answers.year ?? ''}
                      placeholder="Например, 2027"
                      onChange={(event) => onAnswer('year', event.target.value)}
                    />
                  </Field>
                ) : question.field === 'event_id' ? (
                  <Field label="Мероприятие" field="event_id" error={fields.event_id}>
                    <select
                      {...questionProps(question, index)}
                      value={answers.event_id ?? ''}
                      onChange={(event) => onAnswer('event_id', event.target.value)}
                    >
                      <option value="">Выберите мероприятие</option>
                      {events.map((event) => (
                        <option key={event.id} value={event.id}>
                          {event.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <Field
                    label={question.field === 'date' ? 'Новая дата' : 'Новое время'}
                    field={question.field}
                    error={fields[question.field]}
                  >
                    <input
                      {...questionProps(question, index)}
                      type={question.field}
                      value={answers[question.field] ?? ''}
                      onChange={(event) => onAnswer(question.field, event.target.value)}
                    />
                  </Field>
                )}
              </div>
            ))}
            {actionFeedback('prepare')}
            <div className="transfer-action-row">
              <Button onClick={onContinue} loading={disabled}>
                Продолжить подготовку
              </Button>
              <Button className="secondary" disabled={disabled} onClick={onManual}>
                Изменить данные вручную
              </Button>
            </div>
            <p className="transfer-muted">
              До подтверждения дата мероприятия и отправка писем не изменятся.
            </p>
          </div>
        </>
      )}
      {screen === 'prepared' && (
        <>
          <section className="transfer-summary" aria-labelledby="prepared-event-heading">
            <div className="transfer-section-heading">
              <h2 id="prepared-event-heading">{selected?.title ?? 'Мероприятие'}</h2>
              <EditButton
                label="Изменить мероприятие и дату"
                expanded={eventEditor}
                disabled={disabled}
                onClick={onEventEditor}
              />
            </div>
            {selected && <DateComparison oldStart={selected.starts_at} newStart={proposed} />}
            <YearSourceHint
              state={form.canonicalStart && form.eventId === campaign.event_id ? state : null}
            />
            {eventEditor && <div className="transfer-editor">{eventFields}</div>}
          </section>
          <section className="transfer-letter-section" aria-labelledby="prepared-letter-heading">
            <div className="transfer-section-heading">
              <h2 id="prepared-letter-heading">Уведомление покупателям</h2>
              <EditButton
                label="Изменить уведомление"
                expanded={letterEditor}
                disabled={disabled}
                onClick={onLetterEditor}
              />
            </div>
            <p className="transfer-subject">{form.subject}</p>
            <p className="organizer-letter">{form.body}</p>
            {letterEditor && <div className="transfer-editor">{letterFields}</div>}
          </section>
          {editing && (
            <div className="transfer-stack transfer-spaced">
              {actionFeedback('save')}
              <div className="transfer-action-row">
                <Button onClick={onSave} loading={disabled}>
                  Сохранить подготовку
                </Button>
                <Button
                  className="secondary"
                  disabled={disabled}
                  onClick={() => {
                    if (eventEditor) onEventEditor();
                    if (letterEditor) onLetterEditor();
                  }}
                >
                  Вернуться к проверке
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {screen === 'manual' && (
        <section
          id="saved-manual-panel"
          className="transfer-manual"
          aria-labelledby="saved-manual-title"
        >
          <h2 id="saved-manual-title">Ручная подготовка</h2>
          <p className="transfer-muted">
            Заполните дату и письмо самостоятельно. Перед отправкой останется проверить состав
            переноса.
          </p>
          <div className="transfer-stack">
            {eventFields}
            {letterFields}
            {actionFeedback('save')}
            <Button onClick={onSave} loading={disabled}>
              {pending === 'save' ? 'Сохраняем…' : 'Сохранить подготовку'}
            </Button>
          </div>
        </section>
      )}
      {reviewVisible && (
        <div className="organizer-form-actions">
          <label className="organizer-checkbox">
            <input
              {...props('reviewed')}
              type="checkbox"
              checked={form.reviewed}
              required
              onChange={(event) => onReview(event.target.checked)}
            />
            <span>Текст соответствует мероприятию и новой дате</span>
          </label>
          {fields.reviewed && (
            <p className="field-error" id={`${fieldIds.reviewed}-description`}>
              {fields.reviewed}
            </p>
          )}
          {!(feedbackAction === 'save' && info === 'Подготовка сохранена' && !dirty) && (
            <p className="organizer-save-status">
              {dirty ? 'Есть несохранённые изменения' : 'Подготовка сохранена'}
            </p>
          )}
          {!['prepare', 'rewrite'].includes(feedbackAction ?? '') &&
            !(feedbackAction === 'save' && (screen === 'manual' || editing)) && (
              <>
                {requestError}
                {info && <output className="organizer-info">{info}</output>}
              </>
            )}
          <div className="organizer-actions">
            <Button onClick={onCheck} loading={disabled}>
              {pending === 'preview' ? 'Проверяем…' : 'Проверить перенос'}
            </Button>
          </div>
          <p className="organizer-confirm-help transfer-spaced">
            На следующем экране будет полный список получателей и отдельное подтверждение переноса и
            отправки.
          </p>
        </div>
      )}
      {(screen === 'prepared' || screen === 'clarifications') && (
        <p className="organizer-back">
          <Button className="text" disabled={disabled} onClick={onAssistant}>
            Изменить запрос
          </Button>
        </p>
      )}
    </>
  );
}
