import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../../App';
import { mockBookingApi, fillPerson, readyForm } from './test-fixtures';
import type { BookingApiMock } from './test-fixtures';

let api: BookingApiMock;
beforeEach(() => {
  api = mockBookingApi();
});

describe('Данные заказа — test first', () => {
  it('начинается с одного участника; позволяет добавить до четырёх и удалить', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Оформление билетов' });
    expect(screen.getAllByRole('group', { name: /Участник/ })).toHaveLength(1);
    for (let n = 0; n < 3; n++)
      await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    expect(screen.getAllByRole('group', { name: /Участник/ })).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Добавить участника' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Удалить участника 4' }));
    expect(screen.getAllByRole('group', { name: /Участник/ })).toHaveLength(3);
  });
  it('блокирует пустые поля, пробельное имя, некорректный email и пустой возраст', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Оформление билетов' });
    await user.type(screen.getByLabelText('Имя'), '   ');
    await user.type(screen.getByLabelText('Email'), 'bad');
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(screen.getByText('Введите имя участника: поле не должно быть пустым')).toBeVisible();
    expect(screen.getByText('Введите возраст в полных годах: целое число от 0')).toBeVisible();
    expect(
      screen.getByText('Введите email в формате name@example.com, без пробелов'),
    ).toBeVisible();
    expect(api.requests).toHaveLength(0);
  });
  it.each(['-1', '1.5'])('отклоняет возраст %s до обращения к API', async (age) => {
    const user = await readyForm(age);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(screen.getByText('Введите возраст в полных годах: целое число от 0')).toBeVisible();
    expect(api.requests).toHaveLength(0);
  });
  it.each(['0', '13'])('ребёнок %s без сопровождающего не переходит к расчёту', async (age) => {
    const user = await readyForm(age);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Для ребёнка младше 14 лет нужен сопровождающий от 18 лет',
    );
    expect(api.requests).toHaveLength(0);
  });
  it.each(['14', '17'])('участник %s может оформить заказ один', async (age) => {
    const user = await readyForm(age);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(await screen.findByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
    expect(api.requests[0]!.body.participants).toEqual([{ name: 'Анна', age: Number(age) }]);
  });
  it('взрослый и ребёнок 0 лет дают серверный расчёт 3000 ₽ и trimmed имя', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    await fillPerson(user, '  Лев  ', '0', 1);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    expect(screen.getByTestId('order-total')).toHaveTextContent('3 000');
    expect(api.requests[0]!.body.participants).toEqual([
      { name: 'Анна', age: 18 },
      { name: 'Лев', age: 0 },
    ]);
  });
});

it('повреждённый ответ расчёта сохраняет форму и обычную ошибку сервера', async () => {
  const user = await readyForm();
  api.mode = 'malformed';
  await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Сервер вернул ошибку или некорректный ответ');
  expect(alert).not.toHaveTextContent('Результат подтверждения неизвестен');
  expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
  expect(screen.getByLabelText('Email')).toHaveValue('anna@example.com');
  expect(screen.queryByRole('heading', { name: 'Проверьте заказ' })).not.toBeInTheDocument();
  expect(api.requests).toHaveLength(1);
});

it('привязывает серверную ошибку email к полю и aria-describedby', async () => {
  const user = await readyForm();
  api.mode = 'validation';
  await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
  expect(
    await screen.findByText('Введите email в формате name@example.com, без пробелов'),
  ).toBeVisible();
  expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(
    'Введите email в формате name@example.com, без пробелов',
  );
});
it('связывает ошибку сопровождения с группой состава', async () => {
  const user = await readyForm('13');
  await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
  expect(screen.getByRole('group', { name: 'Состав заказа' })).toHaveAccessibleDescription(
    /Для ребёнка младше 14 лет нужен сопровождающий от 18 лет в том же заказе\. Нажмите «Добавить участника»/,
  );
});
