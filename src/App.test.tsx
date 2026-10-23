import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const event = {
  id: 'sqoch-demo',
  title: 'Встреча Sqoch',
  currency: 'RUB',
  max_participants: 4,
  child_age_limit: 14,
  companion_min_age: 18,
  full_ticket_price: 2000,
  child_ticket_price: 1000,
};
let requests: { path: string; body: Record<string, unknown>; scenario: string | null }[];
let mode: 'success' | 'network' | 'validation' | 'malformed';
let confirmResponse: (() => Promise<Response>) | undefined;
function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/event') return Response.json(event);
      const body = JSON.parse(String(init?.body)) as {
        participants: { name: string; age: number }[];
        email: string;
      };
      const scenario = new Headers(init?.headers).get('X-Demo-Scenario');
      requests.push({ path, body, scenario });
      if (mode === 'malformed') return Response.json({});
      if (mode === 'network') throw new TypeError('Failed to fetch');
      if (mode === 'validation')
        return Response.json(
          { detail: [{ loc: ['body', 'email'], msg: 'invalid', type: 'value_error' }] },
          { status: 422 },
        );
      if (path === '/api/orders' && confirmResponse) return confirmResponse();
      if (path === '/api/orders' && scenario === 'sold_out')
        return Response.json(
          { detail: { code: 'sold_out', message: 'Места закончились' } },
          { status: 409 },
        );
      const participants = body.participants.map((p) => ({
        ...p,
        ticket_type: p.age < 14 ? 'child' : 'full',
        price: p.age < 14 ? 1000 : 2000,
      }));
      return Response.json(
        {
          participants,
          email: body.email,
          total: participants.reduce((n, p) => n + p.price, 0),
          currency: 'RUB',
          ...(path === '/api/orders' ? { order_id: 'demo-123' } : {}),
        },
        { status: path === '/api/orders' ? 201 : 200 },
      );
    }),
  );
}
async function fillPerson(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  age: string,
  index = 0,
) {
  const group = screen.getAllByRole('group', { name: /Участник/ })[index]!;
  await user.type(within(group).getByLabelText('Имя'), name);
  await user.type(within(group).getByLabelText(/^Возраст/), age);
}
async function readyForm(age = '18') {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { name: 'Оформление билетов' });
  await fillPerson(user, 'Анна', age);
  await user.type(screen.getByLabelText('Email'), 'anna@example.com');
  return user;
}
beforeEach(() => {
  requests = [];
  mode = 'success';
  confirmResponse = undefined;
  mockApi();
});

describe('Понятная обратная связь оформления — test first', () => {
  it('объявляет отказ из-за мест у действия, фокусирует ошибку и не подтверждает при смене radio', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('radio', { name: 'Нет мест' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(0);
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
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Повторить подтверждение' }));
    await screen.findByRole('heading', { name: 'Заказ подтверждён' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ошибка расчёта называет незавершённое действие и сохраняет заполненную форму', async () => {
    const user = await readyForm();
    mode = 'network';
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
    expect(requests).toHaveLength(0);
  });

  it('показывает новое название правил и короткие подписи без конечной точки', async () => {
    const user = await readyForm('13');
    expect(screen.getByText('Правила покупки билетов', { exact: true })).toBeVisible();
    expect(screen.getByText('Все поля обязательны', { exact: true })).toBeVisible();
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
    expect(age).toHaveAccessibleDescription('Введите возраст в полных годах — целое число от 0');
    expect(age).toHaveAttribute('aria-invalid', 'true');
    expect(requests).toHaveLength(0);
  });

  it('показывает объяснение лимита как доступное описание добавления', async () => {
    const user = await readyForm();
    const add = screen.getByRole('button', { name: 'Добавить участника' });
    expect(add).toHaveAccessibleDescription('В одном заказе может быть от 1 до 4 участников');
    for (let index = 0; index < 3; index++) await user.click(add);
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(
      'Достигнут лимит — 4 участника. Чтобы добавить другого человека, сначала удалите одного из списка',
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
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    await user.click(screen.getByRole('radio', { name: 'Успех' }));
    expect(demo).toHaveAccessibleDescription(/после нажатия «Повторить подтверждение»/);
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Повторить подтверждение' }));
    expect(await screen.findByRole('heading', { name: 'Заказ подтверждён' })).toBeVisible();
  });
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
    expect(screen.getByText('Введите имя участника — поле не должно быть пустым')).toBeVisible();
    expect(screen.getByText('Введите возраст в полных годах — целое число от 0')).toBeVisible();
    expect(
      screen.getByText('Введите email в формате name@example.com, без пробелов'),
    ).toBeVisible();
    expect(requests).toHaveLength(0);
  });
  it.each(['-1', '1.5'])('отклоняет возраст %s до обращения к API', async (age) => {
    const user = await readyForm(age);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(screen.getByText('Введите возраст в полных годах — целое число от 0')).toBeVisible();
    expect(requests).toHaveLength(0);
  });
  it.each(['0', '13'])('ребёнок %s без сопровождающего не переходит к расчёту', async (age) => {
    const user = await readyForm(age);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Для ребёнка младше 14 лет нужен сопровождающий от 18 лет',
    );
    expect(requests).toHaveLength(0);
  });
  it.each(['14', '17'])('участник %s может оформить заказ один', async (age) => {
    const user = await readyForm(age);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(await screen.findByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
    expect(requests[0]!.body.participants).toEqual([{ name: 'Анна', age: Number(age) }]);
  });
  it('взрослый и ребёнок 0 лет дают серверный расчёт 3000 ₽ и trimmed имя', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    await fillPerson(user, '  Лев  ', '0', 1);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    expect(screen.getByTestId('order-total')).toHaveTextContent('3 000');
    expect(requests[0]!.body.participants).toEqual([
      { name: 'Анна', age: 18 },
      { name: 'Лев', age: 0 },
    ]);
  });
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
    expect(requests.filter((r) => r.path === '/api/orders/quote')).toHaveLength(2);
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
    expect(requests[1]!.scenario).toBe('success');
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
  });
  it('демопереключатель виден на проверке, влияет только на confirm и сохраняет выбор после редактирования', async () => {
    const user = await readyForm();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    expect(requests[0]!.scenario).toBeNull();
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
      requests
        .filter((request) => request.path.endsWith('/quote'))
        .map((request) => request.scenario),
    ).toEqual([null, null]);
  });
  it('сеть на расчёте сохраняет форму и даёт повторить запрос', async () => {
    const user = await readyForm();
    mode = 'network';
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось связаться с сервером');
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
    mode = 'success';
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(await screen.findByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
  });
  it('понятная серверная 422 email остаётся у поля без дублирующего общего alert', async () => {
    const user = await readyForm();
    mode = 'validation';
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
    confirmResponse = () =>
      new Promise<Response>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
    const button = screen.getByRole('button', { name: 'Подтвердить заказ' });
    await user.dblClick(button);
    expect(button).toBeDisabled();
    expect(requests.filter((r) => r.path === '/api/orders')).toHaveLength(1);
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
    confirmResponse = async () =>
      new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Результат подтверждения неизвестен');
    expect(alert).toHaveTextContent('«Подтвердить заказ»');
    expect(alert).toHaveTextContent('автоматически запрос не повторяется');
    expect(alert).not.toHaveTextContent('Заказ не создан');
    expect(screen.getByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
    expect(screen.getByText('Анна')).toBeVisible();
    expect(screen.getByText('anna@example.com')).toBeVisible();
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
    expect(screen.queryByRole('heading', { name: 'Заказ подтверждён' })).not.toBeInTheDocument();
    await waitFor(() => expect(alert).toHaveFocus());
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    confirmResponse = undefined;
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    expect(await screen.findByRole('heading', { name: 'Заказ подтверждён' })).toBeVisible();
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(2);
    expect(requests[2]!.body).toEqual(requests[0]!.body);
    expect(requests.filter((request) => request.path === '/api/orders/quote')).toHaveLength(1);
  },
);

it('повреждённый ответ расчёта сохраняет форму и обычную ошибку сервера', async () => {
  const user = await readyForm();
  mode = 'malformed';
  await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Сервер вернул ошибку или некорректный ответ');
  expect(alert).not.toHaveTextContent('Результат подтверждения неизвестен');
  expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
  expect(screen.getByLabelText('Email')).toHaveValue('anna@example.com');
  expect(screen.queryByRole('heading', { name: 'Проверьте заказ' })).not.toBeInTheDocument();
  expect(requests).toHaveLength(1);
});

it('привязывает серверную ошибку email к полю и aria-describedby', async () => {
  const user = await readyForm();
  mode = 'validation';
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

describe('Эвристическая доводка — test first', () => {
  it('до отправки поясняет обязательность всех полей и передаёт её каждому доступному полю', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Оформление билетов' });
    for (const label of ['Имя', 'Возраст, лет', 'Email'])
      expect(screen.getByLabelText(label)).toBeRequired();
    expect(screen.getByText('Все поля обязательны')).toBeVisible();
    expect(screen.getByLabelText('Email').closest('form')).toHaveAttribute('novalidate');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
    const added = screen.getByRole('group', { name: 'Участник 2' });
    expect(within(added).getByLabelText('Имя')).toBeRequired();
    expect(within(added).getByLabelText('Возраст, лет')).toBeRequired();
    expect(requests).toHaveLength(0);
  });

  it.each([
    {
      name: '',
      age: '',
      email: '',
      field: 'Имя',
      message: 'Введите имя участника — поле не должно быть пустым',
      errors: 3,
    },
    {
      name: 'Анна',
      age: '',
      email: 'bad',
      field: 'Возраст, лет',
      message: 'Введите возраст в полных годах — целое число от 0',
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
      expect(requests).toHaveLength(0);
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
    mode = 'network';
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /^Вернуть участника/ })).toBeEnabled();
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна');
    mode = 'success';
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('button', { name: 'Изменить участника 1' }));
    expect(screen.queryByRole('button', { name: /^Вернуть участника/ })).not.toBeInTheDocument();
    expect(requests.filter((request) => request.path === '/api/orders/quote')).toHaveLength(2);
  });

  it('серверная 422 на подтверждении возвращает фокус в поле вместо заголовка и сохраняет черновик', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    mode = 'validation';
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
    expect(requests.filter((request) => request.path === '/api/orders/quote')).toHaveLength(1);
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Повторить подтверждение' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Изменить участника 1' }));
    expect(screen.getByLabelText('Email')).toHaveValue('anna@example.com');
    expect(screen.queryByTestId('order-total')).not.toBeInTheDocument();
  });

  it('потеря ответа confirm сообщает неопределённость и допускает только ручной повтор', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    mode = 'network';
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Результат подтверждения неизвестен');
    expect(alert).not.toHaveTextContent('Заказ не создан');
    expect(screen.getByTestId('order-total')).toHaveTextContent('2 000');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    mode = 'success';
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    expect(await screen.findByRole('heading', { name: 'Заказ подтверждён' })).toBeVisible();
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(2);
  });
});

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
    expect(requests).toHaveLength(0);
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
    expect(requests).toHaveLength(0);
    await user.clear(age);
    await user.type(age, '18');
    expect(add).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Состав заказа' })).not.toHaveAttribute(
        'aria-describedby',
      ),
    );
    expect(requests).toHaveLength(0);
  });

  it('при четырёх несовместимых участниках поясняет смену состава и не предлагает пятый слот', async () => {
    const user = await readyForm('13');
    for (let index = 1; index < 4; index++) {
      await user.click(screen.getByRole('button', { name: 'Добавить участника' }));
      await fillPerson(user, `Гость ${index}`, '17', index);
    }
    expect(screen.getByText(/4 из 4/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Добавить участника' })).toBeDisabled();
    expect(screen.getByText(/Измените состав.*18 лет/)).toBeVisible();
    expect(screen.getAllByRole('group', { name: /Участник/ })).toHaveLength(4);
    expect(requests).toHaveLength(0);
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
    expect(requests.filter((request) => request.path.endsWith('/quote'))).toHaveLength(2);
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
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Повторить подтверждение' }));
    await waitFor(() =>
      expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(2),
    );
    expect(screen.getByRole('radio', { name: 'Нет мест' })).toBeChecked();
    expect(requests[2]!.scenario).toBe('sold_out');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Повторить подтверждение' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('radio', { name: 'Успех' }));
    await user.click(screen.getByRole('button', { name: 'Повторить подтверждение' }));
    await screen.findByRole('heading', { name: 'Заказ подтверждён' });
    expect(requests.filter((request) => request.path.endsWith('/quote'))).toHaveLength(1);
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(3);
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

describe('Срок жизни ошибки и справка — test first', () => {
  it('после sold_out потеря ответа ручного повтора убирает устаревший категоричный отказ', async () => {
    const user = await readyForm();
    await user.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('heading', { name: 'Проверьте заказ' });
    await user.click(screen.getByRole('radio', { name: 'Нет мест' }));
    await user.click(screen.getByRole('button', { name: 'Подтвердить заказ' }));
    await screen.findByRole('heading', { name: 'Места закончились' });
    mode = 'network';
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
    expect(requests.filter((request) => request.path === '/api/orders/quote')).toHaveLength(1);
    expect(requests.filter((request) => request.path === '/api/orders')).toHaveLength(2);
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
    expect(requests).toHaveLength(0);

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
    expect(requests).toHaveLength(0);
  });
});
