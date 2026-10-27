import type { ReactNode } from 'react';
import type { AssistantState, CampaignPreview as Preview } from '../../api/generated/types.gen';
import { Button } from './components';
import { recipientCountLabel } from './presentation';
import { DateComparison, YearSourceHint } from './TransferPrimitives';
import type { Action } from './types';

export function CampaignPreview({
  preview,
  pending,
  needsRefresh,
  uncertainConfirm,
  requestError,
  onRefresh,
  onConfirm,
  onEdit,
  assistantState = null,
}: {
  preview: Preview;
  pending: Action | null;
  needsRefresh: boolean;
  uncertainConfirm: boolean;
  requestError: ReactNode;
  onRefresh: () => void;
  onConfirm: () => void;
  onEdit: () => void;
  assistantState?: AssistantState | null;
}) {
  const disabled = pending !== null;
  return (
    <>
      <section className="transfer-summary" aria-labelledby="preview-event-heading">
        <h2 id="preview-event-heading">{preview.event.title}</h2>
        <DateComparison oldStart={preview.old_start} newStart={preview.proposed_start} />
        <YearSourceHint state={assistantState} />
      </section>
      <section className="transfer-letter-section" aria-labelledby="preview-letter-heading">
        <h2 id="preview-letter-heading">Уведомление покупателям</h2>
        <p className="transfer-subject">{preview.subject}</p>
        <p className="organizer-letter">{preview.body}</p>
      </section>
      <section className="transfer-recipients" aria-labelledby="preview-recipients-heading">
        <h2 id="preview-recipients-heading">
          Получатели: {recipientCountLabel(preview.recipients.length)}
        </h2>
        <p className="transfer-muted">
          По одному уведомлению на email с действующей покупкой этого мероприятия. Повторные покупки
          объединены, отменённые покупки не добавляют получателей.
        </p>
        <ul className="organizer-recipients">
          {preview.recipients.map((email) => (
            <li key={email}>{email}</li>
          ))}
        </ul>
      </section>
      <div className="organizer-confirm">
        {requestError}
        {!needsRefresh && !uncertainConfirm && (
          <p className="organizer-confirm-help">
            Подтверждение изменит дату мероприятия и начнёт отправку этого письма указанным
            покупателям. После подтверждения этот перенос в демо нельзя изменить или отменить. Для
            другой даты понадобится новый перенос. До подтверждения вы можете вернуться к
            редактированию.
          </p>
        )}
        <div className="transfer-action-row transfer-spaced">
          {needsRefresh || uncertainConfirm ? (
            <Button onClick={onRefresh} loading={disabled}>
              {uncertainConfirm ? 'Проверить состояние' : 'Обновить сведения'}
            </Button>
          ) : (
            <Button onClick={onConfirm} loading={disabled}>
              {pending === 'confirm'
                ? 'Подтверждаем…'
                : 'Подтвердить перенос и уведомить покупателей'}
            </Button>
          )}
          <Button className="secondary" disabled={disabled} onClick={onEdit}>
            Вернуться к редактированию
          </Button>
        </div>
      </div>
    </>
  );
}
