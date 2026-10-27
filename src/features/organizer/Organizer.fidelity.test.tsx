import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import type { AssistantState } from '../../api/generated/types.gen';
import {
  apiNotFound,
  campaignId,
  campaignPath,
  draft,
  mockOrganizerApi,
  summary,
} from './test-fixtures';

const requestLabel = /Запрос помощнику|Как переносим мероприятие\?/;
function preparation(mode: 'manual' | 'assistant', prompt: string): AssistantState {
  return {
    version: 1,
    mode,
    stage: mode === 'manual' ? 'applied' : 'intake',
    original_prompt: prompt,
    answers: {},
    context_event_id: 'ceramics',
    partial_date: { year: 2099, month: 12, day: 1, hour: 19, minute: 0 },
    year_source: 'manual',
    manual_fields: ['date', 'time'],
    clarifications: [],
    intake_revision: mode === 'assistant' ? 0 : null,
    applied_revision: mode === 'manual' ? 0 : null,
  };
}
function open() {
  window.history.replaceState(null, '', '/#/organizer/events/ceramics/transfer');
  render(<App />);
}
async function fillManual(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Заполнить вручную' }));
  fireEvent.change(screen.getByLabelText('Новая дата'), { target: { value: '2099-12-01' } });
  fireEvent.change(screen.getByLabelText('Новое время'), { target: { value: '19:00' } });
  await user.type(screen.getByLabelText('Тема'), 'Новая дата занятия');
  await user.type(screen.getByLabelText('Текст письма'), 'Встречаемся 1 декабря 2099 года в 19:00');
}
afterEach(() => window.history.replaceState(null, '', '/'));

describe('Верность SQOCH-39: реальные действия внутри принятой композиции', () => {
  it('ручная форма раскрывается под запросом, а Prepare сохраняет assistant intent и ручные источники', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
    let current = draft();
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'PUT') {
        current = draft({
          revision: 0,
          proposed_start: String(body.proposed_start),
          subject: String(body.subject),
          body: String(body.body),
          assistant_state: preparation(body.mode as 'assistant' | 'manual', String(body.prompt)),
        });
        return Response.json(current, { status: 201 });
      }
      if (path.endsWith('/prepare')) {
        current = {
          ...current,
          revision: 2,
          assistant_state: { ...current.assistant_state!, stage: 'applied', applied_revision: 2 },
        };
        return Response.json({
          outcome: 'applied',
          campaign: current,
          clarifications: [],
          fields_to_complete: [],
          message: 'Перенос подготовлен',
        });
      }
      return path === campaignPath ? Response.json(current) : apiNotFound();
    });
    open();
    const prompt = await screen.findByRole('textbox', { name: requestLabel });
    await user.type(prompt, 'Перенести Керамику на 1 декабря 2099 года в 19:00');
    await fillManual(user);
    expect(prompt).toBeVisible();
    expect(screen.getByRole('button', { name: 'Заполнить вручную' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await screen.findByRole('heading', { name: 'Проверьте перенос', level: 1 });
    expect(requests.find(({ method }) => method === 'PUT')!.body).toMatchObject({
      mode: 'assistant',
      prompt: 'Перенести Керамику на 1 декабря 2099 года в 19:00',
      proposed_start: '2099-12-01T19:00:00+03:00',
      manual_fields: ['date', 'time'],
    });
    expect(requests.filter(({ path }) => path.endsWith('/prepare'))).toHaveLength(1);
  });

  it('явное ручное сохранение с непустым запросом не вызывает AI', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
    let current = draft();
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'PUT') {
        current = draft({
          revision: 0,
          proposed_start: String(body.proposed_start),
          subject: String(body.subject),
          body: String(body.body),
          assistant_state: preparation('manual', String(body.prompt)),
        });
        return Response.json(current, { status: 201 });
      }
      return path === campaignPath ? Response.json(current) : apiNotFound();
    });
    open();
    await user.type(
      await screen.findByRole('textbox', { name: requestLabel }),
      'Сохранить мой исходный запрос',
    );
    await fillManual(user);
    await user.click(screen.getByRole('button', { name: 'Сохранить подготовку' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/organizer/campaigns/${campaignId}`));
    expect(requests.find(({ method }) => method === 'PUT')!.body).toMatchObject({
      mode: 'manual',
      prompt: 'Сохранить мой исходный запрос',
    });
    expect(requests.filter(({ path }) => path.endsWith('/prepare'))).toHaveLength(0);
  });

  it('начало использует принятые заголовок, label, пример и известный контекст', async () => {
    mockOrganizerApi(() => apiNotFound());
    open();
    const prompt = await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' });
    expect(screen.getByRole('heading', { name: 'Перенос мероприятия', level: 1 })).toBeVisible();
    expect(prompt).toHaveAttribute('placeholder', 'Переносим Керамику на 2 декабря, 19:00');
    expect(screen.getByRole('link', { name: 'Выбрать другое мероприятие' })).toHaveAttribute(
      'href',
      '#/organizer',
    );
    expect(screen.queryByRole('heading', { name: 'Помощник' })).not.toBeInTheDocument();
  });

  it('служебная дата изменения не показывает дробные секунды как время мероприятия', async () => {
    const current = draft({ updated_at: '2026-10-27T10:20:30.123456Z' });
    mockOrganizerApi(({ path }) =>
      path === '/api/organizer/campaigns'
        ? Response.json({ items: [summary(current)] })
        : apiNotFound(),
    );
    window.history.replaceState(null, '', '/#/organizer/events/ceramics');
    render(<App />);
    expect(await screen.findByText(/Изменена:/)).not.toHaveTextContent('.123456');
  });

  it('несохранённая ручная дата не показывает происхождение года от прежней даты', async () => {
    const user = userEvent.setup();
    const current = draft({
      proposed_start: '2099-12-01T19:00:00+03:00',
      assistant_state: {
        ...preparation('assistant', 'Переносим на 1 декабря, 19:00'),
        stage: 'applied',
        year_source: 'current_year',
        manual_fields: [],
        intake_revision: 4,
        applied_revision: 5,
      },
    });
    const requests = mockOrganizerApi(({ path }) =>
      path === campaignPath ? Response.json(current) : apiNotFound(),
    );
    window.history.replaceState(null, '', `/#/organizer/campaigns/${campaignId}`);
    render(<App />);
    expect(await screen.findByText(/Год 2099 выбран по текущей дате/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Изменить мероприятие и дату' }));
    fireEvent.change(screen.getByLabelText('Новая дата'), { target: { value: '2100-12-01' } });
    expect(screen.queryByText(/Год 2099 выбран по текущей дате/)).not.toBeInTheDocument();
    expect(screen.getByText('1 декабря 2100 года')).toBeVisible();
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });
});
