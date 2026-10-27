import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { listCampaigns } from './api';
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

function openDraft() {
  window.history.replaceState(null, '', `/#/organizer/campaigns/${campaignId}`);
  render(<App />);
}
function section(name: string) {
  return within(
    name === 'Помощник'
      ? screen.getByRole('group', { name: 'Подготовка с помощником' })
      : screen.getByRole('heading', { name }).closest('section')!,
  );
}
afterEach(() => window.history.replaceState(null, '', '/'));

describe('Organizer: Nielsen audit regressions', () => {
  it('различает рассылки одного события темой и новой датой, не требуя открывать каждую', async () => {
    const first = draft({
      subject: 'Вечерняя группа',
      proposed_start: '2099-11-20T19:00:00+03:00',
    });
    const second = draft({
      id: '45e581b2-d108-44a4-a986-65d9ccfa5e93',
      subject: 'Утренняя группа',
      proposed_start: '2099-11-21T10:00:00+03:00',
    });
    mockOrganizerApi(({ path }) =>
      path === '/api/organizer/campaigns'
        ? Response.json({
            items: [
              { ...summary(first), subject: first.subject, proposed_start: first.proposed_start },
              {
                ...summary(second),
                subject: second.subject,
                proposed_start: second.proposed_start,
              },
            ],
          })
        : apiNotFound(),
    );
    window.history.replaceState(null, '', '/#/organizer/events/ceramics');
    render(<App />);
    expect(await screen.findByRole('link', { name: /Вечерняя группа/ })).toHaveAttribute(
      'href',
      `#/organizer/campaigns/${first.id}`,
    );
    expect(screen.getByRole('link', { name: /Утренняя группа/ })).toHaveAttribute(
      'href',
      `#/organizer/campaigns/${second.id}`,
    );
    expect(screen.getByText(/Новая дата:.*21 ноября 2099 г. в 10:00/)).toBeVisible();
  });

  it('позволяет сразу перейти к ручной форме без запроса к AI', async () => {
    const user = userEvent.setup();
    const saved = draft({ event_id: null, proposed_start: null, subject: '', body: '' });
    const requests = mockOrganizerApi(({ path }) =>
      path === campaignPath ? Response.json(saved) : apiNotFound(),
    );
    openDraft();
    await user.click(await screen.findByRole('button', { name: 'Заполнить вручную' }));
    expect(screen.getByRole('combobox', { name: 'Мероприятие' })).toHaveFocus();
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('после подготовки сообщает результат рядом с помощником и ведёт к явному вводу даты', async () => {
    const user = userEvent.setup();
    let saved = draft({ proposed_start: null });
    mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'GET') return Response.json(saved);
      if (path === campaignPath && method === 'PATCH') {
        saved = { ...saved, revision: 6 };
        return Response.json(saved);
      }
      if (path.endsWith('/prepare'))
        return Response.json({
          outcome: 'needs_input',
          campaign: { ...saved, revision: 7 },
          fields_to_complete: ['proposed_start'],
          clarifications: [],
          message: 'Текст подготовлен. Укажите дату переноса и проверьте уведомление.',
        });
      return apiNotFound();
    });
    openDraft();
    await user.type(await screen.findByLabelText('Как переносим мероприятие?'), 'Перенос Керамики');
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    expect(await section('Помощник').findByRole('status')).toHaveTextContent('Текст подготовлен');
    await waitFor(() => expect(screen.getByLabelText('Новая дата')).toHaveFocus());
    expect(screen.getByLabelText('Новая дата')).toHaveValue('');
  });

  it('ошибка AI видна у вызвавшей её кнопки, с фокусом и сохранением ввода', async () => {
    const user = userEvent.setup();
    let saved = draft();
    mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'GET') return Response.json(saved);
      if (path === campaignPath && method === 'PATCH') {
        saved = { ...saved, revision: 6 };
        return Response.json(saved);
      }
      return Response.json(
        {
          detail: {
            code: 'ai_unavailable',
            message: 'Помощник временно недоступен',
            related_campaign_id: null,
          },
        },
        { status: 502 },
      );
    });
    openDraft();
    await user.type(
      await screen.findByLabelText('Как переносим мероприятие?'),
      'Сохранить подробное объяснение',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    const error = await section('Помощник').findByRole('alert');
    expect(error).toHaveFocus();
    expect(screen.getByLabelText('Как переносим мероприятие?')).toHaveValue(
      'Сохранить подробное объяснение',
    );
    expect(screen.getByLabelText('Текст письма')).toHaveValue(saved.body);
  });

  it('при конфликте сохранения перед AI держит обновление рядом с ошибкой и сохраняет правки', async () => {
    const user = userEvent.setup();
    const saved = draft();
    let reads = 0;
    const requests = mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'GET')
        return Response.json({ ...saved, revision: reads++ === 0 ? 5 : 6 });
      if (path === campaignPath && method === 'PATCH')
        return Response.json(
          {
            detail: {
              code: 'revision_conflict',
              message: 'Черновик изменился. Загрузите актуальную версию',
              related_campaign_id: null,
            },
          },
          { status: 409 },
        );
      return apiNotFound();
    });
    openDraft();
    await user.type(await screen.findByLabelText('Тема'), ' — мои правки');
    await user.type(
      screen.getByLabelText('Как переносим мероприятие?'),
      'Подготовь подробный текст',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    const local = section('Помощник');
    const error = await local.findByRole('alert');
    expect(error).toHaveFocus();
    const refresh = local.getByRole('button', { name: 'Обновить сведения' });
    expect(screen.getAllByRole('button', { name: 'Обновить сведения' })).toHaveLength(1);
    await user.click(refresh);
    expect(await local.findByRole('status')).toHaveTextContent(/Ваши правки остались/);
    expect(screen.getByLabelText('Тема')).toHaveValue(saved.subject + ' — мои правки');
    expect(screen.getByLabelText('Как переносим мероприятие?')).toHaveValue(
      'Подготовь подробный текст',
    );
    expect(screen.getByLabelText('Мероприятие', { selector: 'select' })).toHaveFocus();
    expect(requests.filter((r) => r.path.endsWith('/prepare'))).toEqual([]);
  });

  it('показывает прогресс и восстановление перед длинным письмом и списком результатов', async () => {
    const saved = confirmed({ body: 'Подробное письмо. '.repeat(200) });
    mockOrganizerApi(({ path }) => (path === campaignPath ? Response.json(saved) : apiNotFound()));
    openDraft();
    const progress = await screen.findByText('Отправлено 1 из 2');
    const subject = screen.getByText(saved.subject);
    expect(
      progress.compareDocumentPosition(subject) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const check = screen.getByRole('button', { name: 'Проверить результат отправки' });
    const counters = screen.getByText('Требует проверки', { selector: 'dt' }).closest('dl')!;
    expect(check.compareDocumentPosition(counters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Проверить результат отправки' })).toHaveLength(1);
    expect(check.closest('.organizer-progress')).toHaveTextContent(/без повторной отправки/);
    expect(
      check.compareDocumentPosition(screen.getByText('unknown@example.com')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText(/Можно закрыть.*вернуться/)).toBeVisible();
  });

  it('не выдаёт завершённую сверку за подтверждение unknown и сохраняет фокус на результате', async () => {
    const user = userEvent.setup();
    const saved = confirmed();
    const requests = mockOrganizerApi(({ path }) =>
      path === campaignPath || path.endsWith('/reconcile') ? Response.json(saved) : apiNotFound(),
    );
    openDraft();
    await user.click(await screen.findByRole('button', { name: 'Проверить результат отправки' }));
    expect(await screen.findByText(/Результат отправки.*пока не подтверждён/)).toBeVisible();
    expect(screen.getByText('Отправлено 1 из 2').closest('[tabindex]')).toHaveFocus();
    expect(requests.filter((r) => r.path.endsWith('/resume'))).toEqual([]);
  });

  it('до подтверждения объясняет необратимость рассылки, сохраняя отдельное подтверждение', async () => {
    const user = userEvent.setup();
    let saved = draft({ text_reviewed: true, reviewed_event_revision: 0 });
    mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'GET') return Response.json(saved);
      if (path === campaignPath && method === 'PATCH') {
        saved = { ...saved, revision: 6 };
        return Response.json(saved);
      }
      if (path.endsWith('/preview')) return Response.json(preview(saved));
      return apiNotFound();
    });
    openDraft();
    await user.click(await screen.findByRole('button', { name: 'Проверить перенос' }));
    expect(await screen.findByText(/После подтверждения.*нельзя.*изменить/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Подтвердить перенос и уведомить покупателей' }),
    ).toBeEnabled();
  });

  it('называет кабинет в заголовке вкладки, отличая его от покупки билетов', async () => {
    mockOrganizerApi(({ path }) =>
      path === campaignPath ? Response.json(draft()) : apiNotFound(),
    );
    openDraft();
    await screen.findByLabelText('Тема');
    expect(document.title).toBe('Перенос мероприятия · Sqoch');
  });

  it.each([
    { subject: 42, proposed_start: null },
    { subject: 'Тема', proposed_start: 'не дата' },
  ])('отвергает повреждённый контекст строки истории: %j', async (damaged) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ items: [{ ...summary(draft()), ...damaged }] })),
    );
    await expect(listCampaigns()).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
