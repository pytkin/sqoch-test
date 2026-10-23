import type { Quote } from './api';
import { Button, Icon } from './components';
import type { OrderEditField } from './draft';
import { ageText, money, ticketCount } from './presentation';

export function OrderSummary({
  quote,
  onEdit,
  disabled,
  showTotal = true,
}: {
  quote: Quote;
  onEdit?: (field: OrderEditField) => void;
  disabled?: boolean;
  showTotal?: boolean;
}) {
  return (
    <div className="summary">
      <div className="section-row summary-participants">
        <div className="section-caption">
          <h2>Участники</h2>
          <span>{ticketCount(quote.participants.length)}</span>
        </div>
        <div className="ticket-list">
          {quote.participants.map((p, i) => (
            <div className="ticket" key={i}>
              <div>
                <strong>{p.name}</strong>
                <span>
                  {ageText(p.age)} · {p.ticket_type === 'child' ? 'Детский билет' : 'Полный билет'}
                </span>
              </div>
              <div className="ticket-actions">
                <b>{money(p.price)}</b>
                {onEdit && (
                  <Button
                    variant="text"
                    className="order-edit"
                    disabled={disabled}
                    aria-label={`Изменить участника ${i + 1}`}
                    onClick={() => onEdit(`participants.${i}.name`)}
                  >
                    <Icon name="pencil" />
                    Изменить
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="section-row contact-summary">
        <span className="section-caption">Email для заказа</span>
        <div className="contact-content">
          <strong>{quote.email}</strong>
          {onEdit && (
            <Button
              variant="text"
              className="order-edit"
              disabled={disabled}
              aria-label="Изменить email"
              onClick={() => onEdit('email')}
            >
              <Icon name="pencil" />
              Изменить
            </Button>
          )}
        </div>
      </div>
      {showTotal && (
        <div className="content-column">
          <div className="total">
            <span>Итого</span>
            <strong data-testid="order-total">{money(quote.total)}</strong>
          </div>
        </div>
      )}
    </div>
  );
}
