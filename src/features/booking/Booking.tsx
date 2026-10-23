import { useEffect, useRef, useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { ApiError, confirmOrder, errorMessage, getEvent, getQuote } from './api';
import type { ConfirmedOrder, Draft, Event, Quote, Scenario } from './api';
import { Button, HelpTip, Icon, Notice, StepIndicator } from './components';
import { BookingForm } from './BookingForm';
import { DemoControl } from './DemoControl';
import type { DraftField, OrderEditField, RemovedParticipant } from './draft';
import { ageError, emailError, emptyDraft, nameError, validAge } from './draft';
import { OrderSummary } from './OrderSummary';
import { money, ticketCount } from './presentation';

type Step = 'data' | 'review' | 'success' | 'sold_out';
type FocusIntent = { field: DraftField } | { region: 'title' | 'participants' | 'error' };

export default function Booking() {
  const [event, setEvent] = useState<Event | null>(null);
  const [eventError, setEventError] = useState('');
  const [eventAttempt, setEventAttempt] = useState(0);
  const [step, setStep] = useState<Step>('data');
  const [scenario, setScenario] = useState<Scenario>('success');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<ConfirmedOrder | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [removed, setRemoved] = useState<RemovedParticipant | null>(null);
  const [focusIntent, setFocusIntent] = useState<FocusIntent | null>(null);
  const consumedFocus = useRef<FocusIntent | null>(null);
  const requestInFlight = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const participantsRef = useRef<HTMLFieldSetElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const eventRetryRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const {
    register,
    control,
    handleSubmit,
    getValues,
    reset,
    setFocus,
    setError: setFieldError,
    clearErrors,
    formState: { errors },
  } = useForm<Draft>({
    defaultValues: emptyDraft(),
    shouldUnregister: false,
    shouldFocusError: false,
  });
  const { fields, append, remove, insert } = useFieldArray({ control, name: 'participants' });
  const people = useWatch({ control, name: 'participants' });
  const needsCompanion =
    !!event &&
    people.some((p) => validAge(p.age) !== null && Number(p.age) < event.child_age_limit) &&
    !people.some((p) => validAge(p.age) !== null && Number(p.age) >= event.companion_min_age);
  useEffect(() => {
    const abort = new AbortController();
    getEvent(abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        setEvent(value);
        if (eventAttempt > 0) setFocusIntent({ region: 'title' });
      })
      .catch((e) => {
        if (!abort.signal.aborted) setEventError(errorMessage(e, 'event'));
      });
    return () => abort.abort();
  }, [eventAttempt]);
  useEffect(() => {
    if (eventError && eventAttempt > 0) eventRetryRef.current?.focus();
  }, [eventError, eventAttempt]);
  useEffect(() => () => activeRequest.current?.abort(), []);
  useEffect(() => {
    if (step === 'data' && errors.root?.participants?.type === 'validate' && !needsCompanion) {
      clearErrors('root.participants');
    }
  }, [step, errors.root?.participants?.type, needsCompanion, clearErrors]);
  useEffect(() => {
    if (pending || !event || !focusIntent || consumedFocus.current === focusIntent) return;
    consumedFocus.current = focusIntent;
    if ('field' in focusIntent) setFocus(focusIntent.field);
    else if (focusIntent.region === 'title') titleRef.current?.focus();
    else if (focusIntent.region === 'participants') participantsRef.current?.focus();
    else {
      errorRef.current?.focus();
      errorRef.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [focusIntent, pending, event, step, setFocus]);
  function reportFailure(failure: unknown, operation: 'quote' | 'confirm') {
    if (operation === 'confirm') setStep('review');
    setError(errorMessage(failure, operation));
    let intent: FocusIntent = { region: 'error' };
    if (failure instanceof ApiError && failure.kind === 'validation') {
      setQuote(null);
      setStep('data');
      let found = false;
      for (const issue of failure.issues) {
        const [origin, field, index, property] = issue.loc;
        if (origin !== 'body') continue;
        if (field === 'email') {
          setFieldError('email', { type: 'server', message: emailError });
          if (!found) {
            intent = { field: 'email' };
            found = true;
          }
        }
        if (field === 'participants') {
          if (
            typeof index === 'number' &&
            index >= 0 &&
            index < getValues('participants').length &&
            (property === 'name' || property === 'age')
          ) {
            const name = `participants.${index}.${property}` as const;
            setFieldError(name, {
              type: 'server',
              message: property === 'name' ? nameError : ageError,
            });
            if (!found) {
              intent = { field: name };
              found = true;
            }
          } else {
            setFieldError('root.participants', {
              type: 'server',
              message:
                'Сервер не принял состав заказа. В заказе должно быть от 1 до 4 участников, а ребёнку младше 14 лет нужен сопровождающий от 18 лет в том же заказе. Проверьте список и повторите расчёт.',
            });
            if (!found) {
              intent = { region: 'participants' };
              found = true;
            }
          }
        }
      }
      if (
        found &&
        failure.issues.every((issue) => {
          const [origin, field] = issue.loc;
          return origin === 'body' && (field === 'email' || field === 'participants');
        })
      )
        setError('');
    }
    setFocusIntent(intent);
  }
  function addParticipant() {
    if (pending || !event || fields.length >= event.max_participants) return;
    setRemoved(null);
    append({ name: '', age: '' }, { shouldFocus: false });
    clearErrors('root.participants');
    setFocusIntent({ field: `participants.${fields.length}.name` });
  }
  function removeParticipant(index: number) {
    const people = getValues('participants');
    if (pending || people.length <= 1) return;
    const person = { ...people[index]! };
    setRemoved(person.name.trim() || person.age !== '' ? { index, person } : null);
    remove(index);
    clearErrors('root.participants');
    setFocusIntent({ field: `participants.${Math.min(index, people.length - 2)}.name` });
  }
  function undoRemoval() {
    if (!removed || pending || !event || fields.length >= event.max_participants) return;
    insert(removed.index, removed.person, { shouldFocus: false });
    setFocusIntent({ field: `participants.${removed.index}.name` });
    setRemoved(null);
    clearErrors('root.participants');
  }
  function edit(field: OrderEditField) {
    clearErrors();
    setQuote(null);
    setError('');
    setStep('data');
    setFocusIntent({ field });
  }
  async function calculate(draft: Draft) {
    if (!event || requestInFlight.current) return;
    setError('');
    if (
      draft.participants.some((p) => Number(p.age) < event.child_age_limit) &&
      !draft.participants.some((p) => Number(p.age) >= event.companion_min_age)
    ) {
      setFieldError('root.participants', {
        type: 'validate',
        message:
          draft.participants.length >= event.max_participants
            ? 'Для ребёнка младше 14 лет нужен сопровождающий от 18 лет в том же заказе. Лимит участников уже достигнут — измените состав заказа, чтобы в нём был сопровождающий.'
            : 'Для ребёнка младше 14 лет нужен сопровождающий от 18 лет в том же заказе. Нажмите «Добавить участника» и укажите данные сопровождающего.',
      });
      setFocusIntent({ region: 'participants' });
      return;
    }
    const abort = new AbortController();
    activeRequest.current = abort;
    requestInFlight.current = true;
    setPending(true);
    try {
      const result = await getQuote(draft, abort.signal);
      if (abort.signal.aborted) return;
      setQuote(result);
      setRemoved(null);
      setStep('review');
      setFocusIntent({ region: 'title' });
    } catch (e) {
      if (!abort.signal.aborted) reportFailure(e, 'quote');
    } finally {
      requestInFlight.current = false;
      if (!abort.signal.aborted) {
        activeRequest.current = null;
        setPending(false);
      }
    }
  }
  async function confirm() {
    if (requestInFlight.current || !quote) return;
    const abort = new AbortController();
    activeRequest.current = abort;
    requestInFlight.current = true;
    setPending(true);
    setError('');
    try {
      const result = await confirmOrder(getValues(), scenario, abort.signal);
      if (abort.signal.aborted) return;
      setOrder(result);
      setStep('success');
      setFocusIntent({ region: 'title' });
    } catch (e) {
      if (!abort.signal.aborted) {
        if (e instanceof ApiError && e.kind === 'sold_out') {
          setStep('sold_out');
          setError(errorMessage(e, 'confirm'));
          setFocusIntent({ region: 'error' });
        } else reportFailure(e, 'confirm');
      }
    } finally {
      requestInFlight.current = false;
      if (!abort.signal.aborted) {
        activeRequest.current = null;
        setPending(false);
      }
    }
  }
  const stageIndex = step === 'data' ? 0 : step === 'review' ? 1 : 2;
  const requestError = error && (
    <Notice kind="error" className="action-error" ref={errorRef} tabIndex={-1}>
      {error}
    </Notice>
  );

  return (
    <div className="page">
      <header className="site-header">
        <span className="brand">sqoch.</span>
        <StepIndicator current={stageIndex} />
      </header>
      <main className="layout">
        <section className="checkout" aria-label="Оформление заказа">
          {!event && (
            <div className="status-panel">
              {eventError ? (
                <>
                  <Notice kind="error" id="event-error">
                    {eventError}
                  </Notice>
                  <Button
                    ref={eventRetryRef}
                    aria-describedby="event-error"
                    onClick={() => {
                      setEventError('');
                      setEventAttempt((n) => n + 1);
                    }}
                  >
                    Повторить загрузку
                  </Button>
                </>
              ) : (
                <output>Загружаем данные мероприятия…</output>
              )}
            </div>
          )}
          {event && (
            <>
              <div className="checkout-heading">
                <h1 ref={titleRef} tabIndex={-1}>
                  {step === 'data'
                    ? 'Оформление билетов'
                    : step === 'review'
                      ? 'Проверьте заказ'
                      : step === 'success'
                        ? 'Заказ подтверждён'
                        : 'Места закончились'}
                </h1>
                {step === 'review' && (
                  <p>
                    Проверьте участников, email и итоговую сумму. Для исправления данных нажмите
                    «Изменить» рядом с нужной записью.
                  </p>
                )}
                {step === 'success' && (
                  <p>
                    Данные и номер заказа доступны только на этой странице — после её обновления они
                    исчезнут
                  </p>
                )}
                <p className="event-name">{event.title}</p>
              </div>
              {step === 'data' && (
                <div className="event-context section-row">
                  <span className="section-caption">Билеты</span>
                  <div className="rules-content">
                    <span className="event-tariffs">
                      От {event.child_age_limit} лет — {money(event.full_ticket_price)} · Младше{' '}
                      {event.child_age_limit} лет — {money(event.child_ticket_price)}
                    </span>
                    <HelpTip label="Правила покупки билетов">
                      <p>
                        В одном заказе может быть от 1 до {event.max_participants} участников.
                        Укажите имя и возраст каждого участника и один email для всего заказа.
                        Возраст указывается в полных годах; если ребёнку ещё нет года, укажите 0.
                        Ребёнку младше {event.child_age_limit} лет нужен сопровождающий от{' '}
                        {event.companion_min_age} лет в том же заказе. Участник 14–17 лет может идти
                        отдельно, но не считается сопровождающим. Одного сопровождающего достаточно
                        для нескольких детей.
                      </p>
                    </HelpTip>
                  </div>
                </div>
              )}
              {step === 'data' && (
                <p className="form-instructions content-column" id="form-instructions">
                  Все поля обязательны
                </p>
              )}
              {step === 'data' && (
                <BookingForm
                  event={event}
                  pending={pending}
                  fields={fields}
                  people={people}
                  errors={errors}
                  register={register}
                  participantsRef={participantsRef}
                  needsCompanion={needsCompanion}
                  removed={removed}
                  requestError={requestError}
                  onAddParticipant={addParticipant}
                  onRemoveParticipant={removeParticipant}
                  onUndoRemoval={undoRemoval}
                  onSubmit={(e) => {
                    clearErrors('root.participants');
                    void handleSubmit(calculate, (invalid) => {
                      const people = getValues('participants');
                      for (let index = 0; index < people.length; index++) {
                        if (invalid.participants?.[index]?.name) {
                          setFocus(`participants.${index}.name`);
                          return;
                        }
                        if (invalid.participants?.[index]?.age) {
                          setFocus(`participants.${index}.age`);
                          return;
                        }
                      }
                      if (invalid.email) setFocus('email');
                    })(e);
                  }}
                />
              )}
              {(step === 'review' || step === 'sold_out') && quote && (
                <>
                  <OrderSummary quote={quote} onEdit={edit} disabled={pending} />
                  <div className="actions content-column">
                    <DemoControl
                      scenario={scenario}
                      onChange={setScenario}
                      disabled={pending}
                      retry={step === 'sold_out'}
                    />
                    {requestError}
                    <Button loading={pending} loadingLabel="Подтверждаем заказ…" onClick={confirm}>
                      {step === 'sold_out' ? 'Повторить подтверждение' : 'Подтвердить заказ'}
                    </Button>
                  </div>
                </>
              )}
              {step === 'success' && order && (
                <>
                  <Notice kind="success" className="success-summary content-column">
                    <Icon name="check" />
                    <span>
                      {ticketCount(order.participants.length)} ·{' '}
                      <strong data-testid="order-total">{money(order.total)}</strong>
                    </span>
                  </Notice>
                  <OrderSummary quote={order} showTotal={false} />
                  <p className="order-number content-column">
                    Номер заказа <strong>{order.order_id}</strong>
                  </p>
                  <Button
                    variant="secondary"
                    className="result-action content-column"
                    onClick={() => {
                      reset(emptyDraft());
                      setOrder(null);
                      setQuote(null);
                      setError('');
                      setStep('data');
                      setRemoved(null);
                      setFocusIntent({ region: 'title' });
                    }}
                  >
                    Оформить новый заказ
                  </Button>
                </>
              )}
              {pending && (
                <output className="sr-only">
                  {step === 'data' ? 'Рассчитываем стоимость' : 'Подтверждаем заказ'}
                </output>
              )}
            </>
          )}
        </section>
      </main>
      <footer className="site-footer">
        <span>Sqoch · тестовый проект</span>
        <span>Без оплаты и отправки писем</span>
      </footer>
    </div>
  );
}
