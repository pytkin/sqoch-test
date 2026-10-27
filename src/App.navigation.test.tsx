import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import {
  apiNotFound,
  campaignId,
  campaignPath,
  confirmed,
  draft,
  events,
  mockOrganizerApi,
  summary,
} from './features/organizer/test-fixtures';

function open(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
  return render(<App />);
}

function navigate(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

function historySummary() {
  return { ...summary(confirmed()), preparation_stage: null };
}

function terminalCampaign(status: 'completed' | 'completed_with_errors') {
  const failed = status === 'completed_with_errors' ? 1 : 0;
  const current = confirmed({
    status,
    counters: {
      total: 2,
      pending: 0,
      sending: 0,
      retry_wait: 0,
      sent: 2 - failed,
      failed,
      unknown: 0,
    },
  });
  current.deliveries = current.deliveries.map((delivery, index) => ({
    ...delivery,
    state: failed && index === 1 ? 'failed' : 'sent',
    error_code: failed && index === 1 ? 'smtp_rejected' : null,
    error_message: failed && index === 1 ? 'Отказ Mailpit' : null,
  }));
  return current;
}

afterEach(() => window.history.replaceState(null, '', '/'));

describe('SQOCH-42: маршруты мероприятий и общая навигация', () => {
  it('из booking открывает мероприятия, сохраняя локальные шаги внутри оформления', async () => {
    const user = userEvent.setup();
    const requests = mockOrganizerApi(({ path }) =>
      path === '/api/organizer/campaigns' ? Response.json({ items: [] }) : apiNotFound(),
    );
    open('#/booking');
    await screen.findByRole('heading', { name: 'Оформление билетов' });
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: 'Билеты' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(header).queryByText(/Шаг/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByText(/Шаг/)).toBeVisible();
    expect(within(header).queryByRole('link', { name: 'sqoch.' })).not.toBeInTheDocument();
    await user.click(within(header).getByRole('link', { name: 'Мероприятия' }));
    await screen.findByRole('heading', { name: 'Мероприятия', level: 1 });
    expect(screen.getByRole('link', { name: 'Керамика' })).toHaveAttribute(
      'href',
      '#/organizer/events/ceramics',
    );
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it.each(['completed', 'completed_with_errors'] as const)(
    'обзор открывает последний сохранённый результат %s, сохраняя новый перенос в деталях',
    async (status) => {
      const user = userEvent.setup();
      const latest = terminalCampaign(status);
      const older = terminalCampaign('completed');
      older.id = 'b2b887d0-fdaa-40a1-805f-286dc7bca2ad';
      older.created_at = '2026-10-20T12:00:00Z';
      const requests = mockOrganizerApi(({ path }) =>
        path === '/api/organizer/campaigns'
          ? Response.json({ items: [summary(latest), summary(older)] })
          : path === campaignPath
            ? Response.json(latest)
            : apiNotFound(),
      );
      open('#/organizer');
      const result = await screen.findByRole('link', { name: 'Открыть результат: Керамика' });
      expect(result).toHaveAttribute('href', `#/organizer/campaigns/${latest.id}`);
      expect(screen.queryByRole('link', { name: 'Перенести: Керамика' })).not.toBeInTheDocument();
      await user.click(result);
      await screen.findByRole('heading', { name: 'Уведомление покупателей', level: 1 });
      await user.click(screen.getByRole('link', { name: 'К мероприятию' }));
      await screen.findByRole('heading', { name: 'Керамика', level: 1 });
      expect(screen.getByRole('link', { name: 'Перенести мероприятие' })).toHaveAttribute(
        'href',
        '#/organizer/events/ceramics/transfer',
      );
      expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    },
  );

  it('при отсутствии истории и подготовки обзор по-прежнему открывает начального помощника', async () => {
    const requests = mockOrganizerApi(({ path }) =>
      path === '/api/organizer/campaigns' ? Response.json({ items: [] }) : apiNotFound(),
    );
    open('#/organizer');
    expect(await screen.findByRole('link', { name: 'Перенести: Керамика' })).toHaveAttribute(
      'href',
      '#/organizer/events/ceramics/transfer',
    );
    expect(
      screen.queryByRole('link', { name: 'Открыть результат: Керамика' }),
    ).not.toBeInTheDocument();
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it.each(['attention', 'one_preparation', 'multiple_preparations'] as const)(
    'обзор сохраняет приоритет %s перед завершённым результатом',
    async (priority) => {
      const terminal = terminalCampaign('completed');
      const preparation = draft({ id: 'c0158ed4-d245-453b-8a79-8a8e0827f6a5' });
      const second = draft({ id: '44d8fe61-ed59-48db-a7a2-d3f07502dffa' });
      const attention = confirmed({ id: 'f4958dbe-2c40-431c-bccf-ddd10771e27c' });
      const related =
        priority === 'attention'
          ? [summary(attention), summary(preparation)]
          : priority === 'one_preparation'
            ? [summary(preparation)]
            : [summary(preparation), summary(second)];
      const requests = mockOrganizerApi(({ path }) =>
        path === '/api/organizer/campaigns'
          ? Response.json({ items: [summary(terminal), ...related] })
          : apiNotFound(),
      );
      open('#/organizer');
      const name =
        priority === 'attention'
          ? 'Проверить отправку: Керамика'
          : priority === 'one_preparation'
            ? 'Продолжить подготовку: Керамика'
            : 'Открыть подготовки: Керамика';
      const target =
        priority === 'attention'
          ? `#/organizer/campaigns/${attention.id}`
          : priority === 'one_preparation'
            ? `#/organizer/campaigns/${preparation.id}`
            : '#/organizer/events/ceramics';
      expect(await screen.findByRole('link', { name })).toHaveAttribute('href', target);
      expect(
        screen.queryByRole('link', { name: 'Открыть результат: Керамика' }),
      ).not.toBeInTheDocument();
      expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    },
  );

  it('обзор группирует отдельные подготовки и сохраняет содержательные unassigned без пустого мусора', async () => {
    const first = draft({ subject: 'Вечерняя группа' });
    const second = draft({
      id: '45e581b2-d108-44a4-a986-65d9ccfa5e93',
      subject: 'Утренняя группа',
    });
    const unassigned = draft({
      id: 'a5c0d08f-2c11-44e9-b4df-6c2a3128d7f0',
      event_id: null,
      subject: 'Уточнить мероприятие',
    });
    const empty = draft({
      id: 'f3dca0ee-e5e1-4a32-a40b-894eae6181c0',
      event_id: null,
      proposed_start: null,
      subject: '',
      body: '',
    });
    const requests = mockOrganizerApi(({ path }) =>
      path === '/api/organizer/campaigns'
        ? Response.json({
            items: [summary(first), summary(second), summary(unassigned), summary(empty)],
          })
        : apiNotFound(),
    );
    open('#/organizer');
    await screen.findByRole('link', { name: 'Керамика' });
    expect(screen.getByText('Незавершённых подготовок: 2')).toBeVisible();
    expect(screen.getByRole('link', { name: /Уточнить мероприятие/ })).toHaveAttribute(
      'href',
      `#/organizer/campaigns/${unassigned.id}`,
    );
    expect(screen.queryByText('Черновик без темы')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Мероприятие не выбрано/ })).not.toBeInTheDocument();
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('история события показывает immutable даты отдельно от текущей даты и не смешивает события', async () => {
    const first = draft({ subject: 'Вечерняя группа' });
    const second = draft({
      id: '45e581b2-d108-44a4-a986-65d9ccfa5e93',
      subject: 'Утренняя группа',
    });
    const other = draft({
      id: 'a5c0d08f-2c11-44e9-b4df-6c2a3128d7f0',
      event_id: 'painting',
      subject: 'Другая рассылка',
    });
    const otherHistory = confirmed({
      id: 'f44f087b-a668-4765-af8d-01fbad92b3de',
      event_id: 'painting',
      subject: 'История живописи',
      proposed_start: '2099-08-02T18:00:00+03:00',
      event_snapshot: {
        id: 'painting',
        title: 'Живопись',
        old_start: '2099-08-01T18:00:00+03:00',
        new_start: '2099-08-02T18:00:00+03:00',
        timezone: 'Europe/Moscow',
        event_revision_before: 0,
      },
    });
    const history = historySummary();
    history.id = '34fbef59-80f6-4f7b-a6d5-a814c954f5e7';
    history.event_snapshot = {
      ...history.event_snapshot!,
      old_start: '2099-10-01T19:00:00+03:00',
      new_start: '2099-10-10T19:00:00+03:00',
    };
    history.proposed_start = history.event_snapshot.new_start;
    const requests = mockOrganizerApi(({ path }) =>
      path === '/api/organizer/campaigns'
        ? Response.json({
            items: [
              summary(first),
              summary(second),
              summary(other),
              { ...summary(otherHistory), event_title: 'Живопись' },
              history,
            ],
          })
        : apiNotFound(),
    );
    open('#/organizer/events/ceramics');
    await screen.findByRole('heading', { name: 'Керамика', level: 1 });
    expect(screen.getByText(/Текущее начало:.*10 ноября 2099 г. в 19:00/)).toBeVisible();
    const oldHistory = screen.getByRole('region', { name: 'История переносов' });
    expect(within(oldHistory).getByText(/Было:.*1 октября 2099 г. в 19:00/)).toBeVisible();
    expect(
      within(oldHistory).getByText(/Перенесено на:.*10 октября 2099 г. в 19:00/),
    ).toBeVisible();
    expect(within(oldHistory).getByText(/Требует проверки/)).toBeVisible();
    expect(screen.getByRole('link', { name: /Вечерняя группа/ })).toHaveAttribute(
      'href',
      `#/organizer/campaigns/${first.id}`,
    );
    expect(screen.getByRole('link', { name: /Утренняя группа/ })).toHaveAttribute(
      'href',
      `#/organizer/campaigns/${second.id}`,
    );
    expect(screen.queryByText('Другая рассылка')).not.toBeInTheDocument();
    expect(within(oldHistory).queryByText('История живописи')).not.toBeInTheDocument();
    expect(within(oldHistory).queryByText(/1 августа 2099/)).not.toBeInTheDocument();
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('неизвестный organizer URL показывает 404 без перехода в booking и без мутаций', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    open('#/organizer/unknown/path');
    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Оформление билетов' })).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('чтение, возврат и refresh старой пустой ссылки не создают новую подготовку', async () => {
    const saved = draft({ event_id: null, proposed_start: null, subject: '', body: '' });
    const requests = mockOrganizerApi(({ path }) =>
      path === '/api/organizer/campaigns'
        ? Response.json({ items: [summary(saved)] })
        : path === campaignPath
          ? Response.json(saved)
          : apiNotFound(),
    );
    const view = open(`#/organizer/campaigns/${campaignId}`);
    await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' });
    navigate('#/organizer');
    await screen.findByRole('heading', { name: 'Мероприятия', level: 1 });
    navigate(`#/organizer/campaigns/${campaignId}`);
    await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' });
    view.unmount();
    render(<App />);
    await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' });
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('старый URL, ссылка к мероприятию и browser back/forward сохраняют контекст без мутаций', async () => {
    const user = userEvent.setup();
    const saved = draft();
    const requests = mockOrganizerApi(({ path }) =>
      path === '/api/organizer/campaigns'
        ? Response.json({ items: [summary(saved)] })
        : path === campaignPath
          ? Response.json(saved)
          : apiNotFound(),
    );
    open(`#/organizer/campaigns/${campaignId}`);
    await user.click(await screen.findByRole('link', { name: 'К мероприятию' }));
    await screen.findByRole('heading', { name: 'Керамика', level: 1 });
    await user.click(screen.getByRole('link', { name: 'Мероприятия' }));
    await screen.findByRole('heading', { name: 'Мероприятия', level: 1 });
    act(() => window.history.back());
    await screen.findByRole('heading', { name: 'Керамика', level: 1 });
    act(() => window.history.back());
    await screen.findByRole('textbox', { name: 'Тема' });
    act(() => window.history.forward());
    await screen.findByRole('heading', { name: 'Керамика', level: 1 });
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('начало переноса показывает помощника и контекст, manual открывает поля без записи', async () => {
    const user = userEvent.setup();
    const requests = mockOrganizerApi(() => apiNotFound());
    open('#/organizer/events/ceramics/transfer');
    await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' });
    expect(screen.getByText('Керамика')).toBeVisible();
    expect(screen.queryByLabelText('Новая дата')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Тема')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Заполнить вручную' }));
    expect(screen.getByLabelText('Новая дата')).toHaveFocus();
    expect(screen.getByLabelText('Тема')).toBeVisible();
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('пустой запрос и пустой manual контекст не создают подготовку', async () => {
    const user = userEvent.setup();
    const requests = mockOrganizerApi(() => apiNotFound());
    open('#/organizer/events/ceramics/transfer');
    await user.click(await screen.findByRole('button', { name: 'Подготовить перенос' }));
    expect(screen.getByRole('textbox', { name: 'Как переносим мероприятие?' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Заполнить вручную' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить подготовку' }));
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent(/Введите/);
  });

  it('несохранённый запрос защищён hash guard и beforeunload', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    mockOrganizerApi(() => apiNotFound());
    open('#/organizer/transfer');
    const input = await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' });
    await user.type(input, 'Перенести занятие');
    await user.click(screen.getByRole('link', { name: 'Билеты' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue('Перенести занятие');
    expect(window.location.hash).toBe('#/organizer/transfer');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('ручной выбор мероприятия с последующим очищением не сохраняет пустую запись', async () => {
    const user = userEvent.setup();
    const requests = mockOrganizerApi(() => apiNotFound());
    open('#/organizer/transfer');
    await user.click(await screen.findByRole('button', { name: 'Заполнить вручную' }));
    const select = screen.getByRole('combobox', { name: 'Мероприятие' });
    await user.selectOptions(select, 'ceramics');
    await user.selectOptions(select, '');
    await user.click(screen.getByRole('button', { name: 'Сохранить подготовку' }));
    await screen.findByRole('alert');
    expect(requests.filter(({ method }) => method !== 'GET')).toHaveLength(0);
  });

  it('до LLM атомарно сохраняет запрос, использует revision PUT и открывает тот же UUID', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
    let saved = draft({ revision: 0, proposed_start: null, subject: '', body: '' });
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'PUT') return Response.json(saved, { status: 201 });
      if (path === `${campaignPath}/prepare`) {
        expect(body.expected_revision).toBe(0);
        saved = draft({ revision: 2 });
        return Response.json({
          campaign: saved,
          outcome: 'applied',
          message: 'Подготовлено',
          fields_to_complete: [],
          clarifications: [],
        });
      }
      return path === campaignPath ? Response.json(saved) : apiNotFound();
    });
    open('#/organizer/events/ceramics/transfer');
    await user.type(
      await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' }),
      'Перенести на 20 ноября 2099 года в 19:00',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await screen.findByRole('textbox', { name: 'Тема' });
    expect(window.location.hash).toBe(`#/organizer/campaigns/${campaignId}`);
    expect(
      requests.filter(({ method }) => method !== 'GET').map(({ method, path }) => [method, path]),
    ).toEqual([
      ['PUT', campaignPath],
      ['POST', `${campaignPath}/prepare`],
    ]);
    expect(requests.find(({ method }) => method === 'PUT')!.body).toEqual({
      mode: 'assistant',
      prompt: 'Перенести на 20 ноября 2099 года в 19:00',
      context_event_id: 'ceramics',
    });
  });

  it('потерянный ответ PUT читает тот же UUID до LLM и не создаёт дубликат', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
    const saved = draft({ revision: 0 });
    const requests = mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'PUT') throw new TypeError('Response lost');
      if (path === campaignPath) return Response.json(saved);
      if (path.endsWith('/prepare'))
        return Response.json({
          campaign: saved,
          outcome: 'applied',
          message: 'Подготовлено',
          fields_to_complete: [],
          clarifications: [],
        });
      return apiNotFound();
    });
    open('#/organizer/transfer');
    await user.type(
      await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' }),
      'Перенести Керамику на 20 ноября 2099 года в 19:00',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await screen.findByRole('textbox', { name: 'Тема' });
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);
    const writes = requests.findIndex(({ method }) => method === 'PUT');
    expect(requests[writes + 1]).toMatchObject({ method: 'GET', path: campaignPath });
    expect(requests[writes + 2]).toMatchObject({ method: 'POST', path: `${campaignPath}/prepare` });
  });

  it('отказ сохранения оставляет запрос и фокус у повтора, без обращения к LLM', async () => {
    const user = userEvent.setup();
    const requests = mockOrganizerApi(() => apiNotFound());
    open('#/organizer/transfer');
    const input = await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' });
    await user.type(input, 'Перенести занятие');
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    const error = await screen.findByRole('alert');
    expect(error).toHaveFocus();
    expect(input).toHaveValue('Перенести занятие');
    expect(requests.filter(({ path }) => path.endsWith('/prepare'))).toHaveLength(0);
  });

  it('после отказа prepare и неудачного readback читает новую revision перед ручным повтором', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
    let reads = 0;
    let preparations = 0;
    const revisions: unknown[] = [];
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'PUT') return Response.json(draft({ revision: 0 }));
      if (path === campaignPath && method === 'GET') {
        if (++reads === 1) throw new TypeError('Readback unavailable');
        return Response.json(draft({ revision: 1 }));
      }
      if (path.endsWith('/prepare')) {
        revisions.push(body.expected_revision);
        if (++preparations === 1)
          return Response.json(
            { detail: { code: 'ai_timeout', message: 'Timeout', related_campaign_id: null } },
            { status: 504 },
          );
        return Response.json({
          outcome: 'applied',
          campaign: draft({ revision: 3 }),
          fields_to_complete: [],
          clarifications: [],
          message: 'Подготовлено',
        });
      }
      return apiNotFound();
    });
    open('#/organizer/transfer');
    await user.type(
      await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' }),
      'Перенести Керамику',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await screen.findByRole('alert');
    expect(preparations).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/organizer/campaigns/${campaignId}`));
    expect(revisions).toEqual([0, 1]);
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);
  });

  it('ручное сохранение создаёт содержательный manual без LLM и открывает сохранённые данные', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
    let saved = draft();
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'PUT') {
        saved = draft({
          subject: String(body.subject),
          proposed_start: String(body.proposed_start),
          body: String(body.body),
        });
        return Response.json(saved, { status: 201 });
      }
      return path === campaignPath ? Response.json(saved) : apiNotFound();
    });
    open('#/organizer/events/ceramics/transfer');
    await user.click(await screen.findByRole('button', { name: 'Заполнить вручную' }));
    fireEvent.change(screen.getByLabelText('Новая дата'), { target: { value: '2099-12-01' } });
    fireEvent.change(screen.getByLabelText('Новое время'), { target: { value: '19:00' } });
    await user.type(screen.getByLabelText('Тема'), 'Новая дата');
    await user.type(screen.getByLabelText('Текст письма'), 'Встречаемся 1 декабря');
    await user.click(screen.getByRole('button', { name: 'Сохранить подготовку' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/organizer/campaigns/${campaignId}`));
    expect(requests.filter(({ method }) => method !== 'GET')).toHaveLength(1);
    expect(requests.find(({ method }) => method === 'PUT')!.body).toMatchObject({
      mode: 'manual',
      event_id: events[0]!.id,
      proposed_start: '2099-12-01T19:00:00+03:00',
      subject: 'Новая дата',
      manual_fields: ['date', 'time'],
    });
  });
});
