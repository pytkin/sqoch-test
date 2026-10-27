import type { ReactNode, Ref } from 'react';
import type { CampaignDetail } from '../../api/generated/types.gen';
import { Button } from './components';
import { dateLabel, deliveryStatus } from './presentation';
import type { Action } from './types';
import { DateComparison } from './TransferPrimitives';

export function CampaignProgress({
  campaign,
  pending,
  progressError,
  info,
  requestError,
  progressRef,
  onRecover,
}: {
  campaign: CampaignDetail;
  pending: Action | null;
  progressError: string;
  info: string;
  requestError: ReactNode;
  progressRef: Ref<HTMLDivElement>;
  onRecover: (action: 'resume' | 'reconcile') => void;
}) {
  const disabled = pending !== null;
  return (
    <>
      <div
        className="transfer-context organizer-progress"
        aria-live="polite"
        aria-atomic="true"
        tabIndex={-1}
        ref={progressRef}
      >
        <h2>
          Отправлено {campaign.counters.sent} из {campaign.counters.total}
        </h2>
        <p>
          Ожидают: {campaign.counters.pending + campaign.counters.sending} · Повторы:{' '}
          {campaign.counters.retry_wait} · Ошибки: {campaign.counters.failed} · Требуют проверки:{' '}
          {campaign.counters.unknown}
        </p>
        {campaign.counters.unknown > 0 && (
          <p className="field-hint">Проверка сверит письма с Mailpit без повторной отправки.</p>
        )}
        {(campaign.counters.retry_wait > 0 || campaign.counters.unknown > 0) && (
          <div className="transfer-action-row transfer-spaced">
            {campaign.counters.unknown > 0 && (
              <Button
                className="secondary"
                onClick={() => onRecover('reconcile')}
                loading={disabled}
              >
                {pending === 'reconcile' ? 'Проверяем результат…' : 'Проверить результат отправки'}
              </Button>
            )}
            {campaign.counters.retry_wait > 0 && (
              <Button onClick={() => onRecover('resume')} loading={disabled}>
                {pending === 'resume' ? 'Продолжаем…' : 'Продолжить отправку'}
              </Button>
            )}
          </div>
        )}
        {requestError}
        <dl className="transfer-counters">
          <div>
            <dt>Отправлено</dt>
            <dd>{campaign.counters.sent}</dd>
          </div>
          <div>
            <dt>Не отправлено</dt>
            <dd>{campaign.counters.failed}</dd>
          </div>
          <div>
            <dt>Требует проверки</dt>
            <dd>{campaign.counters.unknown}</dd>
          </div>
        </dl>
        {progressError && <p className="organizer-warning">{progressError}</p>}
        {info && <p className="organizer-info">{info}</p>}
      </div>
      {(campaign.counters.unknown > 0 ||
        campaign.counters.retry_wait > 0 ||
        campaign.counters.failed > 0) && (
        <section className="transfer-stack" aria-labelledby="delivery-attention-heading">
          <h2 id="delivery-attention-heading">Что требует внимания</h2>
          <div className={campaign.counters.unknown > 0 ? 'notice warning' : 'transfer-stack'}>
            {campaign.counters.unknown > 0 && (
              <>
                <strong>
                  Для{' '}
                  {campaign.deliveries
                    .filter((item) => item.state === 'unknown')
                    .map((item) => item.email)
                    .join(', ')}{' '}
                  результат неизвестен
                </strong>
                <p>
                  Письма могли быть приняты Mailpit. Сначала проверьте результат, чтобы не отправить
                  их повторно.
                </p>
              </>
            )}
            {campaign.counters.failed > 0 && (
              <p>
                Не отправлено: {campaign.counters.failed}. Причины указаны у адресов ниже.
                Окончательные отказы и исчерпанные попытки не повторяются.
              </p>
            )}
            {campaign.counters.retry_wait > 0 && (
              <p>
                Ожидают повторной попытки: {campaign.counters.retry_wait}. Временные отказы
                повторяются автоматически, всего не более пяти попыток на адрес.
              </p>
            )}
          </div>
        </section>
      )}
      <p className="organizer-context transfer-spaced">
        Можно закрыть эту страницу и вернуться к рассылке позже: состояние и число попыток
        сохраняются.
        {campaign.counters.pending + campaign.counters.sending + campaign.counters.retry_wait > 0 &&
          ' При работающем приложении отправка продолжается в фоне.'}
      </p>
      <p className="organizer-mailpit">
        «Отправлено» означает приём письма локальным Mailpit.{' '}
        <a href="http://127.0.0.1:8025" target="_blank" rel="noreferrer">
          Открыть письма в Mailpit
        </a>{' '}
        · внешняя доставка отключена
      </p>
      <section className="transfer-recipients" aria-labelledby="delivery-results-heading">
        <h2 id="delivery-results-heading">Результат каждого получателя</h2>
        <ul className="organizer-deliveries">
          {campaign.deliveries.map((item) => (
            <li key={item.id}>
              <span className="transfer-delivery-email">{item.email}</span>
              <span
                className={
                  item.state === 'sent'
                    ? 'transfer-success'
                    : item.state === 'failed'
                      ? 'transfer-error'
                      : item.state === 'unknown'
                        ? 'organizer-warning'
                        : undefined
                }
              >
                {deliveryStatus[item.state]}
              </span>
              <p>Попыток: {item.attempts} из 5</p>
              {item.state === 'retry_wait' && item.next_attempt_at && (
                <p className="field-hint">Повтор не раньше {dateLabel(item.next_attempt_at)}</p>
              )}
              {item.state === 'failed' && item.attempts >= 5 ? (
                <p className="field-error">Не отправлено: исчерпан лимит попыток</p>
              ) : (
                item.error_message && (
                  <p className={item.state === 'unknown' ? 'organizer-warning' : 'field-error'}>
                    {item.error_message}
                  </p>
                )
              )}
            </li>
          ))}
        </ul>
      </section>
      <details className="organizer-delivery-help transfer-spaced">
        <summary>Как работают повторы и проверка отправки</summary>
        <p className="organizer-context">
          Временные отказы повторяются автоматически, всего не более пяти попыток на адрес.
          «Продолжить отправку» ускоряет разрешённый повтор. Уже отправленные письма не отправляются
          заново.
        </p>
        <p className="organizer-context">
          Для писем со статусом «Требует проверки» результат неизвестен: они могли быть приняты
          Mailpit. «Проверить результат отправки» сверит письма без повторной отправки. Если
          подтверждения нет, статус останется прежним.
        </p>
        <p className="organizer-context">
          Окончательные отказы и письма с исчерпанным лимитом попыток не повторяются. Причина
          указана у каждого такого адреса выше.
        </p>
      </details>
      <details className="transfer-letter-section">
        <summary>Сохранённый перенос и текст уведомления</summary>
        <div className="transfer-summary transfer-editor">
          <h2>{campaign.event_snapshot!.title}</h2>
          <DateComparison
            oldStart={campaign.event_snapshot!.old_start}
            newStart={campaign.event_snapshot!.new_start}
          />
        </div>
        <p className="transfer-subject">{campaign.subject}</p>
        <p className="organizer-letter">{campaign.body}</p>
      </details>
    </>
  );
}
