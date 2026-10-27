import { useEffect, useRef, useState } from 'react';
import type { CampaignSummary, OrganizerEvent } from '../../api/generated/types.gen';
import { AppHeader } from '../../components/AppHeader';
import { errorMessage, getEvents, listCampaigns } from './api';
import { Button } from './components';
import { campaignStatus, dateLabel, metadataDateLabel } from './presentation';
import { StageHeading } from './TransferPrimitives';

export const eventRoute = (id: string) => `#/organizer/events/${encodeURIComponent(id)}`;

function PreparationList({ items }: { items: CampaignSummary[] }) {
  return (
    <ul className="organizer-campaigns">
      {items.map((item) => (
        <li key={item.id}>
          <a href={`#/organizer/campaigns/${item.id}`}>
            <strong>{item.subject || 'Продолжить подготовку переноса'}</strong>
          </a>
          {item.proposed_start && <span>Новая дата: {dateLabel(item.proposed_start)}</span>}
          <span>
            {item.preparation_stage === 'needs_input'
              ? 'Нужно уточнить сведения'
              : 'Подготовка не завершена'}
          </span>
          <span>Изменена: {metadataDateLabel(item.updated_at)}</span>
        </li>
      ))}
    </ul>
  );
}

function History({ items }: { items: CampaignSummary[] }) {
  return (
    <section aria-labelledby="event-history-heading" className="event-section">
      <h2 id="event-history-heading">История переносов</h2>
      {items.length === 0 ? (
        <p>Подтверждённых переносов пока нет</p>
      ) : (
        <ul className="organizer-campaigns">
          {items.map((item) => (
            <li key={item.id}>
              <a href={`#/organizer/campaigns/${item.id}`}>
                <strong>{item.subject}</strong>
              </a>
              {item.event_snapshot && (
                <>
                  <span>Было: {dateLabel(item.event_snapshot.old_start)}</span>
                  <span>Перенесено на: {dateLabel(item.event_snapshot.new_start)}</span>
                </>
              )}
              <span>{campaignStatus[item.status]}</span>
              <span>
                Отправлено {item.counters.sent} из {item.counters.total}
              </span>
              {item.counters.unknown > 0 && (
                <span className="organizer-warning">
                  Результат отправки требует проверки: {item.counters.unknown}. Повторная отправка
                  этих писем не выполняется.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventOverview({ events, items }: { events: OrganizerEvent[]; items: CampaignSummary[] }) {
  const unassigned = items.filter(
    (item) => item.phase === 'draft' && item.has_content && item.event_id === null,
  );
  return (
    <>
      <p className="organizer-actions">
        <a className="button primary" href="#/organizer/transfer">
          Подготовить перенос
        </a>
      </p>
      {events.length === 0 ? (
        <p className="organizer-empty">Мероприятий пока нет</p>
      ) : (
        <ul className="organizer-campaigns transfer-events">
          {events.map((event) => {
            const related = items.filter((item) => item.event_id === event.id);
            const preparations = related.filter(
              (item) => item.phase === 'draft' && item.has_content,
            );
            const attention = related.find(
              (item) =>
                item.phase === 'confirmed' &&
                (item.status === 'processing' || item.status === 'needs_attention'),
            );
            const latest = related.find((item) => item.phase === 'confirmed');
            return (
              <li key={event.id}>
                <h2>
                  <a href={eventRoute(event.id)}>{event.title}</a>
                </h2>
                <p>Текущее начало: {dateLabel(event.starts_at)}</p>
                {preparations.length > 0 && <p>Незавершённых подготовок: {preparations.length}</p>}
                {latest && <p>Последнее уведомление: {campaignStatus[latest.status]}</p>}
                <div className="organizer-actions">
                  {attention ? (
                    <a className="button secondary" href={`#/organizer/campaigns/${attention.id}`}>
                      {attention.counters.unknown > 0 ? 'Проверить отправку' : 'Открыть отправку'}
                      <span className="sr-only">: {event.title}</span>
                    </a>
                  ) : preparations.length === 1 ? (
                    <a
                      className="button secondary"
                      href={`#/organizer/campaigns/${preparations[0]!.id}`}
                    >
                      Продолжить подготовку<span className="sr-only">: {event.title}</span>
                    </a>
                  ) : (
                    <a
                      className="button secondary"
                      href={
                        preparations.length > 1
                          ? eventRoute(event.id)
                          : latest
                            ? `#/organizer/campaigns/${latest.id}`
                            : `${eventRoute(event.id)}/transfer`
                      }
                    >
                      {preparations.length > 1
                        ? 'Открыть подготовки'
                        : latest
                          ? 'Открыть результат'
                          : 'Перенести'}
                      <span className="sr-only">: {event.title}</span>
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {unassigned.length > 0 && (
        <section aria-labelledby="unassigned-heading" className="event-section">
          <h2 id="unassigned-heading">Подготовки без мероприятия</h2>
          <PreparationList items={unassigned} />
        </section>
      )}
    </>
  );
}

export function Events({ eventId }: { eventId: string | null }) {
  const [data, setData] = useState<{ events: OrganizerEvent[]; items: CampaignSummary[] } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const event = data?.events.find((item) => item.id === eventId);
  const title =
    eventId === null
      ? 'Мероприятия'
      : (event?.title ?? (loading || error ? 'Мероприятие' : 'Мероприятие не найдено'));
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Sqoch`;
    return () => {
      document.title = previous;
    };
  }, [title]);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getEvents(controller.signal), listCampaigns(controller.signal)])
      .then(([events, campaigns]) => {
        if (!controller.signal.aborted) setData({ events: events.items, items: campaigns.items });
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(errorMessage(failure, 'Не удалось загрузить данные кабинета'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [eventId, attempt]);
  useEffect(() => {
    if (attempt > 0 && !loading) (error ? retryRef.current : titleRef.current)?.focus();
  }, [attempt, loading, error]);
  const related = data?.items.filter((item) => item.event_id === eventId) ?? [];
  const drafts = related.filter((item) => item.phase === 'draft' && item.has_content);
  return (
    <div className="page">
      <AppHeader section="organizer" />
      <main className="layout organizer">
        <StageHeading
          eyebrow="Кабинет организатора"
          title={title}
          titleRef={titleRef}
          introduction={
            eventId === null
              ? 'Расписание и уведомления покупателям. Откройте мероприятие, чтобы подготовить перенос или проверить результат отправки.'
              : 'Текущее расписание, подготовки и результаты уведомления покупателей'
          }
        />
        {loading ? (
          <output>Загружаем данные…</output>
        ) : error ? (
          <>
            <div id="events-load-error" className="notice error" role="alert">
              {error}
            </div>
            <Button
              ref={retryRef}
              aria-describedby="events-load-error"
              onClick={() => {
                setLoading(true);
                setError('');
                setAttempt((value) => value + 1);
              }}
            >
              Повторить загрузку
            </Button>
          </>
        ) : eventId === null && data ? (
          <EventOverview events={data.events} items={data.items} />
        ) : event ? (
          <>
            <p>Текущее начало: {dateLabel(event.starts_at)}</p>
            <p className="organizer-actions">
              <a className="button primary" href={`${eventRoute(event.id)}/transfer`}>
                Перенести мероприятие
              </a>
            </p>
            {drafts.length > 0 && (
              <section aria-labelledby="preparations-heading" className="event-section">
                <h2 id="preparations-heading">Незавершённые подготовки</h2>
                <PreparationList items={drafts} />
              </section>
            )}
            <History items={related.filter((item) => item.phase === 'confirmed')} />
          </>
        ) : (
          <p>Проверьте ссылку или выберите мероприятие в обзоре</p>
        )}
        {eventId !== null && (
          <p className="organizer-back">
            <a href="#/organizer">К мероприятиям</a>
          </p>
        )}
      </main>
      <footer className="site-footer">
        <span>Sqoch · кабинет организатора</span>
        <span>Локальная отправка в Mailpit</span>
      </footer>
    </div>
  );
}
