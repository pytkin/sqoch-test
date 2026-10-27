import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import {
  apiNotFound,
  campaignId,
  campaignPath,
  confirmed,
  draft,
  mockOrganizerApi,
  preview,
  summary,
} from './test-fixtures';

function openRoute(hash: string) {
  window.history.replaceState(null, '', hash);
  render(<App />);
}

afterEach(() => window.history.replaceState(null, '', '/'));

describe('Кабинет организатора — test first', () => {
  it('сохраняет работающий booking по его маршруту — контроль HTTP harness', async () => {
    mockOrganizerApi(() => apiNotFound());
    openRoute('/#/booking');
    expect(await screen.findByRole('heading', { name: 'Оформление билетов' })).toBeVisible();
    expect(screen.getByLabelText('Имя')).toBeVisible();
  });

  it('по organizer hash показывает мероприятия и общую навигацию', async () => {
    const saved = draft();
    const requests = mockOrganizerApi(({ path }) =>
      path === '/api/organizer/campaigns'
        ? Response.json({ items: [summary(saved)] })
        : apiNotFound(),
    );
    openRoute('/#/organizer');
    expect(await screen.findByRole('heading', { name: 'Мероприятия', level: 1 })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Билеты' })).toHaveAttribute('href', '#/booking');
    expect(screen.getByRole('link', { name: 'Керамика' })).toHaveAttribute(
      'href',
      '#/organizer/events/ceramics',
    );
    expect(requests.filter(({ path }) => path === '/api/organizer/campaigns')).toHaveLength(1);
  });

  it('по прямой ссылке восстанавливает draft, но исторический preview не разрешает confirm', async () => {
    const saved = draft({ text_reviewed: true, reviewed_event_revision: 0 });
    saved.preview = preview(saved);
    mockOrganizerApi(({ path }) => (path === campaignPath ? Response.json(saved) : apiNotFound()));
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    expect(await screen.findByRole('textbox', { name: 'Тема' })).toHaveValue(saved.subject);
    expect(screen.getByRole('textbox', { name: 'Текст письма' })).toHaveValue(saved.body);
    expect(screen.getByLabelText('Новая дата')).toHaveValue('2099-11-20');
    expect(screen.getByLabelText('Новое время')).toHaveValue('19:00');
    expect(
      screen.queryByRole('button', { name: 'Подтвердить перенос и уведомить покупателей' }),
    ).not.toBeInTheDocument();
  });

  it('сохраняет изменённую дату PATCH перед rewrite и использует возвращённую revision', async () => {
    const user = userEvent.setup();
    let saved = draft();
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'GET') return Response.json(saved);
      if (path === campaignPath && method === 'PATCH') {
        saved = {
          ...saved,
          revision: saved.revision + 1,
          proposed_start: String(body.proposed_start),
          text_reviewed: false,
          reviewed_event_revision: null,
        };
        return Response.json(saved);
      }
      if (path === `${campaignPath}/rewrite`) {
        saved = { ...saved, revision: saved.revision + 1, body: 'Короткий исправленный текст' };
        return Response.json({
          outcome: 'applied',
          campaign: saved,
          fields_to_complete: [],
          clarifications: [],
          message: 'Текст изменён',
        });
      }
      return apiNotFound();
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByRole('textbox', { name: 'Тема' });
    fireEvent.change(screen.getByLabelText('Новая дата'), { target: { value: '2099-11-21' } });
    await user.type(
      screen.getByRole('textbox', { name: 'Что изменить с помощником?' }),
      'Сделай короче',
    );
    await user.click(screen.getByRole('button', { name: 'Изменить текст' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Текст письма' })).toHaveValue(
        'Короткий исправленный текст',
      ),
    );
    const writes = requests.filter(({ method }) => method !== 'GET');
    expect(writes.map(({ method, path }) => [method, path])).toEqual([
      ['PATCH', campaignPath],
      ['POST', `${campaignPath}/rewrite`],
    ]);
    expect(writes[0]!.body.proposed_start).toBe('2099-11-21T19:00:00+03:00');
    expect(writes[1]!.body).toEqual({ expected_revision: 6, instruction: 'Сделай короче' });
  });

  it('оставляет предложенную AI дату подсказкой до явного ввода организатором', async () => {
    const user = userEvent.setup();
    let saved = draft({ proposed_start: null });
    mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'GET') return Response.json(saved);
      if (path === campaignPath && method === 'PATCH') {
        saved = { ...saved, revision: 6 };
        return Response.json(saved);
      }
      if (path === `${campaignPath}/prepare`) {
        saved = {
          ...saved,
          revision: 7,
          suggested_start: '2099-11-20T19:00:00+03:00',
          proposed_start: null,
          text_reviewed: false,
        };
        return Response.json({
          outcome: 'needs_input',
          campaign: saved,
          fields_to_complete: ['proposed_start'],
          clarifications: [],
          message: 'Укажите дату переноса',
        });
      }
      return apiNotFound();
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByRole('textbox', { name: 'Тема' });
    await user.type(
      screen.getByRole('textbox', { name: 'Как переносим мероприятие?' }),
      'Перенеси Керамику на 20 ноября, 19:00',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    expect(await screen.findByText(/Укажите дату переноса/)).toBeVisible();
    expect(screen.getByLabelText('Новая дата')).toHaveValue('');
    expect(screen.getByLabelText('Новое время')).toHaveValue('');
    expect(
      screen.queryByRole('button', { name: 'Подтвердить перенос и уведомить покупателей' }),
    ).not.toBeInTheDocument();
  });

  it('при потере ответа confirm проверяет ту же рассылку, не создавая новую и не повторяя confirm', async () => {
    const user = userEvent.setup();
    let saved = draft({ text_reviewed: true, reviewed_event_revision: 0 });
    let confirmedOnServer = false;
    const result = confirmed({
      status: 'processing',
      counters: { total: 2, pending: 2, sending: 0, retry_wait: 0, sent: 0, failed: 0, unknown: 0 },
      deliveries: confirmed().deliveries.map((delivery) => ({
        ...delivery,
        state: 'pending',
        attempts: 0,
        sent_at: null,
        error_code: null,
        error_message: null,
      })),
    });
    const requests = mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'GET')
        return Response.json(confirmedOnServer ? result : saved);
      if (path === campaignPath && method === 'PATCH') {
        saved = { ...saved, revision: saved.revision + 1 };
        return Response.json(saved);
      }
      if (path === `${campaignPath}/preview`) return Response.json(preview(saved));
      if (path === `${campaignPath}/confirm`) {
        confirmedOnServer = true;
        throw new TypeError('Response lost after server commit');
      }
      return apiNotFound();
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByRole('textbox', { name: 'Тема' });
    await user.click(screen.getByRole('button', { name: 'Проверить перенос' }));
    await user.click(
      await screen.findByRole('button', { name: 'Подтвердить перенос и уведомить покупателей' }),
    );
    expect(await screen.findByText('Отправлено 0 из 2')).toBeVisible();
    expect(requests.filter(({ path }) => path === `${campaignPath}/confirm`)).toHaveLength(1);
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(0);
    expect(
      requests.filter(({ path, method }) => path === campaignPath && method === 'GET').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('показывает unknown и выполняет только явную сверку Mailpit, без переотправки', async () => {
    const user = userEvent.setup();
    const saved = confirmed();
    const reconciled = confirmed({
      status: 'completed',
      counters: { total: 2, pending: 0, sending: 0, retry_wait: 0, sent: 2, failed: 0, unknown: 0 },
      deliveries: saved.deliveries.map((delivery) => ({
        ...delivery,
        state: 'sent',
        sent_at: '2026-10-26T12:06:00Z',
        error_code: null,
        error_message: null,
      })),
    });
    const requests = mockOrganizerApi(({ path }) => {
      if (path === campaignPath) return Response.json(saved);
      if (path === `${campaignPath}/reconcile`) return Response.json(reconciled);
      return apiNotFound();
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    expect(await screen.findByText('unknown@example.com')).toBeVisible();
    expect(screen.getByText('Отправлено 1 из 2')).toBeVisible();
    expect(screen.getAllByText(/Требует проверки/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Принудительн/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Проверить результат отправки' }));
    expect(await screen.findByText('Отправлено 2 из 2')).toBeVisible();
    expect(requests.filter(({ path }) => path === `${campaignPath}/reconcile`)).toHaveLength(1);
    expect(
      requests.filter(({ path }) => path.endsWith('/resume') || path.endsWith('/confirm')),
    ).toHaveLength(0);
  });

  it('ошибка PATCH перед AI сохраняет местные правки и не вызывает модель', async () => {
    const user = userEvent.setup();
    const saved = draft();
    const requests = mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'GET') return Response.json(saved);
      if (path === campaignPath && method === 'PATCH')
        return Response.json(
          {
            detail: {
              code: 'revision_conflict',
              message: 'Конфликт версии',
              related_campaign_id: null,
            },
          },
          { status: 409 },
        );
      return apiNotFound();
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    const subject = await screen.findByRole('textbox', { name: 'Тема' });
    await user.clear(subject);
    await user.type(subject, 'Моя несохранённая правка');
    await user.type(
      screen.getByRole('textbox', { name: 'Что изменить с помощником?' }),
      'Сделай короче',
    );
    await user.click(screen.getByRole('button', { name: 'Изменить текст' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ваши правки остались в форме');
    expect(subject).toHaveValue('Моя несохранённая правка');
    expect(requests.filter(({ path }) => path.endsWith('/rewrite'))).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Обновить сведения' })).toBeEnabled();
  });

  it('правка текста снимает проверку и не допускает preview без нового checkbox', async () => {
    const user = userEvent.setup();
    const saved = draft({ text_reviewed: true, reviewed_event_revision: 0 });
    const requests = mockOrganizerApi(({ path }) =>
      path === campaignPath ? Response.json(saved) : apiNotFound(),
    );
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByRole('textbox', { name: 'Тема' });
    const reviewed = screen.getByRole('checkbox', {
      name: 'Текст соответствует мероприятию и новой дате',
    });
    expect(reviewed).toBeChecked();
    await user.type(screen.getByRole('textbox', { name: 'Текст письма' }), ' Правка');
    expect(reviewed).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Проверить перенос' }));
    expect(requests.filter(({ path }) => path.endsWith('/preview'))).toHaveLength(0);
    await waitFor(() => expect(reviewed).toHaveFocus());
  });

  it('поздний polling не затирает результат ручной сверки более старым состоянием', async () => {
    const user = userEvent.setup();
    const saved = confirmed();
    saved.deliveries.push({
      ...saved.deliveries[1]!,
      id: 'delivery-unknown-2',
      email: 'still-unknown@example.com',
    });
    saved.counters = { ...saved.counters, total: 3, unknown: 2 };
    const finished = confirmed({
      status: 'needs_attention',
      counters: { total: 3, pending: 0, sending: 0, retry_wait: 0, sent: 2, failed: 0, unknown: 1 },
      deliveries: saved.deliveries.map((delivery, index) =>
        index === 1
          ? {
              ...delivery,
              state: 'sent',
              sent_at: '2026-10-26T12:06:00Z',
              error_code: null,
              error_message: null,
            }
          : delivery,
      ),
    });
    let reads = 0;
    let finishPoll: ((response: Response) => void) | undefined;
    const poll = new Promise<Response>((resolve) => {
      finishPoll = resolve;
    });
    mockOrganizerApi(({ path }) => {
      if (path === campaignPath) return ++reads === 1 ? Response.json(saved) : poll;
      if (path === `${campaignPath}/reconcile`) return Response.json(finished);
      return apiNotFound();
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByText('Отправлено 1 из 3');
    await waitFor(() => expect(reads).toBe(2), { timeout: 2600 });
    await user.click(screen.getByRole('button', { name: 'Проверить результат отправки' }));
    await screen.findByText('Отправлено 2 из 3');
    await act(async () => {
      finishPoll!(Response.json(saved));
    });
    expect(screen.getByText('Отправлено 2 из 3')).toBeVisible();
    expect(screen.queryByText('Отправлено 1 из 3')).not.toBeInTheDocument();
  });

  it('после потерянного создания повтор использует тот же UUID', async () => {
    const user = userEvent.setup();
    const puts: string[] = [];
    let created = draft();
    mockOrganizerApi(({ path, method }) => {
      if (path === '/api/organizer/campaigns') return Response.json({ items: [] });
      if (method === 'PUT') {
        puts.push(path);
        if (puts.length === 1) throw new TypeError('Response lost');
        created = draft({
          id: path.split('/').at(-1)!,
          revision: 0,
        });
        return Response.json(created, { status: 201 });
      }
      if (path.endsWith('/prepare'))
        return Response.json({
          outcome: 'applied',
          campaign: created,
          fields_to_complete: [],
          clarifications: [],
          message: 'Подготовлено',
        });
      if (method === 'GET' && puts.length >= 2) return Response.json(created);
      return apiNotFound();
    });
    openRoute('/#/organizer/transfer');
    await user.type(
      await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' }),
      'Перенести Керамику на 20 ноября 2099 года в 19:00',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await screen.findByRole('textbox', { name: 'Тема' });
    expect(puts).toHaveLength(2);
    expect(puts[1]).toBe(puts[0]);
    expect(window.location.hash).toBe(`#/organizer/campaigns/${created.id}`);
  });

  it('пустая просьба не сохраняет draft и не вызывает помощника', async () => {
    const user = userEvent.setup();
    const requests = mockOrganizerApi(({ path }) =>
      path === campaignPath ? Response.json(draft()) : apiNotFound(),
    );
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByRole('textbox', { name: 'Тема' });
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    expect(requests.filter(({ method }) => method !== 'GET')).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Как переносим мероприятие?' })).toHaveFocus(),
    );
  });

  it('поздний AI ответ не меняет покинутый экран, а возврат читает сохранённую версию', async () => {
    const user = userEvent.setup();
    let saved = draft({ proposed_start: null });
    let finishAi: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      finishAi = resolve;
    });
    const requests = mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'GET') return Response.json(saved);
      if (path === campaignPath && method === 'PATCH') {
        saved = { ...saved, revision: saved.revision + 1 };
        return Response.json(saved);
      }
      if (path === `${campaignPath}/prepare`) return response;
      return apiNotFound();
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByRole('textbox', { name: 'Тема' });
    await user.type(
      screen.getByRole('textbox', { name: 'Как переносим мероприятие?' }),
      'Подготовь перенос',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await waitFor(() => expect(requests.some(({ path }) => path.endsWith('/prepare'))).toBe(true));
    expect(screen.getByRole('textbox', { name: 'Тема' })).toBeDisabled();
    await user.click(screen.getByRole('link', { name: 'Билеты' }));
    await screen.findByRole('heading', { name: 'Оформление билетов' });
    saved = { ...saved, revision: saved.revision + 1, subject: 'Сохранённый ответ помощника' };
    await act(async () => {
      finishAi!(
        Response.json({
          outcome: 'needs_input',
          campaign: saved,
          fields_to_complete: ['proposed_start'],
          clarifications: [],
          message: 'Укажите дату',
        }),
      );
    });
    expect(screen.getByRole('heading', { name: 'Оформление билетов' })).toBeVisible();
    act(() => {
      window.location.hash = `/organizer/campaigns/${campaignId}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByRole('textbox', { name: 'Тема' })).toHaveValue(
      'Сохранённый ответ помощника',
    );
    expect(
      requests.filter(({ path, method }) => path === campaignPath && method === 'GET').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('ошибка polling сохраняет последнее состояние и клавиатурный фокус', async () => {
    const saved = confirmed();
    let reads = 0;
    mockOrganizerApi(({ path }) => {
      if (path === campaignPath && ++reads === 1) return Response.json(saved);
      throw new TypeError('Network unavailable');
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByText('Отправлено 1 из 2');
    const button = screen.getByRole('button', { name: 'Проверить результат отправки' });
    button.focus();
    expect(
      await screen.findByText(/Не удалось обновить статус/, {}, { timeout: 2600 }),
    ).toBeVisible();
    expect(screen.getByText('Отправлено 1 из 2')).toBeVisible();
    expect(button).toHaveFocus();
  });

  it('предупреждает об уходе с несохранёнными правками и остаётся при отказе', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    mockOrganizerApi(({ path }) =>
      path === campaignPath ? Response.json(draft()) : apiNotFound(),
    );
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    const subject = await screen.findByRole('textbox', { name: 'Тема' });
    await user.type(subject, ' Правка');
    await user.click(screen.getByRole('link', { name: 'Билеты' }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    expect(subject).toHaveValue('Перенос мастер-класса «Керамика» Правка');
    expect(window.location.hash).toBe(`#/organizer/campaigns/${campaignId}`);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('связывает помощь и часовой пояс с полями и обозначает обязательную проверку', async () => {
    mockOrganizerApi(({ path }) =>
      path === campaignPath ? Response.json(draft()) : apiNotFound(),
    );
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByRole('textbox', { name: 'Тема' });
    expect(
      screen.getByRole('textbox', { name: 'Как переносим мероприятие?' }),
    ).toHaveAccessibleDescription(/Год можно не указывать/);
    expect(screen.getByLabelText('Новая дата')).toHaveAccessibleDescription(/Europe\/Moscow/);
    expect(
      screen.getByRole('checkbox', { name: 'Текст соответствует мероприятию и новой дате' }),
    ).toBeRequired();
  });

  it('после подтверждения в другом окне предлагает обновить состояние вместо тупика', async () => {
    const user = userEvent.setup();
    let saved = draft({ text_reviewed: true, reviewed_event_revision: 0 });
    mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'GET') return Response.json(saved);
      if (path === campaignPath && method === 'PATCH') {
        saved = { ...saved, revision: saved.revision + 1 };
        return Response.json(saved);
      }
      if (path === `${campaignPath}/preview`) return Response.json(preview(saved));
      if (path === `${campaignPath}/confirm`)
        return Response.json(
          {
            detail: {
              code: 'confirmation_conflict',
              message: 'Уже подтверждено',
              related_campaign_id: null,
            },
          },
          { status: 409 },
        );
      return apiNotFound();
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByRole('textbox', { name: 'Тема' });
    await user.click(screen.getByRole('button', { name: 'Проверить перенос' }));
    await user.click(
      await screen.findByRole('button', { name: 'Подтвердить перенос и уведомить покупателей' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Рассылка уже подтверждена');
    expect(screen.getByRole('button', { name: 'Обновить сведения' })).toBeEnabled();
  });
});

describe('Восстановление загрузки и прогресса — test first', () => {
  it('после принятия resume не обещает будущую отправку уже завершённой рассылки', async () => {
    const user = userEvent.setup();
    const saved = confirmed({
      status: 'processing',
      counters: { total: 2, pending: 0, sending: 0, retry_wait: 1, sent: 1, failed: 0, unknown: 0 },
    });
    saved.deliveries[1] = {
      ...saved.deliveries[1]!,
      state: 'retry_wait',
      next_attempt_at: '2099-11-20T19:00:00+03:00',
    };
    const completed = confirmed({
      status: 'completed',
      counters: { total: 2, pending: 0, sending: 0, retry_wait: 0, sent: 2, failed: 0, unknown: 0 },
      deliveries: saved.deliveries.map((item) => ({
        ...item,
        state: 'sent',
        next_attempt_at: null,
        sent_at: '2026-10-26T12:06:00Z',
        error_code: null,
        error_message: null,
      })),
    });
    mockOrganizerApi(({ path }) => {
      if (path === campaignPath) return Response.json(saved);
      if (path === `${campaignPath}/resume`) return Response.json(completed);
      return apiNotFound();
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await user.click(await screen.findByRole('button', { name: 'Продолжить отправку' }));
    await screen.findByText('Отправлено 2 из 2');
    expect(screen.getByText('Запрос на продолжение отправки принят')).toBeVisible();
    expect(
      screen.queryByText('Отправка продолжится в пределах оставшихся попыток'),
    ).not.toBeInTheDocument();
  });

  it.each([
    ['список', '/#/organizer'],
    ['черновик', `/#/organizer/campaigns/${campaignId}`],
  ])('успешный повтор загрузки (%s) переводит фокус к заголовку', async (_name, route) => {
    const user = userEvent.setup();
    let reads = 0;
    mockOrganizerApi(() => {
      if (++reads === 1) throw new TypeError('Load unavailable');
      return Response.json(route === '/#/organizer' ? { items: [] } : draft());
    });
    openRoute(route);
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
    if (route === '/#/organizer') await screen.findByRole('link', { name: 'Керамика' });
    else await screen.findByRole('textbox', { name: 'Тема' });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
  });

  it.each([
    ['список', '/#/organizer'],
    ['черновик', `/#/organizer/campaigns/${campaignId}`],
  ])(
    'повторный отказ загрузки (%s) возвращает фокус на связанное с ошибкой действие',
    async (_name, route) => {
      const user = userEvent.setup();
      mockOrganizerApi(() => {
        throw new TypeError('Load unavailable');
      });
      window.history.replaceState(null, '', route);
      render(
        <>
          <button type="button">Контроль начального фокуса</button>
          <App />
        </>,
      );
      const control = screen.getByRole('button', { name: 'Контроль начального фокуса' });
      control.focus();
      await screen.findByRole('alert');
      expect(control).toHaveFocus();
      await user.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
      await screen.findByRole('alert');
      const retry = screen.getByRole('button', { name: 'Повторить загрузку' });
      await waitFor(() => expect(retry).toHaveFocus());
      expect(retry).toHaveAccessibleDescription(/Не удалось загрузить данные кабинета/);
    },
  );

  it('успешная ручная сверка очищает прежнюю ошибку polling после завершения', async () => {
    const user = userEvent.setup();
    const saved = confirmed();
    const completed = confirmed({
      status: 'completed',
      counters: { total: 2, pending: 0, sending: 0, retry_wait: 0, sent: 2, failed: 0, unknown: 0 },
      deliveries: saved.deliveries.map((item) => ({
        ...item,
        state: 'sent',
        sent_at: '2026-10-26T12:06:00Z',
        error_code: null,
        error_message: null,
      })),
    });
    let reads = 0;
    mockOrganizerApi(({ path }) => {
      if (path === campaignPath) {
        if (++reads === 1) return Response.json(saved);
        throw new TypeError('Polling unavailable');
      }
      if (path === `${campaignPath}/reconcile`) return Response.json(completed);
      return apiNotFound();
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByText('Отправлено 1 из 2');
    await screen.findByText(/Не удалось обновить статус/, {}, { timeout: 2600 });
    await user.click(screen.getByRole('button', { name: 'Проверить результат отправки' }));
    await screen.findByText('Отправлено 2 из 2');
    expect(screen.queryByText(/Не удалось обновить статус/)).not.toBeInTheDocument();
  });

  it('опоздавший отказ polling после ручной сверки не возвращает старое предупреждение', async () => {
    const user = userEvent.setup();
    const saved = confirmed();
    saved.deliveries.push({
      ...saved.deliveries[1]!,
      id: 'delivery-unknown-2',
      email: 'still-unknown@example.com',
    });
    saved.counters = { ...saved.counters, total: 3, unknown: 2 };
    const recovered = confirmed({
      status: 'needs_attention',
      counters: { total: 3, pending: 0, sending: 0, retry_wait: 0, sent: 2, failed: 0, unknown: 1 },
      deliveries: saved.deliveries.map((item, index) =>
        index === 1
          ? {
              ...item,
              state: 'sent',
              sent_at: '2026-10-26T12:06:00Z',
              error_code: null,
              error_message: null,
            }
          : item,
      ),
    });
    let rejectPoll: ((reason: Error) => void) | undefined;
    const polling = new Promise<Response>((_resolve, reject) => {
      rejectPoll = reject;
    });
    let reads = 0;
    mockOrganizerApi(({ path }) => {
      if (path === campaignPath) return ++reads === 1 ? Response.json(saved) : polling;
      if (path === `${campaignPath}/reconcile`) return Response.json(recovered);
      return apiNotFound();
    });
    openRoute(`/#/organizer/campaigns/${campaignId}`);
    await screen.findByText('Отправлено 1 из 3');
    await waitFor(() => expect(reads).toBe(2), { timeout: 2600 });
    await user.click(screen.getByRole('button', { name: 'Проверить результат отправки' }));
    await screen.findByText('Отправлено 2 из 3');
    await act(async () => {
      rejectPoll!(new TypeError('Late polling failure'));
    });
    expect(screen.getByText('Отправлено 2 из 3')).toBeVisible();
    expect(screen.queryByText(/Не удалось обновить статус/)).not.toBeInTheDocument();
  });
});
