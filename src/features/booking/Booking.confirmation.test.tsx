import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockBookingApi, event, fillPerson, readyForm } from './test-fixtures';
import type { BookingApiMock } from './test-fixtures';

let api: BookingApiMock;
beforeEach(() => {
  api = mockBookingApi();
});

describe('Редактирование и подтверждение — test first', () => {
  it('сохраняет черновик, отменяет старую сумму и повторно запрашивает расчёт', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('button', { name: 'Изменить участника 1' }));
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
    expect(screen.queryByTestId('order-total')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    await fillPerson(user, 'Лев', '13', 1);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    expect(screen.getByTestId('order-total')).toHaveTextContent('3 000');
    expect(api.requests.filter((r) => r.path === '/api/orders/quote')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Изменить участника 1' }));
    await user.click(screen.getByRole('button', { name: 'Удалить участника 1' }));
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(screen.getByRole('alert')).toHaveTextContent('нужен сопровождающий от 18');
  });
  it('показывает успешный заказ и сумму ответа confirm', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    expect(await screen.findByRole('heading', { name: 'Заказ подтверждён' })).toBeVisible();
    expect(screen.getByText('demo-123')).toBeVisible();
    expect(api.requests[1]!.scenario).toBe('success');
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
  });
  it('демопереключатель виден на проверке, влияет только на confirm и сохраняет выбор после редактирования', async () => {
    const user = await readyForm();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    expect(api.requests[0]!.scenario).toBeNull();
    expect(screen.getByRole('radio', { name: 'Успех' })).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'Нет мест' }));
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    expect(await screen.findByRole('heading', { name: 'Места закончились' })).toBeVisible();
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
    await user.click(screen.getByRole('button', { name: 'Изменить участника 1' }));
    expect(screen.getByLabelText('Email')).toHaveValue('anna@example.com');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    expect(screen.getByRole('radio', { name: 'Нет мест' })).toBeChecked();
    expect(
      api.requests
        .filter((request) => request.path.endsWith('/quote'))
        .map((request) => request.scenario),
    ).toEqual([null, null]);
  });
  it('сеть на расчёте сохраняет форму и даёт повторить запрос', async () => {
    const user = await readyForm();
    api.mode = 'network';
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось связаться с сервером');
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
    api.mode = 'success';
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(await screen.findByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
  });
  it('понятная серверная 422 email остаётся у поля без дублирующего общего alert', async () => {
    const user = await readyForm();
    api.mode = 'validation';
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    const email = screen.getByLabelText('Email');
    await waitFor(() => expect(email).toHaveFocus());
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription(
      'Введите email в формате name@example.com, без пробелов',
    );
    expect(email).toHaveValue('anna@example.com');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('неизвестная серверная 422 сохраняет общий fallback, фокус и черновик', async () => {
    const user = await readyForm();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        { detail: [{ loc: ['body', 'unexpected'], msg: 'invalid', type: 'value_error' }] },
        { status: 422 },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Сервер не принял данные заказа');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByLabelText('Email')).toHaveValue('anna@example.com');
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false');
  });
  it('блокирует повторный confirm и сохраняет проверенный заказ при сетевой ошибке', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    let reject!: (reason: Error) => void;
    api.confirmResponse = () =>
      new Promise<Response>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
    const button = screen.getByRole('button', { name: 'Подтвердить заказ' });
    await user.dblClick(button);
    expect(button).toBeDisabled();
    expect(api.requests.filter((r) => r.path === '/api/orders')).toHaveLength(1);
    reject(new TypeError('offline'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Результат подтверждения неизвестен'),
    );
    expect(screen.getByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
  });
});

it.each([
  { label: '201 {}', status: 201, body: '{}' },
  { label: '201 invalid JSON', status: 201, body: '{broken' },
  { label: '500', status: 500, body: '{"detail":"Internal Server Error"}' },
  { label: '422 invalid JSON', status: 422, body: '{broken' },
])(
  'повреждённый ответ подтверждения $label сохраняет заказ и неопределённость до ручного повтора',
  async ({ status, body }) => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    api.confirmResponse = async () =>
      new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Результат подтверждения неизвестен');
    expect(alert).toHaveTextContent('«Подтвердить заказ»');
    expect(alert).toHaveTextContent('Автоматически запрос не повторяется');
    expect(alert).not.toHaveTextContent('Заказ не создан');
    expect(screen.getByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
    expect(screen.getByText('Анна')).toBeVisible();
    expect(screen.getByText('anna@example.com')).toBeVisible();
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
    expect(screen.queryByRole('heading', { name: 'Заказ подтверждён' })).not.toBeInTheDocument();
    await waitFor(() => expect(alert).toHaveFocus());
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    api.confirmResponse = undefined;
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    expect(await screen.findByRole('heading', { name: 'Заказ подтверждён' })).toBeVisible();
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(2);
    expect(api.requests[2]!.body).toEqual(api.requests[0]!.body);
    expect(api.requests.filter((request) => request.path === '/api/orders/quote')).toHaveLength(1);
  },
);

describe('Упрощение оформления A — test first', () => {
  it('показывает единицы возраста и тариф из API после допустимого возраста, не выдавая его за итог заказа', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ ...event, child_ticket_price: 900, full_ticket_price: 2500 }),
    );
    const user = await readyForm('13');
    const age = screen.getByLabelText('Возраст, лет');
    expect(age).toHaveAccessibleDescription(/Детский билет.*900\s₽/);
    expect(screen.queryByTestId('order-total')).not.toBeInTheDocument();
    await user.clear(age);
    await user.type(age, '14');
    expect(age).toHaveAccessibleDescription(/Полный билет.*2\s500\s₽/);
    expect(api.requests).toHaveLength(0);
    await user.clear(age);
    await user.type(age, '-1');
    expect(age).not.toHaveAccessibleDescription(/билет.*₽/);
  });

  it('сохраняет название добавления и открывает пустого участника при нехватке сопровождающего', async () => {
    const user = await readyForm('13');
    const add = screen.getByRole('button', { name: 'Добавить участника' });
    expect(add).toBeVisible();
    await user.click(add);
    const adult = screen.getByRole('group', { name: 'Участник 2' });
    const age = within(adult).getByLabelText(/^Возраст/);
    expect(age).toHaveValue('');
    expect(within(adult).getByLabelText('Имя')).toHaveValue('');
    await waitFor(() => expect(within(adult).getByLabelText('Имя')).toHaveFocus());
    await user.type(within(adult).getByLabelText('Имя'), 'Борис');
    await user.type(age, '17');
    expect(add).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(screen.getByRole('group', { name: 'Состав заказа' })).toHaveAccessibleDescription(
      /Для ребёнка младше 14 лет нужен сопровождающий от 18 лет/,
    );
    expect(api.requests).toHaveLength(0);
    await user.clear(age);
    await user.type(age, '18');
    expect(add).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Состав заказа' })).not.toHaveAttribute(
        'aria-describedby',
      ),
    );
    expect(api.requests).toHaveLength(0);
  });

  it('при четырёх несовместимых участниках поясняет смену состава и не предлагает пятый слот', async () => {
    const user = await readyForm('13');
    for (let index = 1; index < 4; index++) {
      await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
      await fillPerson(user, `Гость ${index}`, '17', index);
    }
    expect(screen.getByText('До 4 участников')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Добавить участника' })).toBeDisabled();
    expect(screen.getByText(/Измените состав.*18 лет/)).toBeVisible();
    expect(screen.getAllByRole('group', { name: /Участник/ })).toHaveLength(4);
    expect(api.requests).toHaveLength(0);
  });

  it('из проверки редактирует выбранного участника и фокусирует его поле без потери соседних данных', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    await fillPerson(user, 'Лев', '13', 1);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('button', { name: 'Изменить участника 2' }));
    const second = screen.getByRole('group', { name: 'Участник 2' });
    await waitFor(() => expect(within(second).getByLabelText('Имя')).toHaveFocus());
    expect(within(second).getByLabelText('Имя')).toHaveValue('Лев');
    expect(
      within(screen.getByRole('group', { name: 'Участник 1' })).getByLabelText('Имя'),
    ).toHaveValue('Анна');
    expect(screen.getByLabelText('Email')).toHaveValue('anna@example.com');
    expect(screen.queryByTestId('order-total')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Подтвердить заказ' })).not.toBeInTheDocument();
  });

  it('редактирование email ведёт сразу к email и требует свежего расчёта', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('button', { name: 'Изменить email' }));
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveFocus());
    expect(screen.queryByTestId('order-total')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    expect(screen.getByText('new@example.com')).toBeVisible();
    expect(api.requests.filter((request) => request.path.endsWith('/quote'))).toHaveLength(2);
  });

  it('после sold_out сводка остаётся, нет проходного шага, повтор ручной и не меняет демосценарий', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('radio', { name: 'Нет мест' }));
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    await screen.findByRole('heading', { name: 'Места закончились' });
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
    expect(screen.getByText('anna@example.com')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Вернуться к проверке' })).not.toBeInTheDocument();
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Повторить подтверждение' }));
    await waitFor(() =>
      expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(2),
    );
    expect(screen.getByRole('radio', { name: 'Нет мест' })).toBeChecked();
    expect(api.requests[2]!.scenario).toBe('sold_out');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Повторить подтверждение' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('radio', { name: 'Успех' }));
    await user.click(screen.getByRole('button', { name: 'Повторить подтверждение' }));
    await screen.findByRole('heading', { name: 'Заказ подтверждён' });
    expect(api.requests.filter((request) => request.path.endsWith('/quote'))).toHaveLength(1);
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(3);
  });

  it('на успехе выделяет число билетов и сумму подтверждения перед техническим номером заказа', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    await fillPerson(user, 'Лев', '13', 1);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    await screen.findByRole('heading', { name: 'Заказ подтверждён' });
    const summary = screen.getByTestId('order-total').closest('.success-summary');
    expect(summary).toHaveTextContent('2 билета · 3 000 ₽');
    expect(
      summary!.compareDocumentPosition(screen.getByText('demo-123')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
