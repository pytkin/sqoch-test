import type { ReactNode, Ref } from 'react';
import type { AssistantState, OrganizerEvent } from '../../api/generated/types.gen';
import { Button } from './components';
import { eventDateParts } from './presentation';

export const assistantIntroduction =
  'Опишите новую дату и время. Помощник подготовит перенос и уведомление, а вы проверите результат перед подтверждением.';
export const assistantYearHint =
  'Год можно не указывать: для будущей даты помощник использует текущий год по Москве, если мероприятие проходит в этом же году. Если дата уже прошла или годы расходятся, понадобится уточнение.';
export const beforeConfirmHint =
  'Дата мероприятия пока не изменится. Письма отправятся только после отдельного подтверждения.';

export function StageHeading({
  eyebrow,
  title,
  introduction,
  titleRef,
  introductionId,
}: {
  eyebrow: string;
  title: string;
  introduction?: ReactNode;
  titleRef?: Ref<HTMLHeadingElement>;
  introductionId?: string;
}) {
  return (
    <div className="checkout-heading">
      <p className="transfer-eyebrow">{eyebrow}</p>
      <h1 ref={titleRef} tabIndex={-1}>
        {title}
      </h1>
      {introduction && <p id={introductionId}>{introduction}</p>}
    </div>
  );
}
export function EventContext({
  event,
  canChoose = false,
}: {
  event: OrganizerEvent;
  canChoose?: boolean;
}) {
  const { date, time } = eventDateParts(event.starts_at);
  return (
    <div className="transfer-context">
      <h2>{event.title}</h2>
      <p>
        Сейчас: {date}, {time} по Москве
      </p>
      {canChoose && <a href="#/organizer">Выбрать другое мероприятие</a>}
    </div>
  );
}
export function DateComparison({
  oldStart,
  newStart,
}: {
  oldStart: string;
  newStart: string | null;
}) {
  const oldDate = eventDateParts(oldStart);
  const newDate = newStart ? eventDateParts(newStart) : null;
  return (
    <dl className="transfer-date-comparison">
      <div>
        <dt>Текущая дата</dt>
        <dd>
          {oldDate.date}
          <span>{oldDate.time} по Москве</span>
        </dd>
      </div>
      <div className="transfer-new-date">
        <dt>Новая дата</dt>
        <dd>
          {newDate ? (
            <>
              {newDate.date}
              <span>{newDate.time} по Москве</span>
            </>
          ) : (
            'Не заполнена'
          )}
        </dd>
      </div>
    </dl>
  );
}
export function EditButton({
  label,
  expanded,
  disabled,
  onClick,
}: {
  label: string;
  expanded: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      className="text"
      aria-label={label}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="button-label">
        <span className="icon icon-pencil" aria-hidden="true" />
        Изменить
      </span>
    </Button>
  );
}
export function YearSourceHint({
  state,
  final = false,
}: {
  state: AssistantState | null;
  final?: boolean;
}) {
  if (!state?.year_source || !state.partial_date.year) return null;
  const year = state.partial_date.year;
  const text =
    state.year_source === 'current_year'
      ? `Год ${year} выбран по текущей дате в Москве.`
      : state.year_source === 'explicit'
        ? `Год ${year} явно указан в запросе.`
        : state.year_source === 'clarification'
          ? `Год ${year} указан вами при уточнении.`
          : `Год ${year} указан вручную.`;
  return (
    <p className="field-hint transfer-spaced">
      {text}
      {!final && ' До подтверждения его можно изменить.'}
    </p>
  );
}
