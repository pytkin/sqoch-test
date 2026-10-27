import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import type { AssistantState, CampaignDetail } from '../../api/generated/types.gen';
import {
  apiNotFound,
  campaignId,
  campaignPath,
  draft,
  mockOrganizerApi,
  preview,
} from './test-fixtures';

function state(overrides: Partial<AssistantState> = {}): AssistantState {
  return {
    version: 1,
    mode: 'assistant',
    stage: 'applied',
    original_prompt: 'Перенести Керамику на 20 ноября 2099 года в 19:00',
    answers: {},
    context_event_id: 'ceramics',
    partial_date: { year: 2099, month: 11, day: 20, hour: 19, minute: 0 },
    year_source: 'explicit',
    manual_fields: [],
    clarifications: [],
    intake_revision: 4,
    applied_revision: 5,
    ...overrides,
  };
}
function saved(overrides: Partial<CampaignDetail> = {}) {
  return draft({ assistant_state: state(), ...overrides });
}
function open() {
  window.history.replaceState(null, '', `/#/organizer/campaigns/${campaignId}`);
  render(<App />);
}
function applied(campaign: CampaignDetail) {
  return Response.json({
    outcome: 'applied',
    campaign,
    clarifications: [],
    fields_to_complete: [],
    message: 'Перенос подготовлен',
  });
}
afterEach(() => window.history.replaceState(null, '', '/'));

describe('SQOCH-43: последовательная подготовка сохранённого переноса', () => {
  it('applied показывает сводку без пустых редакторов, а редактор открывается адресно', async () => {
    const user = userEvent.setup();
    const requests = mockOrganizerApi(({ path }) =>
      path === campaignPath ? Response.json(saved()) : apiNotFound(),
    );
    open();
    await screen.findByRole('heading', { name: 'Проверьте перенос', level: 1 });
    expect(screen.queryByLabelText('Новая дата')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Тема' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: 'Что изменить с помощником?' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(draft().body)).toBeVisible();
    expect(
      screen.getByRole('checkbox', { name: 'Текст соответствует мероприятию и новой дате' }),
    ).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Изменить мероприятие и дату' }));
    expect(screen.getByLabelText('Новая дата')).toHaveFocus();
    expect(screen.queryByLabelText('Тема')).not.toBeInTheDocument();
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('needs_input спрашивает только год и отправляет typed answer без повторного prompt', async () => {
    const user = userEvent.setup();
    let current = saved({
      proposed_start: null,
      subject: '',
      body: '',
      assistant_state: state({
        stage: 'needs_input',
        partial_date: { year: null, month: 11, day: 20, hour: 19, minute: 0 },
        year_source: null,
        clarifications: [{ field: 'year', reason: 'past', candidate_event_id: null }],
      }),
    });
    const requests = mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'PATCH') {
        current = { ...current, revision: 6 };
        return Response.json(current);
      }
      if (path.endsWith('/prepare')) {
        current = saved({ revision: 8 });
        return applied(current);
      }
      return path === campaignPath ? Response.json(current) : apiNotFound();
    });
    open();
    await screen.findByRole('heading', { name: 'Уточните год' });
    const year = screen.getByRole('textbox', { name: 'В каком году состоится мероприятие?' });
    expect(screen.queryByRole('combobox', { name: 'Мероприятие' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Новая дата')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Новое время')).not.toBeInTheDocument();
    expect(screen.getByText(current.assistant_state!.original_prompt)).toBeVisible();
    await user.type(year, '2100');
    await user.click(screen.getByRole('button', { name: 'Продолжить подготовку' }));
    await screen.findByRole('heading', { name: 'Проверьте перенос' });
    const request = requests.find(({ path }) => path.endsWith('/prepare'))!;
    expect(request.body.answers).toEqual({ year: 2100 });
    expect(request.body).not.toHaveProperty('prompt');
  });

  it('candidate event не принимается автоматически, explicit answer сохраняет исходный запрос', async () => {
    const user = userEvent.setup();
    let current = saved({
      assistant_state: state({
        stage: 'needs_input',
        clarifications: [{ field: 'event_id', reason: 'conflict', candidate_event_id: 'painting' }],
      }),
    });
    const requests = mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'PATCH') {
        current = { ...current, revision: 6 };
        return Response.json(current);
      }
      if (path.endsWith('/prepare')) return applied(saved({ event_id: 'painting', revision: 8 }));
      return path === campaignPath ? Response.json(current) : apiNotFound();
    });
    open();
    const select = await screen.findByRole('combobox', { name: 'Мероприятие' });
    expect(select).toHaveValue('');
    expect(requests.filter(({ method }) => method !== 'GET')).toHaveLength(0);
    await user.selectOptions(select, 'painting');
    await user.click(screen.getByRole('button', { name: 'Продолжить подготовку' }));
    await screen.findByRole('heading', { name: 'Проверьте перенос' });
    expect(requests.find(({ path }) => path.endsWith('/prepare'))!.body).toMatchObject({
      answers: { event_id: 'painting' },
    });
    expect(requests.find(({ path }) => path.endsWith('/prepare'))!.body).not.toHaveProperty(
      'prompt',
    );
  });

  it.each([
    { field: 'time', failure: false },
    { field: 'time', failure: true },
    { field: 'event_id', failure: false },
    { field: 'event_id', failure: true },
  ] as const)(
    'уточнение сохраняет вопрос, ответ и dirty до завершения prepare: %j',
    async ({ field, failure }) => {
      const user = userEvent.setup();
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
      const label = field === 'time' ? 'Новое время' : 'Мероприятие';
      const value = field === 'time' ? '19:30' : 'painting';
      let current = saved({
        proposed_start: null,
        subject: '',
        body: '',
        assistant_state: state({
          stage: 'needs_input',
          year_source: field === 'time' ? null : 'explicit',
          partial_date: {
            year: field === 'time' ? null : 2099,
            month: 11,
            day: 20,
            hour: field === 'time' ? null : 19,
            minute: field === 'time' ? null : 0,
          },
          clarifications: [
            {
              field,
              reason: field === 'time' ? 'missing' : 'conflict',
              candidate_event_id: field === 'event_id' ? 'painting' : null,
            },
          ],
        }),
      });
      let finish!: (response: Response) => void;
      let reject!: (error: Error) => void;
      const response = new Promise<Response>((resolve, rejectResponse) => {
        finish = resolve;
        reject = rejectResponse;
      });
      const requests = mockOrganizerApi(({ path, method }) => {
        if (path === campaignPath && method === 'PATCH') {
          // The ordinary save has not persisted the new answer; prepare owns its intake.
          current = { ...current, revision: 6 };
          return Response.json(current);
        }
        if (path.endsWith('/prepare')) return response;
        return path === campaignPath ? Response.json(current) : apiNotFound();
      });
      open();
      const control = await screen.findByLabelText(label);
      if (field === 'time') fireEvent.change(control, { target: { value } });
      else await user.selectOptions(control, value);
      await user.click(screen.getByRole('button', { name: 'Продолжить подготовку' }));
      await waitFor(() =>
        expect(requests.some(({ path }) => path.endsWith('/prepare'))).toBe(true),
      );
      expect(screen.getByLabelText(label)).toHaveValue(value);
      expect(screen.getByLabelText(label)).toBeDisabled();
      expect(
        screen.queryByLabelText('В каком году состоится мероприятие?'),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Уточните перенос' })).toBeVisible();
      expect(
        screen.getByText(
          'Уточняем сведения и готовим перенос. Ответ помощника может занять до минуты.',
        ),
      ).toBeVisible();
      await user.click(screen.getByRole('link', { name: 'Билеты' }));
      await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
      expect(window.location.hash).toBe(`#/organizer/campaigns/${campaignId}`);
      expect(requests.find(({ path }) => path.endsWith('/prepare'))!.body.answers).toEqual({
        [field]: value,
      });

      if (failure) {
        reject(new TypeError('Request failed before intake'));
        await screen.findByRole('alert');
        expect(screen.getByLabelText(label)).toHaveValue(value);
        expect(screen.getByLabelText(label)).not.toBeDisabled();
        expect(
          screen.queryByLabelText('В каком году состоится мероприятие?'),
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole('link', { name: 'Билеты' }));
        await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(2));
        expect(window.location.hash).toBe(`#/organizer/campaigns/${campaignId}`);
      } else {
        current = saved({
          revision: 8,
          event_id: field === 'event_id' ? 'painting' : 'ceramics',
          proposed_start: field === 'time' ? '2099-11-20T19:30:00+03:00' : draft().proposed_start,
          assistant_state: state({
            answers: field === 'time' ? { time: value } : { event_id: value },
            context_event_id: field === 'event_id' ? 'painting' : 'ceramics',
            partial_date: {
              year: 2099,
              month: 11,
              day: 20,
              hour: 19,
              minute: field === 'time' ? 30 : 0,
            },
            intake_revision: 7,
            applied_revision: 8,
          }),
        });
        finish(applied(current));
        await screen.findByRole('heading', { name: 'Проверьте перенос' });
        expect(
          screen.queryByText(
            'Уточняем сведения и готовим перенос. Ответ помощника может занять до минуты.',
          ),
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole('link', { name: 'Билеты' }));
        await screen.findByRole('heading', { name: 'Оформление билетов' });
        expect(window.confirm).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(['intake', 'failed'] as const)(
    'reload %s показывает прошлый результат с предупреждением и не повторяет AI',
    async (stage) => {
      const current = saved({
        revision: 7,
        assistant_state: state({
          stage,
          original_prompt: 'Новый запрос ещё не подготовлен',
          intake_revision: 7,
          applied_revision: 5,
        }),
      });
      const requests = mockOrganizerApi(({ path }) =>
        path === campaignPath ? Response.json(current) : apiNotFound(),
      );
      open();
      expect(await screen.findByText(/Показан предыдущий результат/)).toBeVisible();
      expect(screen.getByRole('textbox', { name: 'Как переносим мероприятие?' })).toHaveValue(
        'Новый запрос ещё не подготовлен',
      );
      expect(screen.queryByRole('button', { name: 'Проверить перенос' })).not.toBeInTheDocument();
      expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    },
  );

  it.each(['time', 'event_id'] as const)(
    'readback подтверждает сохранение ответа %s в intake без повторного AI и ложного dirty',
    async (field) => {
      const user = userEvent.setup();
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
      const label = field === 'time' ? 'Новое время' : 'Мероприятие';
      const answer = field === 'time' ? '19:30' : 'painting';
      let current = saved({
        proposed_start: null,
        subject: '',
        body: '',
        assistant_state: state({
          stage: 'needs_input',
          clarifications: [
            {
              field,
              reason: field === 'time' ? 'missing' : 'conflict',
              candidate_event_id: field === 'event_id' ? 'painting' : null,
            },
          ],
        }),
      });
      const requests = mockOrganizerApi(({ path, method }) => {
        if (path === campaignPath && method === 'PATCH') {
          current = { ...current, revision: 6 };
          return Response.json(current);
        }
        if (path.endsWith('/prepare')) {
          current = {
            ...current,
            revision: 7,
            assistant_state: {
              ...current.assistant_state!,
              stage: 'intake',
              clarifications: [],
              answers: { [field]: answer },
              intake_revision: 7,
            },
          };
          throw new TypeError('Reply lost after durable intake');
        }
        return path === campaignPath ? Response.json(current) : apiNotFound();
      });
      open();
      const control = await screen.findByLabelText(label);
      if (field === 'time') fireEvent.change(control, { target: { value: answer } });
      else await user.selectOptions(control, answer);
      await user.click(screen.getByRole('button', { name: 'Продолжить подготовку' }));
      await screen.findByRole('alert');
      expect(screen.getByText(/Подготовка не завершена. Повторите запрос явно/)).toBeVisible();
      expect(
        screen.queryByLabelText('В каком году состоится мероприятие?'),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole('link', { name: 'Билеты' }));
      await screen.findByRole('heading', { name: 'Оформление билетов' });
      expect(window.confirm).not.toHaveBeenCalled();
      expect(requests.filter(({ path }) => path.endsWith('/prepare'))).toHaveLength(1);
    },
  );

  it.each([
    { observedTime: '19:30', intakeRevision: 7, recovered: true },
    { observedTime: '20:00', intakeRevision: 7, recovered: false },
    { observedTime: '19:30', intakeRevision: 6, recovered: false },
  ])(
    'final readback восстанавливает только собственный ответ на уточнение: %j',
    async ({ observedTime, intakeRevision, recovered }) => {
      const user = userEvent.setup();
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
      const originalPrompt = 'Перенести Керамику на 20 ноября 2099 года';
      let current = saved({
        proposed_start: null,
        subject: '',
        body: '',
        assistant_state: state({
          stage: 'needs_input',
          original_prompt: originalPrompt,
          partial_date: { year: 2099, month: 11, day: 20, hour: null, minute: null },
          clarifications: [{ field: 'time', reason: 'missing', candidate_event_id: null }],
        }),
      });
      const requests = mockOrganizerApi(({ path, method }) => {
        if (path === campaignPath && method === 'PATCH') {
          current = { ...current, revision: 6 };
          return Response.json(current);
        }
        if (path.endsWith('/prepare')) {
          current = saved({
            revision: 8,
            proposed_start: `2099-11-20T${observedTime}:00+03:00`,
            assistant_state: state({
              original_prompt: originalPrompt,
              answers: { time: observedTime },
              partial_date: {
                year: 2099,
                month: 11,
                day: 20,
                hour: observedTime === '19:30' ? 19 : 20,
                minute: observedTime === '19:30' ? 30 : 0,
              },
              intake_revision: intakeRevision,
              applied_revision: 8,
            }),
          });
          throw new TypeError('Own request failed; a same-prompt result is visible on GET');
        }
        return path === campaignPath ? Response.json(current) : apiNotFound();
      });
      open();
      fireEvent.change(await screen.findByLabelText('Новое время'), {
        target: { value: '19:30' },
      });
      await user.click(screen.getByRole('button', { name: 'Продолжить подготовку' }));

      if (recovered) {
        expect(await screen.findByRole('heading', { name: 'Проверьте перенос' })).toBeVisible();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByText('19:30 по Москве')).toBeVisible();
        await user.click(screen.getByRole('link', { name: 'Билеты' }));
        await screen.findByRole('heading', { name: 'Оформление билетов' });
        expect(window.confirm).not.toHaveBeenCalled();
      } else {
        expect(await screen.findByRole('alert')).toBeVisible();
        expect(
          screen.queryByText('Сохранённый результат подготовки восстановлен'),
        ).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Уточните перенос' })).toBeVisible();
        expect(screen.getByLabelText('Новое время')).toHaveValue('19:30');
        expect(screen.getByLabelText('Новое время')).not.toBeDisabled();
        expect(screen.getByRole('button', { name: 'Обновить сведения' })).toBeVisible();
        await user.click(screen.getByRole('link', { name: 'Билеты' }));
        await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
        expect(window.location.hash).toBe(`#/organizer/campaigns/${campaignId}`);
      }
      expect(requests.filter(({ path }) => path.endsWith('/prepare'))).toHaveLength(1);
      expect(requests.find(({ path }) => path.endsWith('/prepare'))!.body.answers).toEqual({
        time: '19:30',
      });
    },
  );

  it('обычная отметка проверки не переключает assistant в manual и не меняет ISO с секундами', async () => {
    const user = userEvent.setup();
    let current = saved({ proposed_start: '2099-11-20T19:00:45.123456+03:00' });
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'PATCH') {
        current = {
          ...current,
          revision: 6,
          text_reviewed: true,
          reviewed_event_revision: 0,
          proposed_start: String(body.proposed_start),
        };
        return Response.json(current);
      }
      if (path.endsWith('/preview')) return Response.json(preview(current));
      return path === campaignPath ? Response.json(current) : apiNotFound();
    });
    open();
    await user.click(
      await screen.findByRole('checkbox', { name: 'Текст соответствует мероприятию и новой дате' }),
    );
    await user.click(screen.getByRole('button', { name: 'Проверить перенос' }));
    await screen.findByRole('heading', { name: 'Подтвердите перенос' });
    const request = requests.find(({ method }) => method === 'PATCH')!;
    expect(request.body.proposed_start).toBe('2099-11-20T19:00:45.123456+03:00');
    expect(request.body).not.toHaveProperty('mode');
    expect(request.body.manual_fields ?? []).toEqual([]);
    expect(
      screen.getByRole('button', { name: 'Подтвердить перенос и уведомить покупателей' }),
    ).toBeVisible();
  });

  it('явное сохранение только текста ставит manual, а структурированные поля не объявляет ручными', async () => {
    const user = userEvent.setup();
    let current = saved();
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'PATCH') {
        current = saved({
          revision: 6,
          body: String(body.body),
          assistant_state: state({ mode: 'manual', applied_revision: 6 }),
        });
        return Response.json(current);
      }
      return path === campaignPath ? Response.json(current) : apiNotFound();
    });
    open();
    await user.click(await screen.findByRole('button', { name: 'Изменить уведомление' }));
    await user.type(screen.getByLabelText('Текст письма'), ' Новая фраза');
    await user.click(screen.getByRole('button', { name: 'Сохранить подготовку' }));
    await waitFor(() => expect(requests.some(({ method }) => method === 'PATCH')).toBe(true));
    expect(requests.find(({ method }) => method === 'PATCH')!.body).toMatchObject({
      mode: 'manual',
      manual_fields: [],
    });
  });

  it('только реальная правка даты передаёт manual_fields и заменяет canonical ISO', async () => {
    const user = userEvent.setup();
    let current = saved({ proposed_start: '2099-11-20T19:00:45.123456+03:00' });
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'PATCH') {
        current = { ...current, revision: 6, proposed_start: String(body.proposed_start) };
        return Response.json(current);
      }
      return path === campaignPath ? Response.json(current) : apiNotFound();
    });
    open();
    await user.click(await screen.findByRole('button', { name: 'Изменить мероприятие и дату' }));
    fireEvent.change(screen.getByLabelText('Новая дата'), { target: { value: '2099-11-21' } });
    await user.click(screen.getByRole('button', { name: 'Сохранить подготовку' }));
    await waitFor(() => expect(requests.some(({ method }) => method === 'PATCH')).toBe(true));
    expect(requests.find(({ method }) => method === 'PATCH')!.body).toMatchObject({
      proposed_start: '2099-11-21T19:00:00+03:00',
      manual_fields: ['date'],
    });
  });

  it('reload сохраняет введённый ответ на ещё не разрешённый вопрос', async () => {
    const current = saved({
      proposed_start: null,
      assistant_state: state({
        stage: 'needs_input',
        answers: { year: 2098 },
        year_source: null,
        partial_date: { year: null, month: 11, day: 20, hour: 19, minute: 0 },
        clarifications: [{ field: 'year', reason: 'past', candidate_event_id: null }],
      }),
    });
    mockOrganizerApi(({ path }) =>
      path === campaignPath ? Response.json(current) : apiNotFound(),
    );
    open();
    expect(
      await screen.findByRole('textbox', { name: 'В каком году состоится мероприятие?' }),
    ).toHaveValue('2098');
  });

  it('введённое уточнение защищено от ухода и повторная ошибка возвращает фокус к тому же полю', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    const current = saved({
      proposed_start: null,
      assistant_state: state({
        stage: 'needs_input',
        clarifications: [{ field: 'year', reason: 'missing', candidate_event_id: null }],
      }),
    });
    const requests = mockOrganizerApi(({ path }) =>
      path === campaignPath ? Response.json(current) : apiNotFound(),
    );
    open();
    const year = await screen.findByRole('textbox', {
      name: 'В каком году состоится мероприятие?',
    });
    await user.type(year, '20');
    await user.click(screen.getByRole('button', { name: 'Продолжить подготовку' }));
    expect(year).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Продолжить подготовку' }));
    expect(year).toHaveFocus();
    await user.click(screen.getByRole('link', { name: 'Билеты' }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    expect(year).toHaveValue('20');
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('ошибка rewrite после сохранения остаётся у редактора, текст и canonical дата сохраняются', async () => {
    const user = userEvent.setup();
    let current = saved({ proposed_start: '2099-11-20T19:00:45.123456+03:00' });
    const requests = mockOrganizerApi(({ path, method, body }) => {
      if (path === campaignPath && method === 'PATCH') {
        current = { ...current, revision: 6, body: String(body.body) };
        return Response.json(current);
      }
      if (path.endsWith('/rewrite'))
        return Response.json(
          { detail: { code: 'ai_unavailable', message: 'Unavailable', related_campaign_id: null } },
          { status: 502 },
        );
      return path === campaignPath ? Response.json(current) : apiNotFound();
    });
    open();
    await user.click(await screen.findByRole('button', { name: 'Изменить уведомление' }));
    await user.type(screen.getByLabelText('Текст письма'), ' Мои правки');
    await user.type(screen.getByLabelText('Что изменить с помощником?'), 'Сократить');
    await user.click(screen.getByRole('button', { name: 'Изменить текст' }));
    const error = await screen.findByRole('alert');
    expect(error).toHaveFocus();
    expect(screen.getByLabelText('Текст письма')).toHaveValue(draft().body + ' Мои правки');
    expect(screen.getByLabelText('Что изменить с помощником?')).toHaveValue('Сократить');
    expect(requests.find(({ method }) => method === 'PATCH')!.body.proposed_start).toBe(
      '2099-11-20T19:00:45.123456+03:00',
    );
  });

  it('успешный rewrite оставляет новый текст и обратную связь видимыми с фокусом в редакторе', async () => {
    const user = userEvent.setup();
    let current = saved();
    mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'PATCH') {
        current = { ...current, revision: 6 };
        return Response.json(current);
      }
      if (path.endsWith('/rewrite')) {
        current = saved({ revision: 7, body: 'Короткое письмо после правки' });
        return Response.json({
          campaign: current,
          outcome: 'applied',
          clarifications: [],
          fields_to_complete: [],
          message: 'Текст изменён',
        });
      }
      return path === campaignPath ? Response.json(current) : apiNotFound();
    });
    open();
    await user.click(await screen.findByRole('button', { name: 'Изменить уведомление' }));
    await user.type(screen.getByLabelText('Что изменить с помощником?'), 'Сократить письмо');
    await user.click(screen.getByRole('button', { name: 'Изменить текст' }));
    const body = await screen.findByRole('textbox', { name: 'Текст письма' });
    await waitFor(() => expect(body).toHaveValue('Короткое письмо после правки'));
    expect(body).toHaveFocus();
    expect(screen.getByText('Текст изменён')).toBeVisible();
  });

  it('rewrite сообщает о работе и после промежуточного сохранения со свёрнутым редактором', async () => {
    const user = userEvent.setup();
    let current = saved();
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const requests = mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'PATCH') {
        current = { ...current, revision: 6 };
        return Response.json(current);
      }
      if (path.endsWith('/rewrite')) return response;
      return path === campaignPath ? Response.json(current) : apiNotFound();
    });
    open();
    await user.click(await screen.findByRole('button', { name: 'Изменить уведомление' }));
    await user.type(screen.getByLabelText('Что изменить с помощником?'), 'Сократить письмо');
    await user.click(screen.getByRole('button', { name: 'Изменить текст' }));
    await waitFor(() => expect(requests.some(({ path }) => path.endsWith('/rewrite'))).toBe(true));
    expect(screen.queryByLabelText('Что изменить с помощником?')).not.toBeInTheDocument();
    const status = screen.getByText(
      'Обновляем текст уведомления. Ответ помощника может занять до минуты.',
    );
    expect(status).toBeVisible();
    expect(status).toHaveRole('status');
    expect(screen.getByRole('button', { name: 'Изменить уведомление' })).toBeDisabled();
    current = saved({ revision: 7, body: 'Новое короткое уведомление' });
    finish(applied(current));
    await waitFor(() =>
      expect(screen.getByLabelText('Текст письма')).toHaveValue('Новое короткое уведомление'),
    );
    expect(status).not.toBeInTheDocument();
    expect(screen.getByLabelText('Текст письма')).toHaveFocus();
  });

  it.each([
    { focusNavigation: false, lostReply: false },
    { focusNavigation: true, lostReply: false },
    { focusNavigation: false, lostReply: true },
    { focusNavigation: true, lostReply: true },
  ])(
    'time-only prepare фокусирует видимое уточнение и сохраняет осознанный фокус навигации: %j',
    async ({ focusNavigation, lostReply }) => {
      const user = userEvent.setup();
      let current = saved();
      let finish!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const requests = mockOrganizerApi(({ path, method }) => {
        if (path === campaignPath && method === 'PATCH') {
          current = { ...current, revision: 6 };
          return Response.json(current);
        }
        if (path.endsWith('/prepare'))
          return response.then((result) => {
            if (lostReply) throw new TypeError('Reply lost after needs_input');
            return result;
          });
        return path === campaignPath ? Response.json(current) : apiNotFound();
      });
      open();
      await user.click(await screen.findByRole('button', { name: 'Изменить запрос' }));
      await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
      await waitFor(() =>
        expect(requests.some(({ path }) => path.endsWith('/prepare'))).toBe(true),
      );
      const navigation = screen.getByRole('link', { name: 'Мероприятия' });
      if (focusNavigation) navigation.focus();
      current = saved({
        revision: 8,
        proposed_start: null,
        assistant_state: state({
          stage: 'needs_input',
          partial_date: { year: 2099, month: 11, day: 20, hour: null, minute: null },
          clarifications: [{ field: 'time', reason: 'missing', candidate_event_id: null }],
          intake_revision: 7,
          applied_revision: 8,
        }),
      });
      finish(
        Response.json({
          campaign: current,
          outcome: 'needs_input',
          clarifications: current.assistant_state!.clarifications,
          fields_to_complete: ['proposed_start'],
          message: 'Укажите время',
        }),
      );
      const time = await screen.findByLabelText('Новое время');
      expect(screen.queryByLabelText('Новая дата')).not.toBeInTheDocument();
      if (focusNavigation) expect(navigation).toHaveFocus();
      else await waitFor(() => expect(time).toHaveFocus());
    },
  );

  it.each(['past', 'conflict', 'invalid'] as const)(
    'year %s объясняет причину в доступном описании, сохраняя день/время и полный контекст',
    async (reason) => {
      const current = saved({
        proposed_start: null,
        assistant_state: state({
          stage: 'needs_input',
          year_source: null,
          partial_date: { year: null, month: 11, day: 20, hour: 19, minute: 0 },
          clarifications: [{ field: 'year', reason, candidate_event_id: null }],
        }),
      });
      mockOrganizerApi(({ path }) =>
        path === campaignPath ? Response.json(current) : apiNotFound(),
      );
      open();
      const year = await screen.findByRole('textbox', {
        name: 'В каком году состоится мероприятие?',
      });
      expect(year).toHaveAccessibleDescription(/год.*День и время сохранены/s);
      expect(year).not.toHaveAccessibleDescription(/Уточните будущую дату/);
      expect(screen.getByText(/Сейчас:.*10 ноября 2099/)).toBeVisible();
      expect(screen.getByText('20 ноября')).toBeVisible();
      expect(screen.getByText('19:00 по Москве')).toBeVisible();
    },
  );

  it('event conflict связывает с control и причину, и предложение кандидата, включая локальную ошибку', async () => {
    const user = userEvent.setup();
    const current = saved({
      assistant_state: state({
        stage: 'needs_input',
        clarifications: [{ field: 'event_id', reason: 'conflict', candidate_event_id: 'painting' }],
      }),
    });
    const requests = mockOrganizerApi(({ path }) =>
      path === campaignPath ? Response.json(current) : apiNotFound(),
    );
    open();
    const event = await screen.findByRole('combobox', { name: 'Мероприятие' });
    expect(event).toHaveAccessibleDescription(/Живопись.*противореч/s);
    await user.click(screen.getByRole('button', { name: 'Продолжить подготовку' }));
    expect(event).toHaveAccessibleDescription(/Выберите мероприятие.*Живопись.*противореч/s);
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('первый переход TransferStart → сохранённый applied перенос фокусирует готовый заголовок', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(campaignId);
    let current = saved({
      revision: 0,
      proposed_start: null,
      subject: '',
      body: '',
      assistant_state: state({ stage: 'intake', intake_revision: 0, applied_revision: null }),
    });
    const requests = mockOrganizerApi(({ path, method }) => {
      if (path === campaignPath && method === 'PUT') return Response.json(current, { status: 201 });
      if (path.endsWith('/prepare')) {
        current = saved({
          revision: 2,
          assistant_state: state({ intake_revision: 1, applied_revision: 2 }),
        });
        return applied(current);
      }
      return path === campaignPath ? Response.json(current) : apiNotFound();
    });
    window.history.replaceState(null, '', '/#/organizer/transfer');
    render(<App />);
    await user.type(
      await screen.findByRole('textbox', { name: 'Как переносим мероприятие?' }),
      current.assistant_state!.original_prompt,
    );
    await user.click(screen.getByRole('button', { name: 'Подготовить перенос' }));
    const heading = await screen.findByRole('heading', { name: 'Проверьте перенос', level: 1 });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(window.location.hash).toBe(`#/organizer/campaigns/${campaignId}`);
    expect(requests.filter(({ method }) => method !== 'GET').map(({ method }) => method)).toEqual([
      'PUT',
      'POST',
    ]);
  });

  it.each([
    { stage: 'applied', focusNavigation: false },
    { stage: 'year', focusNavigation: false },
    { stage: 'time', focusNavigation: false },
    { stage: 'applied', focusNavigation: true },
    { stage: 'year', focusNavigation: true },
    { stage: 'time', focusNavigation: true },
  ] as const)(
    'первый deferred GET ставит фокус в видимый %j и сохраняет осознанный фокус навигации',
    async ({ stage, focusNavigation }) => {
      let finish!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const current =
        stage === 'applied'
          ? saved()
          : saved({
              proposed_start: null,
              assistant_state: state({
                stage: 'needs_input',
                year_source: stage === 'year' ? null : 'explicit',
                partial_date: {
                  year: stage === 'year' ? null : 2099,
                  month: 11,
                  day: 20,
                  hour: stage === 'time' ? null : 19,
                  minute: stage === 'time' ? null : 0,
                },
                clarifications: [{ field: stage, reason: 'missing', candidate_event_id: null }],
              }),
            });
      const requests = mockOrganizerApi(({ path }) =>
        path === campaignPath ? response : apiNotFound(),
      );
      open();
      const navigation = screen.getByRole('link', { name: 'Мероприятия' });
      if (focusNavigation) navigation.focus();
      finish(Response.json(current));
      const target =
        stage === 'applied'
          ? await screen.findByRole('heading', { name: 'Проверьте перенос', level: 1 })
          : stage === 'year'
            ? await screen.findByRole('textbox', { name: 'В каком году состоится мероприятие?' })
            : await screen.findByLabelText('Новое время');
      if (focusNavigation) expect(navigation).toHaveFocus();
      else await waitFor(() => expect(target).toHaveFocus());
      expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    },
  );

  it.each([false, true])(
    'сохранение текста с закрытием редактора фокусирует видимый результат и сохраняет фокус навигации: %s',
    async (focusNavigation) => {
      const user = userEvent.setup();
      let current = saved();
      let finish!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const requests = mockOrganizerApi(({ path, method, body }) => {
        if (path === campaignPath && method === 'PATCH') {
          current = saved({
            revision: 6,
            body: String(body.body),
            assistant_state: state({ mode: 'manual', applied_revision: 6 }),
          });
          return response;
        }
        return path === campaignPath ? Response.json(current) : apiNotFound();
      });
      open();
      await user.click(await screen.findByRole('button', { name: 'Изменить уведомление' }));
      await user.type(screen.getByLabelText('Текст письма'), ' Изменение');
      await user.click(screen.getByRole('button', { name: 'Сохранить подготовку' }));
      await waitFor(() => expect(requests.some(({ method }) => method === 'PATCH')).toBe(true));
      const navigation = screen.getByRole('link', { name: 'Мероприятия' });
      if (focusNavigation) navigation.focus();
      finish(Response.json(current));
      await waitFor(() => expect(screen.queryByLabelText('Текст письма')).not.toBeInTheDocument());
      const message = screen
        .getAllByText('Подготовка сохранена')
        .find((element) => element.tagName === 'OUTPUT');
      expect(message).toBeVisible();
      expect(screen.getAllByText('Подготовка сохранена')).toHaveLength(1);
      if (focusNavigation) expect(navigation).toHaveFocus();
      else
        expect(screen.getByRole('heading', { name: 'Проверьте перенос', level: 1 })).toHaveFocus();
      await user.click(
        screen.getByRole('checkbox', { name: 'Текст соответствует мероприятию и новой дате' }),
      );
      expect(screen.getByText('Есть несохранённые изменения')).toBeVisible();
      expect(screen.queryByText('Подготовка сохранена')).not.toBeInTheDocument();
    },
  );

  it.each([false, true])(
    'обновление prepared после конфликта фокусирует видимую сводку и не перехватывает навигацию: %s',
    async (focusNavigation) => {
      const user = userEvent.setup();
      const canonicalStart = '2099-11-20T19:00:45.123456+03:00';
      const localBody = 'Мой текст, сохранённый в форме до конфликта';
      let current = saved({ proposed_start: canonicalStart });
      let refreshRequested = false;
      let finish!: (response: Response) => void;
      const refreshed = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      let patches = 0;
      const requests = mockOrganizerApi(({ path, method, body }) => {
        if (path === campaignPath && method === 'PATCH') {
          patches += 1;
          if (patches === 1)
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
          current = saved({
            revision: 9,
            proposed_start: String(body.proposed_start),
            body: String(body.body),
            text_reviewed: true,
            reviewed_event_revision: 0,
            assistant_state: state({ mode: 'manual', applied_revision: 9 }),
          });
          return Response.json(current);
        }
        if (path.endsWith('/preview')) return Response.json(preview(current));
        if (path === campaignPath) {
          if (requests.some(({ method }) => method === 'PATCH')) {
            refreshRequested = true;
            return refreshed;
          }
          return Response.json(current);
        }
        return apiNotFound();
      });
      open();
      await user.click(await screen.findByRole('button', { name: 'Изменить уведомление' }));
      await user.clear(screen.getByLabelText('Текст письма'));
      await user.type(screen.getByLabelText('Текст письма'), localBody);
      await user.click(screen.getByRole('button', { name: 'Вернуться к проверке' }));
      await user.click(
        screen.getByRole('checkbox', { name: 'Текст соответствует мероприятию и новой дате' }),
      );
      await user.click(screen.getByRole('button', { name: 'Проверить перенос' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Ваши правки остались в форме');
      await user.click(screen.getByRole('button', { name: 'Обновить сведения' }));
      await waitFor(() => expect(refreshRequested).toBe(true));
      const navigation = screen.getByRole('link', { name: 'Мероприятия' });
      if (focusNavigation) navigation.focus();
      finish(
        Response.json(
          saved({
            revision: 8,
            proposed_start: '2099-11-22T20:00:00+03:00',
            body: 'Новая серверная версия, не заменяющая мои правки',
            assistant_state: state({ applied_revision: 8 }),
          }),
        ),
      );
      expect(await screen.findByText(/Сохранённая версия обновлена/)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Обновить сведения' })).not.toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Мероприятие' })).not.toBeInTheDocument();
      if (focusNavigation) expect(navigation).toHaveFocus();
      else
        await waitFor(() =>
          expect(
            screen.getByRole('heading', { name: 'Проверьте перенос', level: 1 }),
          ).toHaveFocus(),
        );
      expect(screen.getByText(localBody)).toBeVisible();
      const reviewed = screen.getByRole('checkbox', {
        name: 'Текст соответствует мероприятию и новой дате',
      });
      expect(reviewed).not.toBeChecked();
      expect(screen.getByText('Есть несохранённые изменения')).toBeVisible();
      expect(requests.filter(({ path }) => path.endsWith('/preview'))).toHaveLength(0);
      await user.click(reviewed);
      await user.click(screen.getByRole('button', { name: 'Проверить перенос' }));
      await screen.findByRole('heading', { name: 'Подтвердите перенос' });
      expect(requests.filter(({ method }) => method === 'PATCH')[1]!.body).toMatchObject({
        expected_revision: 8,
        proposed_start: canonicalStart,
        body: localBody,
        manual_fields: [],
        mode: 'manual',
      });
      expect(
        requests.some(({ path }) => path.endsWith('/prepare') || path.endsWith('/confirm')),
      ).toBe(false);
    },
  );
});
