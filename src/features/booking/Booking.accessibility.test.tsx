import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { mockBookingApi, readyForm } from './test-fixtures';
import type { BookingApiMock } from './test-fixtures';

let api: BookingApiMock;
beforeEach(() => {
  api = mockBookingApi();
});

describe('Понятная обратная связь оформления — test first', () => {
  it('объявляет отказ из-за мест у действия, фокусирует ошибку и не подтверждает при смене radio', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('radio', { name: 'Нет мест' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось оформить заказ: места закончились');
    expect(alert).toHaveTextContent('Заказ не создан');
    expect(alert).toHaveTextContent('на этой странице');
    expect(alert).toHaveTextContent('«Успех»');
    expect(alert).toHaveTextContent('«Повторить подтверждение»');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
    await user.click(screen.getByRole('radio', { name: 'Успех' }));
    expect(alert).toBeVisible();
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Повторить подтверждение' }));
    await screen.findByRole('heading', { name: 'Заказ подтверждён' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ошибка расчёта называет незавершённое действие и сохраняет заполненную форму', async () => {
    const user = await readyForm();
    api.mode = 'network';
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось рассчитать стоимость заказа');
    expect(alert).toHaveTextContent('«Проверить заказ»');
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
    expect(screen.getByLabelText('Email')).toHaveValue('anna@example.com');
  });
});

describe('Подсказка возраста и короткие UI-тексты — test first', () => {
  it('открывает помощь hover, фокусом и кликом, закрывает Escape и вне подсказки', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Оформление билетов' });
    const help = screen.getByRole('button', { name: 'Подсказка к полю «Возраст, лет»' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.getByLabelText('Возраст, лет')).toHaveAccessibleDescription(
      'Укажите число полных лет. Если ребёнку ещё нет года, введите 0',
    );
    await user.hover(help);
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Укажите число полных лет. Если ребёнку ещё нет года, введите 0',
    );
    await user.unhover(help);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.click(screen.getByLabelText('Имя'));
    await user.tab();
    expect(help).toHaveFocus();
    expect(screen.getByRole('tooltip')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(help).toHaveFocus();
    await user.click(help);
    expect(screen.getByRole('tooltip')).toBeVisible();
    await user.unhover(help);
    expect(screen.getByRole('tooltip')).toBeVisible();
    await user.click(help);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.click(help);
    await user.click(screen.getByRole('heading', { name: 'Оформление билетов' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(api.requests).toHaveLength(0);
  });

  it('показывает новое название правил и короткие подписи без конечной точки', async () => {
    const user = await readyForm('13');
    expect(screen.getByText('Правила покупки билетов', { exact: true })).toBeVisible();
    expect(screen.queryByText('Все поля обязательны', { exact: true })).not.toBeInTheDocument();
    expect(
      screen.getByText('Один email для всех участников заказа. В демо письма не отправляются', {
        exact: true,
      }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Добавить участника' })).toHaveAccessibleDescription(
      'В одном заказе может быть от 1 до 4 участников',
    );
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      /^Для ребёнка младше 14 лет нужен сопровождающий от 18 лет в том же заказе\. Нажмите «Добавить участника»/,
    );
  });
});

describe('Эвристический аудит формуляра — test first', () => {
  it('сохраняет текст бренда и текущего шага без запрещённого ARIA-именования', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Оформление билетов' });
    expect(screen.getByText('sqoch.')).not.toHaveAttribute('aria-label');
    const current = screen.getByText('Шаг 1 из 2 · Данные');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(current.closest('p')).not.toHaveAttribute('aria-label');
  });

  it('связывает помощь пустого возраста с полем и заменяет её тарифом или ошибкой', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Оформление билетов' });
    const age = screen.getByLabelText('Возраст, лет');
    expect(age).toHaveAccessibleDescription(
      'Укажите число полных лет. Если ребёнку ещё нет года, введите 0',
    );
    await user.type(age, '13');
    expect(age).toHaveAccessibleDescription(/Детский билет.*1\s000\s₽/);
    await user.clear(age);
    await user.type(age, '-1');
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(age).toHaveAccessibleDescription('Введите возраст в полных годах: целое число от 0');
    expect(age).toHaveAttribute('aria-invalid', 'true');
    expect(api.requests).toHaveLength(0);
  });

  it('показывает объяснение лимита как доступное описание добавления', async () => {
    const user = await readyForm();
    const add = screen.getByRole('button', { name: 'Добавить участника' });
    expect(add).toHaveAccessibleDescription('В одном заказе может быть от 1 до 4 участников');
    for (let index = 0; index < 3; index++) await user.click(add);
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(
      'Достигнут лимит: 4 участника. Чтобы добавить другого человека, сначала удалите одного из списка',
    );
  });

  it('объясняет ручной повтор sold_out рядом с доступным демопереключателем', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    const demo = screen.getByRole('group', { name: 'Сценарий демо' });
    expect(demo).toHaveAccessibleDescription(
      /Сценарий сработает после нажатия «Подтвердить заказ»/,
    );
    await user.click(screen.getByRole('radio', { name: 'Нет мест' }));
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    await screen.findByRole('heading', { name: 'Места закончились' });
    expect(screen.getByRole('alert')).toHaveTextContent('Заказ не создан');
    expect(demo).toHaveAccessibleDescription(/после нажатия «Повторить подтверждение»/);
    expect(within(demo).getByText(/Смена сценария сама по себе не создаёт заказ/)).toBeVisible();
    expect(screen.queryByText('Выберите в демо «Успех» и подтвердите заказ ещё раз.')).toBeNull();
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    await user.click(screen.getByRole('radio', { name: 'Успех' }));
    expect(demo).toHaveAccessibleDescription(/после нажатия «Повторить подтверждение»/);
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Повторить подтверждение' }));
    expect(await screen.findByRole('heading', { name: 'Заказ подтверждён' })).toBeVisible();
  });
});

describe('Срок жизни ошибки и справка — test first', () => {
  it('после sold_out потеря ответа ручного повтора убирает устаревший категоричный отказ', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('radio', { name: 'Нет мест' }));
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    await screen.findByRole('heading', { name: 'Места закончились' });
    api.mode = 'network';
    await user.click(screen.getByRole('button', { name: 'Повторить подтверждение' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Результат подтверждения неизвестен');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
    expect(screen.getByText('anna@example.com')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Места закончились' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Заказ не создан/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Мест нет\./)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
    expect(api.requests.filter((request) => request.path === '/api/orders/quote')).toHaveLength(1);
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: 'Заказ подтверждён' })).not.toBeInTheDocument();
  });

  it('убирает исправленную локальную ошибку сопровождения без запроса, сохраняя серверную ошибку', async () => {
    const user = await readyForm('13');
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    const group = screen.getByRole('group', { name: 'Состав заказа' });
    expect(group).toHaveAccessibleDescription(/Для ребёнка младше 14 лет/);
    const age = screen.getByLabelText('Возраст, лет');
    await user.clear(age);
    await user.type(age, '18');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(group).not.toHaveAttribute('aria-describedby');
    expect(screen.getByRole('button', { name: 'Добавить участника' })).toBeVisible();
    expect(
      screen.getByText('Ребёнку младше 14 лет нужен сопровождающий от 18 лет в том же заказе'),
    ).toBeVisible();
    expect(api.requests).toHaveLength(0);

    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        {
          detail: [
            { loc: ['body', 'participants'], msg: 'invalid composition', type: 'value_error' },
          ],
        },
        { status: 422 },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Сервер не принял состав заказа');
    await user.clear(age);
    await user.type(age, '19');
    expect(screen.getByRole('alert')).toHaveTextContent('Сервер не принял состав заказа');
    expect(group).toHaveAccessibleDescription(/Сервер не принял состав заказа/);
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/orders/quote'),
    ).toHaveLength(1);
  });

  it('открывает правила нативным summary, закрывает Escape и возвращает фокус, сохраняя черновик', async () => {
    const user = await readyForm();
    const trigger = screen.getByText('Правила покупки билетов', { exact: true });
    expect(trigger.tagName).toBe('SUMMARY');
    const disclosure = trigger.closest('details');
    expect(disclosure).not.toHaveAttribute('open');
    await user.click(trigger);
    expect(disclosure).toHaveAttribute('open');
    expect(screen.getByText(/Возраст указывается в полных годах/)).toBeVisible();
    expect(screen.getByText(/Возраст указывается в полных годах/)).toHaveTextContent(
      'Ребёнку младше 14 лет нужен сопровождающий от 18 лет в том же заказе.',
    );
    await user.keyboard('{Escape}');
    expect(disclosure).not.toHaveAttribute('open');
    expect(trigger).toHaveFocus();
    expect(screen.getByText(/Возраст указывается в полных годах/)).not.toBeVisible();
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
    expect(screen.getByLabelText('Возраст, лет')).toHaveValue('18');
    expect(screen.getByLabelText('Email')).toHaveValue('anna@example.com');
    expect(api.requests).toHaveLength(0);
  });
});
