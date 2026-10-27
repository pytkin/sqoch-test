import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { apiNotFound, campaignId, campaignPath, draft, mockOrganizerApi } from './test-fixtures';
import type { CampaignDetail } from '../../api/generated/types.gen';
import { saveCampaign } from './api';

function open() {
  window.history.replaceState(null, '', '/#/organizer/transfer');
  render(<App />);
}
function manualDraft(overrides: Partial<CampaignDetail> = {}) {
  return draft({
    revision: 0,
    proposed_start: '2099-12-01T19:00:00+03:00',
    subject: 'Вариант А',
    body: 'Текст А',
    assistant_state: {
      version: 1,
      mode: 'manual',
      stage: 'applied',
      year_source: 'manual',
      original_prompt: '',
      answers: {},
      context_event_id: 'ceramics',
      partial_date: { year: 2099, month: 12, day: 1, hour: 19, minute: 0 },
      manual_fields: ['event_id', 'date', 'time'],
      clarifications: [],
      intake_revision: null,
      applied_revision: 0,
    },
    ...overrides,
  });
}
async function enterManual(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Заполнить вручную' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Мероприятие' }), 'ceramics');
  fireEvent.change(screen.getByLabelText('Новая дата'), { target: { value: '2099-12-01' } });
  fireEvent.change(screen.getByLabelText('Новое время'), { target: { value: '19:00' } });
}
afterEach(() => window.history.replaceState(null, '', '/'));

describe('SQOCH-42: исправления независимого ревью', () => {
  it('при первом assistant submit сохраняет ручные event/date/time и provenance до prepare', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'PUT') {
        const created = manualDraft({ subject: '', body: '' });
        created.assistant_state!.original_prompt = String(body.prompt);
        return Response.json(created, { status: 201 });
      }
      if (path.endsWith('/prepare'))
        return Response.json({
          outcome: 'needs_input',
          campaign: manualDraft(),
          fields_to_complete: [],
          clarifications: [],
          message: 'Проверьте конфликт ручной даты и запроса',
        });
      return path === campaignPath ? Response.json(manualDraft()) : apiNotFound();
    });
    open();
    await enterManual(user);
    await user.click(screen.getByRole('button', { name: 'Заполнить вручную' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Как переносим мероприятие?' }),
      'Перенести на 2 декабря 2099 года в 20:00',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await waitFor(() => expect(requests.some(({ path }) => path.endsWith('/prepare'))).toBe(true));
    expect(requests.find(({ method }) => method === 'PUT')!.body).toMatchObject({
      event_id: 'ceramics',
      proposed_start: '2099-12-01T19:00:00+03:00',
      context_event_id: 'ceramics',
      manual_fields: ['event_id', 'date', 'time'],
    });
  });

  it('частичная ручная дата раскрывается для исправления перед assistant submit и не теряется', async () => {
    const user = userEvent.setup();
    const requests = mockOrganizerApi(() => apiNotFound());
    open();
    await user.click(await screen.findByRole('button', { name: 'Заполнить вручную' }));
    fireEvent.change(screen.getByLabelText('Новая дата'), { target: { value: '2099-12-01' } });
    await user.click(screen.getByRole('button', { name: 'Заполнить вручную' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Как переносим мероприятие?' }),
      'Подготовить перенос',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    expect(await screen.findByLabelText('Новая дата')).toHaveValue('2099-12-01');
    expect(screen.getByLabelText('Новое время')).toHaveFocus();
    expect(requests.filter(({ method }) => method !== 'GET')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Заполнить вручную' }));
    expect(screen.getByRole('textbox', { name: 'Как переносим мероприятие?' })).toHaveValue(
      'Подготовить перенос',
    );
  });

  it('существующий UUID сохраняет ручные правки PATCH до нового prepare, используя revision сохранения', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
    let saved = draft({ revision: 0, proposed_start: null, subject: '', body: '' });
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'PUT') return Response.json(saved, { status: 201 });
      if (path === campaignPath && method === 'PATCH') {
        saved = manualDraft({
          revision: 2,
          subject: String(body.subject),
          body: String(body.body),
        });
        return Response.json(saved);
      }
      if (path.endsWith('/prepare')) {
        if (body.expected_revision === 0) {
          saved = { ...saved, revision: 1 };
          return Response.json(
            {
              detail: { code: 'ai_unavailable', message: 'Unavailable', related_campaign_id: null },
            },
            { status: 502 },
          );
        }
        return Response.json({
          outcome: 'applied',
          campaign: saved,
          fields_to_complete: [],
          clarifications: [],
          message: 'Подготовлено',
        });
      }
      return path === campaignPath ? Response.json(saved) : apiNotFound();
    });
    open();
    await user.type(
      await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' }),
      'Подготовить перенос',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await screen.findByRole('alert');
    await enterManual(user);
    await user.type(screen.getByLabelText('Тема'), 'Ручная тема');
    await user.click(screen.getByRole('button', { name: 'Заполнить вручную' }));
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await waitFor(() =>
      expect(requests.filter(({ path }) => path.endsWith('/prepare'))).toHaveLength(2),
    );
    const writes = requests.filter(({ method }) => method !== 'GET');
    expect(writes.map(({ method }) => method)).toEqual(['PUT', 'POST', 'PATCH', 'POST']);
    expect(writes[2]!.body).toMatchObject({
      event_id: 'ceramics',
      proposed_start: '2099-12-01T19:00:00+03:00',
      subject: 'Ручная тема',
      manual_fields: ['event_id', 'date', 'time'],
      expected_revision: 1,
    });
    expect(writes[3]!.body.expected_revision).toBe(2);
  });

  it('повторная одинаковая validation возвращает фокус с submit к запросу', async () => {
    const user = userEvent.setup();
    mockOrganizerApi(() => apiNotFound());
    open();
    const submit = await screen.findByRole('button', { name: 'Подготовить перенос' });
    await user.click(submit);
    expect(screen.getByRole('textbox', { name: 'Как переносим мероприятие?' })).toHaveFocus();
    await user.click(submit);
    expect(screen.getByRole('textbox', { name: 'Как переносим мероприятие?' })).toHaveFocus();
  });

  it('старый applied A после потерянного create и отказа PATCH B не считается успешным сохранением B', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
    let puts = 0;
    let reads = 0;
    const savedA = manualDraft();
    const requests = mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'PUT') {
        if (++puts === 1) throw new TypeError('Reply lost after save A');
        return Response.json(savedA);
      }
      if (path === campaignPath && method === 'GET') {
        if (++reads === 1) throw new TypeError('Initial readback lost');
        return Response.json(savedA);
      }
      if (method === 'PATCH') throw new TypeError('PATCH B failed before save');
      return apiNotFound();
    });
    open();
    await enterManual(user);
    await user.type(screen.getByLabelText('Тема'), 'Вариант А');
    await user.type(screen.getByLabelText('Текст письма'), 'Текст А');
    await user.click(screen.getByRole('button', { name: 'Сохранить подготовку' }));
    await screen.findByRole('alert');
    const subject = screen.getByLabelText('Тема');
    await user.clear(subject);
    await user.type(subject, 'Вариант Б');
    await user.click(screen.getByRole('button', { name: 'Сохранить подготовку' }));
    await waitFor(() => expect(requests.some(({ method }) => method === 'PATCH')).toBe(true));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Сохранить подготовку' })).toBeEnabled(),
    );
    expect(window.location.hash).toBe('#/organizer/transfer');
    expect(screen.getByLabelText('Тема')).toHaveValue('Вариант Б');
    expect(screen.getByText('Есть несохранённые изменения')).toBeVisible();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(2);
    expect(requests.filter(({ path }) => path.endsWith('/prepare'))).toHaveLength(0);
  });

  it.each([
    { lostReply: false, nextPrompt: 'Запрос Б' },
    { lostReply: true, nextPrompt: 'Запрос Б' },
    { lostReply: false, nextPrompt: '' },
    { lostReply: true, nextPrompt: '' },
  ])(
    'ручное сохранение запроса после отказа AI сохраняет новый ввод и явную очистку: %j',
    async ({ lostReply, nextPrompt }) => {
      const user = userEvent.setup();
      vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
      let saved = manualDraft();
      saved = {
        ...saved,
        assistant_state: {
          ...saved.assistant_state!,
          mode: 'assistant',
          stage: 'intake',
          original_prompt: 'Запрос А',
          intake_revision: 0,
          applied_revision: null,
        },
      };
      const requests = mockOrganizerApi(({ path, method, body }) => {
        if (path === campaignPath && method === 'PUT') return Response.json(saved, { status: 201 });
        if (path.endsWith('/prepare')) {
          saved = {
            ...saved,
            revision: 1,
            assistant_state: { ...saved.assistant_state!, stage: 'failed', intake_revision: 1 },
          };
          return Response.json(
            {
              detail: { code: 'ai_unavailable', message: 'Unavailable', related_campaign_id: null },
            },
            { status: 502 },
          );
        }
        if (path === campaignPath && method === 'PATCH') {
          saved = manualDraft({
            revision: 2,
            subject: String(body.subject),
            body: String(body.body),
          });
          saved = {
            ...saved,
            assistant_state: {
              ...saved.assistant_state!,
              original_prompt: typeof body.prompt === 'string' ? body.prompt : 'Запрос А',
              applied_revision: 2,
            },
          };
          if (lostReply) throw new TypeError('PATCH reply lost after save');
          return Response.json(saved);
        }
        return path === campaignPath ? Response.json(saved) : apiNotFound();
      });
      open();
      await user.type(
        await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' }),
        'Запрос А',
      );
      await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
      await screen.findByRole('alert');
      const prompt = screen.getByRole('textbox', { name: 'Как переносим мероприятие?' });
      await user.clear(prompt);
      if (nextPrompt) await user.type(prompt, nextPrompt);
      await enterManual(user);
      await user.type(screen.getByLabelText('Тема'), 'Ручная тема');
      await user.type(screen.getByLabelText('Текст письма'), 'Ручной текст');
      await user.click(screen.getByRole('button', { name: 'Сохранить подготовку' }));
      await waitFor(() => expect(window.location.hash).toBe(`#/organizer/campaigns/${campaignId}`));
      await user.click(await screen.findByRole('button', { name: 'Изменить запрос' }));
      expect(screen.getByRole('textbox', { name: 'Как переносим мероприятие?' })).toHaveValue(
        nextPrompt,
      );
      expect(requests.find(({ method }) => method === 'PATCH')!.body).toHaveProperty(
        'prompt',
        nextPrompt,
      );
      expect(requests.filter(({ path }) => path.endsWith('/prepare'))).toHaveLength(1);
    },
  );

  it('PATCH с опущенным prompt сохраняет исходный запрос A и не подставляет пустую строку', async () => {
    const saved = manualDraft();
    saved.assistant_state!.original_prompt = 'Запрос А';
    const requests = mockOrganizerApi(({ method }) =>
      method === 'PATCH' ? Response.json(saved) : apiNotFound(),
    );
    const result = await saveCampaign(campaignId, {
      expected_revision: 0,
      event_id: saved.event_id,
      proposed_start: saved.proposed_start,
      subject: saved.subject,
      body: saved.body,
      text_reviewed: false,
    });
    expect(requests[0]!.body).not.toHaveProperty('prompt');
    expect(result.assistant_state!.original_prompt).toBe('Запрос А');
  });

  it('readback ручного PATCH с прежним prompt A не объявляет несохранённый B успешным', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
    let saved = manualDraft();
    saved = {
      ...saved,
      assistant_state: {
        ...saved.assistant_state!,
        original_prompt: 'Запрос А',
        mode: 'assistant',
        stage: 'intake',
        applied_revision: null,
      },
    };
    mockOrganizerApi(({ path, method, body }) => {
      if (method === 'PUT') return Response.json(saved, { status: 201 });
      if (path.endsWith('/prepare')) {
        saved = {
          ...saved,
          revision: 1,
          assistant_state: { ...saved.assistant_state!, stage: 'failed' },
        };
        return Response.json(
          { detail: { code: 'ai_unavailable', message: 'Unavailable', related_campaign_id: null } },
          { status: 502 },
        );
      }
      if (method === 'PATCH') {
        saved = manualDraft({
          revision: 2,
          subject: String(body.subject),
          body: String(body.body),
        });
        saved.assistant_state!.original_prompt = 'Запрос А';
        saved.assistant_state!.applied_revision = 2;
        throw new TypeError('PATCH reply lost');
      }
      return path === campaignPath ? Response.json(saved) : apiNotFound();
    });
    open();
    await user.type(
      await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' }),
      'Запрос А',
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    await screen.findByRole('alert');
    const prompt = screen.getByRole('textbox', { name: 'Как переносим мероприятие?' });
    await user.clear(prompt);
    await user.type(prompt, 'Запрос Б');
    await enterManual(user);
    await user.type(screen.getByLabelText('Тема'), 'Ручная тема');
    await user.click(screen.getByRole('button', { name: 'Сохранить подготовку' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Сохранить подготовку' })).toBeEnabled(),
    );
    expect(window.location.hash).toBe('#/organizer/transfer');
    expect(screen.getByText('Есть несохранённые изменения')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Заполнить вручную' }));
    expect(screen.getByRole('textbox', { name: 'Как переносим мероприятие?' })).toHaveValue(
      'Запрос Б',
    );
  });
});
