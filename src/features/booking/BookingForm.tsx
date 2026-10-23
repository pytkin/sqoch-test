import { Fragment } from 'react';
import type { FormEventHandler, ReactNode, Ref } from 'react';
import type { FieldArrayWithId, FieldErrors, UseFormRegister } from 'react-hook-form';
import type { Draft, Event } from './api';
import { Button, Field, Icon, Notice } from './components';
import type { RemovedParticipant } from './draft';
import { ageError, ageHelp, emailError, nameError, validAge } from './draft';
import { money } from './presentation';

type BookingFormProps = {
  event: Event;
  pending: boolean;
  fields: FieldArrayWithId<Draft, 'participants'>[];
  people: Draft['participants'];
  errors: FieldErrors<Draft>;
  register: UseFormRegister<Draft>;
  participantsRef: Ref<HTMLFieldSetElement>;
  needsCompanion: boolean;
  removed: RemovedParticipant | null;
  requestError?: ReactNode;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onAddParticipant: () => void;
  onRemoveParticipant: (index: number) => void;
  onUndoRemoval: () => void;
};

export function BookingForm({
  event,
  pending,
  fields,
  people,
  errors,
  register,
  participantsRef,
  needsCompanion,
  removed,
  requestError,
  onSubmit,
  onAddParticipant,
  onRemoveParticipant,
  onUndoRemoval,
}: BookingFormProps) {
  const undoNotice = removed && (
    <Notice kind="info" className="undo-notice">
      <p>Участник{removed.person.name.trim() ? ` «${removed.person.name.trim()}»` : ''} удалён</p>
      <Button variant="text" onClick={onUndoRemoval} aria-label="Вернуть участника">
        Вернуть участника
      </Button>
    </Notice>
  );
  return (
    <form noValidate aria-describedby="form-instructions" onSubmit={onSubmit}>
      <fieldset className="form-content" disabled={pending}>
        <legend className="sr-only">Данные заказа</legend>
        <div className="section-row participants-section">
          <div className="section-label section-caption">
            <h2>Участники</h2>
            <span>
              {fields.length} из {event.max_participants}
            </span>
          </div>
          <fieldset
            className="participants-list"
            ref={participantsRef}
            tabIndex={-1}
            aria-describedby={errors.root?.participants ? 'participants-error' : undefined}
          >
            <legend className="sr-only">Состав заказа</legend>
            {errors.root?.participants && (
              <Notice kind="error" id="participants-error">
                {errors.root.participants.message}
              </Notice>
            )}
            {fields.map((field, index) => {
              const age = validAge(people[index]?.age ?? '');
              const tariff =
                age === null
                  ? undefined
                  : `${age < event.child_age_limit ? 'Детский билет' : 'Полный билет'} · ${money(age < event.child_age_limit ? event.child_ticket_price : event.full_ticket_price)}`;
              return (
                <Fragment key={field.id}>
                  {removed?.index === index && undoNotice}
                  <fieldset className="participant" aria-labelledby={`participant-${field.id}`}>
                    <legend>
                      <span className="participant-heading">
                        <span id={`participant-${field.id}`}>Участник {index + 1}</span>
                        {fields.length > 1 && (
                          <Button
                            variant="destructive"
                            onClick={() => onRemoveParticipant(index)}
                            aria-label={`Удалить участника ${index + 1}`}
                            title={`Удалить участника ${index + 1}`}
                            className="icon-button"
                          >
                            <Icon name="trash-2" />
                          </Button>
                        )}
                      </span>
                    </legend>
                    <div className="participant-fields">
                      <Field
                        id={`name-${field.id}`}
                        label="Имя"
                        required
                        autoComplete="off"
                        placeholder="Например, Анна"
                        error={errors.participants?.[index]?.name?.message}
                        {...register(`participants.${index}.name`, {
                          validate: (value) => value.trim().length > 0 || nameError,
                        })}
                      />
                      <Field
                        id={`age-${field.id}`}
                        label="Возраст, лет"
                        labelHelp={ageHelp}
                        required
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        aria-describedby={
                          !errors.participants?.[index]?.age && tariff
                            ? `tariff-${field.id}`
                            : undefined
                        }
                        error={errors.participants?.[index]?.age?.message}
                        {...register(`participants.${index}.age`, {
                          validate: (value) => validAge(value) !== null || ageError,
                        })}
                      />
                    </div>
                    <div className="participant-status">
                      {!errors.participants?.[index]?.age && tariff && (
                        <p className="participant-tariff" id={`tariff-${field.id}`}>
                          {tariff}
                        </p>
                      )}
                    </div>
                  </fieldset>
                </Fragment>
              );
            })}
            {removed && removed.index >= fields.length && undoNotice}
            <Button
              variant="text"
              className="add-button"
              onClick={onAddParticipant}
              disabled={fields.length >= event.max_participants}
              aria-describedby="participant-limit"
            >
              <Icon name="plus" />
              Добавить участника
            </Button>
            <p
              id="participant-limit"
              className={fields.length < event.max_participants ? 'sr-only' : 'field-hint'}
            >
              {fields.length >= event.max_participants
                ? `Достигнут лимит — ${event.max_participants} участника. Чтобы добавить другого человека, сначала удалите одного из списка`
                : `В одном заказе может быть от 1 до ${event.max_participants} участников`}
            </p>
            <p className="companion-hint">
              Ребёнку младше {event.child_age_limit} лет нужен сопровождающий от{' '}
              {event.companion_min_age} лет в том же заказе
            </p>
            {fields.length >= event.max_participants && needsCompanion && (
              <p className="field-hint">
                В заказе уже {event.max_participants} участника. Измените состав, чтобы с ребёнком
                был сопровождающий от {event.companion_min_age} лет
              </p>
            )}
          </fieldset>
        </div>
        <div className="section-row email-section">
          <Field
            id="email"
            label="Email"
            required
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            error={errors.email?.message}
            hint="Один email для всех участников заказа. В демо письма не отправляются"
            {...register('email', {
              validate: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) || emailError,
            })}
          />
        </div>
      </fieldset>
      <div className="content-column form-action">
        {requestError}
        <Button
          className="form-submit"
          type="submit"
          loading={pending}
          loadingLabel="Рассчитываем стоимость…"
        >
          Проверить заказ
        </Button>
      </div>
    </form>
  );
}
