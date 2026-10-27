import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { mockBookingApi, fillPerson, readyForm } from './test-fixtures';
import type { BookingApiMock } from './test-fixtures';

let api: BookingApiMock;
beforeEach(() => {
  api = mockBookingApi();
});

describe('Эвристическая доводка — test first', () => {
  it('группирует поля и добавление внутри участников, сохраняя required без общего баннера', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Оформление билетов' });
    for (const label of ['Имя', 'Возраст, лет', 'Email'])
      expect(screen.getByLabelText(label)).toBeRequired();
    const participants = screen.getByRole('region', { name: 'Участники' });
    expect(within(participants).getByLabelText('Имя')).toBeRequired();
    expect(within(participants).getByLabelText('Возраст, лет')).toBeRequired();
    expect(within(participants).getByRole('button', { name: 'Добавить участника' })).toBeEnabled();
    expect(within(participants).queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByText('Все поля обязательны')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email').closest('form')).toHaveAttribute('novalidate');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    const added = screen.getByRole('group', { name: 'Участник 2' });
    expect(within(added).getByLabelText('Имя')).toBeRequired();
    expect(within(added).getByLabelText('Возраст, лет')).toBeRequired();
    expect(api.requests).toHaveLength(0);
  });

  it.each([
    {
      name: '',
      age: '',
      email: '',
      field: 'Имя',
      message: 'Введите имя участника: поле не должно быть пустым',
      errors: 3,
    },
    {
      name: 'Анна',
      age: '',
      email: 'bad',
      field: 'Возраст, лет',
      message: 'Введите возраст в полных годах: целое число от 0',
      errors: 2,
    },
    {
      name: 'Анна',
      age: '18',
      email: 'bad',
      field: 'Email',
      message: 'Введите email в формате name@example.com, без пробелов',
      errors: 1,
    },
  ])(
    'первый фокус локальной ошибки $field уже получает invalid и существующее описание ошибки',
    async ({ name, age, email, field, message, errors }) => {
      const user = userEvent.setup();
      render(<App />);
      await screen.findByRole('heading', { name: 'Оформление билетов' });
      if (name) await user.type(screen.getByLabelText('Имя'), name);
      if (age) await user.type(screen.getByLabelText('Возраст, лет'), age);
      if (email) await user.type(screen.getByLabelText('Email'), email);
      const input = screen.getByLabelText(field);
      const focusSnapshots: { invalid: string | null; description: string }[] = [];
      input.addEventListener('focus', () => {
        const describedBy = input.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
        focusSnapshots.push({
          invalid: input.getAttribute('aria-invalid'),
          description: describedBy
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' '),
        });
      });
      await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
      await waitFor(() => expect(input).toHaveFocus());
      expect(focusSnapshots[0]).toEqual({
        invalid: 'true',
        description: expect.stringContaining(message),
      });
      expect(
        ['Имя', 'Возраст, лет', 'Email']
          .map((label) => screen.getByLabelText(label))
          .filter((control) => control.getAttribute('aria-invalid') === 'true'),
      ).toHaveLength(errors);
      expect(api.requests).toHaveLength(0);
    },
  );

  it('название возврата начинается с видимого действия и возвращает сохранённые поля с фокусом', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    await fillPerson(user, 'Борис', '42', 1);
    await user.click(screen.getByRole('button', { name: 'Удалить участника 2' }));
    const undo = screen.getByRole('button', { name: 'Вернуть участника' });
    expect(undo).toHaveTextContent('Вернуть');
    expect(undo).toHaveAccessibleName(/^Вернуть участника/);
    await user.click(undo);
    const restored = screen.getByRole('group', { name: 'Участник 2' });
    expect(within(restored).getByLabelText('Имя')).toHaveValue('Борис');
    expect(within(restored).getByLabelText(/^Возраст/)).toHaveValue('42');
    await waitFor(() => expect(within(restored).getByLabelText('Имя')).toHaveFocus());
  });

  it('бренд не является сбрасывающей ссылкой; добавление и удаление сохраняют рабочий фокус', async () => {
    const user = await readyForm();
    const banner = screen.getByRole('banner');
    expect(within(banner).queryByRole('link', { name: /Sqoch/i })).not.toBeInTheDocument();
    await user.click(within(banner).getByText(/sqoch/i));
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
    expect(screen.getByLabelText('Email')).toHaveValue('anna@example.com');
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    const added = screen.getByRole('group', { name: 'Участник 2' });
    await waitFor(() => expect(within(added).getByLabelText('Имя')).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Удалить участника 2' }));
    await waitFor(() => expect(screen.getByLabelText('Имя')).toHaveFocus());
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
  });

  it('отмена удаления восстанавливает актуальные поля на прежнюю позицию и переводит фокус', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    await fillPerson(user, 'Борис', '19', 1);
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    await fillPerson(user, 'Лев', '13', 2);
    const second = screen.getByRole('group', { name: 'Участник 2' });
    await user.clear(within(second).getByLabelText('Имя'));
    await user.type(within(second).getByLabelText('Имя'), 'Борис Иванов');
    await user.clear(within(second).getByLabelText(/^Возраст/));
    await user.type(within(second).getByLabelText(/^Возраст/), '42');
    await user.click(screen.getByRole('button', { name: 'Удалить участника 2' }));
    const following = screen.getByRole('group', { name: 'Участник 2' });
    expect(within(following).getByLabelText('Имя')).toHaveValue('Лев');
    await waitFor(() => expect(within(following).getByLabelText('Имя')).toHaveFocus());
    await user.click(screen.getByRole('button', { name: /^Вернуть участника/ }));
    const restored = screen.getByRole('group', { name: 'Участник 2' });
    expect(within(restored).getByLabelText('Имя')).toHaveValue('Борис Иванов');
    expect(within(restored).getByLabelText(/^Возраст/)).toHaveValue('42');
    expect(
      within(screen.getByRole('group', { name: 'Участник 3' })).getByLabelText('Имя'),
    ).toHaveValue('Лев');
    await waitFor(() => expect(within(restored).getByLabelText('Имя')).toHaveFocus());
    expect(screen.queryByRole('button', { name: /^Вернуть участника/ })).not.toBeInTheDocument();
  });

  it.each(['add', 'remove-empty'] as const)(
    'следующая структурная операция %s отменяет возможность вернуть прежнее удаление',
    async (operation) => {
      const user = await readyForm();
      await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
      await fillPerson(user, 'Лев', '13', 1);
      if (operation === 'remove-empty')
        await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
      await user.click(screen.getByRole('button', { name: 'Удалить участника 2' }));
      expect(screen.getByRole('button', { name: /^Вернуть участника/ })).toBeVisible();
      if (operation === 'add')
        await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
      else await user.click(screen.getByRole('button', { name: 'Удалить участника 2' }));
      expect(screen.queryByRole('button', { name: /^Вернуть участника/ })).not.toBeInTheDocument();
    },
  );

  it('неудачный расчёт сохраняет отмену удаления; успешный расчёт завершает её', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    await fillPerson(user, 'Лев', '13', 1);
    await user.click(screen.getByRole('button', { name: 'Удалить участника 2' }));
    api.mode = 'network';
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /^Вернуть участника/ })).toBeEnabled();
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
    api.mode = 'success';
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('button', { name: 'Изменить участника 1' }));
    expect(screen.queryByRole('button', { name: /^Вернуть участника/ })).not.toBeInTheDocument();
    expect(api.requests.filter((request) => request.path === '/api/orders/quote')).toHaveLength(2);
  });

  it('серверная 422 на подтверждении возвращает фокус в поле вместо заголовка и сохраняет черновик', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    api.mode = 'validation';
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    await screen.findByRole('heading', { name: 'Оформление билетов' });
    const email = screen.getByLabelText('Email');
    await waitFor(() => expect(email).toHaveFocus());
    expect(email).toHaveAccessibleDescription(/name@example\.com/);
    expect(email).toHaveValue('anna@example.com');
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
    expect(screen.queryByTestId('order-total')).not.toBeInTheDocument();
  });

  it.each(['local', 'server'] as const)(
    'ошибка состава %s фокусирует доступную группу после завершения запроса',
    async (source) => {
      const user = await readyForm(source === 'local' ? '13' : '18');
      if (source === 'server')
        vi.mocked(fetch).mockResolvedValueOnce(
          Response.json(
            {
              detail: [
                { loc: ['body', 'participants'], msg: 'companion_required', type: 'value_error' },
              ],
            },
            { status: 422 },
          ),
        );
      await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
      const composition = screen.getByRole('group', { name: 'Состав заказа' });
      await waitFor(() => expect(composition).toHaveFocus());
      expect(composition).toHaveAccessibleDescription(/18/);
      expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
    },
  );

  it('успешный повтор загрузки мероприятия переносит фокус на заголовок формы', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('offline'));
    render(<App />);
    const retry = await screen.findByRole('button', { name: 'Повторить загрузку' });
    await user.click(retry);
    const title = await screen.findByRole('heading', { name: 'Оформление билетов' });
    await waitFor(() => expect(title).toHaveFocus());
    expect(screen.getByLabelText('Имя')).toHaveValue('');
  });

  it('повторная ошибка загрузки сохраняет клавиатурный фокус у доступного действия или объяснения', async () => {
    const user = userEvent.setup();
    let rejectInitial!: (reason: Error) => void;
    vi.mocked(fetch)
      .mockReturnValueOnce(
        new Promise<Response>((_resolve, reject) => {
          rejectInitial = reject;
        }),
      )
      .mockRejectedValueOnce(new TypeError('offline'));
    render(
      <>
        <button>Внешнее действие</button>
        <App />
      </>,
    );
    await user.tab();
    const external = screen.getByRole('button', { name: 'Внешнее действие' });
    expect(external).toHaveFocus();
    rejectInitial(new TypeError('offline'));
    const retry = await screen.findByRole('button', { name: 'Повторить загрузку' });
    expect(external).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Билеты' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Мероприятия' })).toHaveFocus();
    await user.tab();
    expect(retry).toHaveFocus();
    await user.keyboard('{Enter}');
    const nextRetry = await screen.findByRole('button', { name: 'Повторить загрузку' });
    const alert = screen.getByRole('alert');
    await waitFor(() => expect([nextRetry, alert]).toContain(document.activeElement));
    expect(alert).toHaveTextContent('Не удалось связаться с сервером');
    if (document.activeElement === nextRetry)
      expect(nextRetry).toHaveAccessibleDescription(/Не удалось связаться с сервером/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('sold_out сохраняет сводку и даёт повторить confirm без нового quote; редактирование отменяет расчёт', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('radio', { name: 'Нет мест' }));
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    await screen.findByRole('heading', { name: 'Места закончились' });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
    expect(api.requests.filter((request) => request.path === '/api/orders/quote')).toHaveLength(1);
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Повторить подтверждение' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Изменить участника 1' }));
    expect(screen.getByLabelText('Email')).toHaveValue('anna@example.com');
    expect(screen.queryByTestId('order-total')).not.toBeInTheDocument();
  });

  it('потеря ответа confirm сообщает неопределённость и допускает только ручной повтор', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    api.mode = 'network';
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Результат подтверждения неизвестен');
    expect(alert).not.toHaveTextContent('Заказ не создан');
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    api.mode = 'success';
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    expect(await screen.findByRole('heading', { name: 'Заказ подтверждён' })).toBeVisible();
    expect(api.requests.filter((request) => request.path === '/api/orders')).toHaveLength(2);
  });
});
