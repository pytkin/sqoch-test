import type { CampaignSummary } from '../../api/generated/types.gen';
import { Button } from './components';
import { campaignStatus, dateLabel } from './presentation';
import type { Action } from './types';

export function CampaignList({
  items,
  pending,
  creationAttempted,
  hasError,
  onCreate,
}: {
  items: CampaignSummary[];
  pending: Action | null;
  creationAttempted: boolean;
  hasError: boolean;
  onCreate: () => void;
}) {
  const disabled = pending !== null;
  return (
    <>
      <Button onClick={onCreate} loading={disabled}>
        {pending === 'create'
          ? 'Создаём черновик…'
          : creationAttempted && hasError
            ? 'Повторить создание'
            : 'Создать рассылку'}
      </Button>
      {items.length === 0 ? (
        <div className="organizer-empty">
          <p>Сохранённых рассылок пока нет</p>
          <p>
            Создайте черновик уведомления о переносе. Вы сможете подготовить текст с помощником или
            вручную, проверить дату и получателей. До отдельного подтверждения дата мероприятия не
            изменится и письма не отправятся.
          </p>
        </div>
      ) : (
        <ul className="organizer-campaigns">
          {items.map((item) => (
            <li key={item.id}>
              <a href={`#/organizer/campaigns/${item.id}`}>
                <strong>{item.subject || 'Черновик без темы'}</strong>
                <span>{item.event_title || 'Мероприятие не выбрано'}</span>
              </a>
              <span>
                {item.proposed_start
                  ? `Новая дата: ${dateLabel(item.proposed_start)}`
                  : 'Новая дата не указана'}
              </span>
              <span>{campaignStatus[item.status]}</span>
              {item.phase === 'confirmed' && (
                <span>
                  Отправлено {item.counters.sent} из {item.counters.total}
                </span>
              )}
              <span>Создана: {dateLabel(item.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
