import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  CampaignDetail,
  CampaignPreview,
  CampaignSummary,
  OrganizerEvents,
  PrepareRequest,
  SaveCampaignRequest,
} from '../src/api/generated/types.gen';

const testNow = new Date('2026-10-27T00:00:00Z');
const reviewName = 'Текст соответствует мероприятию и новой дате';
const confirmName = 'Подтвердить перенос и уведомить покупателей';
const promptName = 'Как переносим мероприятие?';

test.beforeEach(async ({ page }) => {
  // Match the test-only API clock while polling and other browser timers keep running.
  await page.clock.setFixedTime(testNow);
});

async function context(request: APIRequestContext, eventId = 'ceramics') {
  const response = await request.get('/api/organizer/events');
  expect(response.ok()).toBe(true);
  const { items } = (await response.json()) as OrganizerEvents;
  const event = items.find((item) => item.id === eventId)!;
  expect(event).toBeDefined();
  // Confirm scenarios use an explicit future year, independently of current_year tests.
  return { event, year: Math.max(2099, Number(event.starts_at.slice(0, 4)) + 1) };
}

async function detail(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/organizer/campaigns/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as CampaignDetail;
}

function campaignId(page: Page) {
  const id = new URL(page.url()).hash.match(/^#\/organizer\/campaigns\/([^/]+)$/)?.[1];
  expect(id).toBeDefined();
  return id!;
}

async function beginTransfer(page: Page, eventId = 'ceramics') {
  await page.goto(`/#/organizer/events/${eventId}`);
  await page.getByRole('link', { name: 'Перенести мероприятие', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Перенос мероприятия', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(promptName, { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Заполнить вручную', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Новая дата', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Тема', { exact: true })).toHaveCount(0);
}

async function prepareAssistant(page: Page, prompt: string, eventId = 'ceramics') {
  await beginTransfer(page, eventId);
  await page.getByLabel(promptName, { exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Подготовить перенос', exact: true }).click();
  await expect(page).toHaveURL(/#\/organizer\/campaigns\/[^/]+$/);
  return campaignId(page);
}

async function manualDraft(page: Page, year: number) {
  let aiRequests = 0;
  page.on('request', (outgoing) => {
    if (/\/(?:prepare|rewrite)$/.test(new URL(outgoing.url()).pathname)) aiRequests += 1;
  });
  await beginTransfer(page);
  await page.getByRole('button', { name: 'Заполнить вручную', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Заполнить вручную', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel(promptName, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Новая дата', { exact: true })).toBeFocused();
  await page.getByLabel('Новая дата').fill(`${year}-11-20`);
  await page.getByLabel('Новое время').fill('19:00');
  await page.getByLabel('Тема', { exact: true }).fill('Уведомление о переносе');
  await page
    .getByLabel('Текст письма', { exact: true })
    .fill(`Занятие перенесено на 20 ноября ${year}, 19:00 Europe/Moscow.`);
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      /^\/api\/organizer\/campaigns\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole('button', { name: 'Сохранить подготовку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Проверьте перенос', exact: true })).toBeVisible();
  const response = await creation;
  expect(response.status()).toBe(201);
  const saved = (await response.json()) as CampaignDetail;
  expect(saved.id).toBe(campaignId(page));
  expect(saved.assistant_state?.mode).toBe('manual');
  expect(saved.assistant_state?.stage).toBe('applied');
  expect(saved.text_reviewed).toBe(false);
  expect(aiRequests).toBe(0);
  return campaignId(page);
}

async function openPreview(page: Page) {
  await page.getByRole('checkbox', { name: reviewName, exact: true }).check();
  await page.getByRole('button', { name: 'Проверить перенос', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Подтвердите перенос', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: confirmName, exact: true })).toBeVisible();
}

async function captureMobileState(page: Page, info: TestInfo, filename: string) {
  const previousViewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
    width: 360,
    height: 800,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.screenshot({ path: info.outputPath(filename), fullPage: true });
  if (previousViewport) await page.setViewportSize(previousViewport);
}

test('кабинет: AI заполняет дату, отдельные review/preview/confirm, отправка и история', async ({
  page,
  request,
}, info) => {
  const { event, year } = await context(request);
  const id = await prepareAssistant(page, `Переносим Керамику на 20 ноября ${year}, 19:00`);
  await expect(page.getByRole('heading', { name: 'Проверьте перенос', exact: true })).toBeVisible();
  const prepared = await detail(request, id);
  expect(prepared.assistant_state?.mode).toBe('assistant');
  expect(prepared.assistant_state?.stage).toBe('applied');
  expect(prepared.assistant_state?.year_source).toBe('explicit');
  expect(prepared.proposed_start).toBe(`${year}-11-20T19:00:00+03:00`);
  expect(prepared.text_reviewed).toBe(false);
  expect(prepared.deliveries).toEqual([]);
  expect((await context(request)).event).toEqual(event);
  const previews: string[] = [];
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname.endsWith(`/${id}/preview`))
      previews.push(outgoing.method());
  });
  await page.getByRole('button', { name: 'Проверить перенос', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: reviewName, exact: true })).toBeFocused();
  expect(previews).toEqual([]);
  await expect(page.getByRole('button', { name: confirmName, exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('organizer-draft.png'), fullPage: true });
  await openPreview(page);
  expect(previews).toEqual(['POST']);
  await expect(page.getByText('a@example.com', { exact: true })).toBeVisible();
  await expect(page.getByText('h@example.com', { exact: true })).toBeVisible();
  const previewed = await detail(request, id);
  expect(previewed.deliveries).toEqual([]);
  expect(previewed.assistant_state?.mode).toBe('assistant');
  expect((await context(request)).event).toEqual(event);
  await page.screenshot({ path: info.outputPath('organizer-preview.png'), fullPage: true });
  await page.getByRole('button', { name: confirmName, exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Уведомление покупателей', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Отправлено 8 из 8', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Отправлено 8 из 8', { exact: true })).toBeVisible();
  const saved = await detail(request, id);
  expect(saved.phase).toBe('confirmed');
  expect(saved.deliveries).toHaveLength(8);
  expect(saved.deliveries.every((item) => item.state === 'sent' && item.attempts === 1)).toBe(true);
  expect(saved.event_snapshot?.old_start).toBe(event.starts_at);
  expect(saved.event_snapshot?.new_start).toBe(prepared.proposed_start);
  await page.screenshot({ path: info.outputPath('organizer-complete.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'К мероприятию', exact: true }).click();
  const history = page.getByRole('region', { name: 'История переносов', exact: true });
  await expect(history.locator(`a[href="#/organizer/campaigns/${id}"]`)).toBeVisible();
  await expect(history).toContainText('Отправлено 8 из 8');
  expect((await context(request)).event.starts_at).toBe(prepared.proposed_start);
});

test('потеря ответа confirm проверяет тот же ID, повтор token не создаёт доставок', async ({
  page,
  request,
}) => {
  const { year } = await context(request);
  const id = await manualDraft(page, year);
  await openPreview(page);
  let token = '';
  let confirmations = 0;
  await page.route(`**/api/organizer/campaigns/${id}/confirm`, async (route) => {
    confirmations += 1;
    token = (route.request().postDataJSON() as { preview_token: string }).preview_token;
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: confirmName, exact: true }).click();
  await expect(page.getByText('Отправлено 8 из 8', { exact: true })).toBeVisible();
  expect(confirmations).toBe(1);
  const repeated = await request.post(`/api/organizer/campaigns/${id}/confirm`, {
    data: { preview_token: token },
  });
  expect(repeated.status()).toBe(200);
  const detail = (await repeated.json()) as CampaignDetail;
  expect(detail.deliveries).toHaveLength(8);
  expect(detail.deliveries.every((item) => item.attempts === 1)).toBe(true);
  expect(page.url()).toContain(`/campaigns/${id}`);
});

test('чужой перенос после preview не подтверждает устаревший состав и дату', async ({
  page,
  request,
}, info) => {
  const { event, year } = await context(request);
  const id = await manualDraft(page, year);
  await openPreview(page);
  const other = `/api/organizer/campaigns/${randomUUID()}`;
  expect((await request.put(other, { data: {} })).status()).toBe(201);
  const changed = await request.patch(other, {
    data: {
      expected_revision: 0,
      event_id: 'ceramics',
      proposed_start: `${year + 1}-11-20T19:00:00+03:00`,
      subject: 'Другой перенос',
      body: 'Другая подтверждённая дата',
      text_reviewed: true,
      reviewed_event_revision: event.revision,
    },
  });
  expect(changed.status()).toBe(200);
  const preview = await request.post(`${other}/preview`, { data: { expected_revision: 1 } });
  expect(preview.status()).toBe(200);
  expect(
    (
      await request.post(`${other}/confirm`, {
        data: { preview_token: (await preview.json()).token },
      })
    ).status(),
  ).toBe(202);
  await page.getByRole('button', { name: confirmName, exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: confirmName, exact: true })).toHaveCount(0);
  const draft = (await (
    await request.get(`/api/organizer/campaigns/${id}`)
  ).json()) as CampaignDetail;
  expect(draft.phase).toBe('draft');
  expect(draft.deliveries).toEqual([]);
  expect((await context(request)).event.starts_at).toBe(`${year + 1}-11-20T19:00:00+03:00`);
  await page.screenshot({ path: info.outputPath('organizer-stale-error.png'), fullPage: true });
  await expect
    .poll(async () => ((await (await request.get(other)).json()) as CampaignDetail).status)
    .toBe('completed');
});

test('кабинет сохраняет reflow, клавиатурный фокус и системные настройки отображения', async ({
  page,
  request,
}, info) => {
  const { year } = await context(request);
  await manualDraft(page, year);
  await page.getByRole('button', { name: 'Изменить уведомление', exact: true }).click();
  for (const width of [768, 360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page
        .getByLabel('Тема', { exact: true })
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(16);
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.evaluate(() => {
    document.body.style.zoom = '2';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => {
    document.body.style.zoom = '';
  });
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  const review = page.getByRole('checkbox', {
    name: 'Текст соответствует мероприятию и новой дате',
  });
  await review.focus();
  await page.keyboard.press('Space');
  await expect(review).toBeChecked();
  await page.keyboard.press('Space');
  await expect(review).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(review).toBeChecked();
  const previewButton = page.getByRole('button', { name: 'Проверить перенос', exact: true });
  await previewButton.focus();
  expect(await previewButton.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Подтвердите перенос', exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: info.outputPath('organizer-keyboard-forced-colors.png'),
    fullPage: true,
  });
});

test('помощник использует текущий московский год и восстанавливает результат без нового prepare', async ({
  page,
  request,
}, info) => {
  // Painting is never confirmed in this suite, including the second browser project.
  const { event } = await context(request, 'painting');
  expect(event.starts_at.slice(0, 4)).toBe('2026');
  let preparations = 0;
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname.endsWith('/prepare')) preparations += 1;
  });
  const id = await prepareAssistant(page, 'Переносим Живопись на 2 декабря, 19:00', 'painting');
  await expect(page.getByRole('heading', { name: 'Проверьте перенос', exact: true })).toBeVisible();
  await expect(page.getByLabel('В каком году состоится мероприятие?', { exact: true })).toHaveCount(
    0,
  );
  const prepared = await detail(request, id);
  expect(prepared.event_id).toBe('painting');
  expect(prepared.proposed_start).toBe('2026-12-02T19:00:00+03:00');
  expect(prepared.assistant_state?.year_source).toBe('current_year');
  expect(prepared.assistant_state?.partial_date).toEqual({
    year: 2026,
    month: 12,
    day: 2,
    hour: 19,
    minute: 0,
  });
  await expect(page.getByText(/Год 2026 выбран по текущей дате в Москве/)).toBeVisible();
  await captureMobileState(page, info, 'organizer-current-year-prepared-360.png');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Проверьте перенос', exact: true })).toBeVisible();
  expect(await detail(request, id)).toEqual(prepared);
  expect(preparations).toBe(1);
  expect((await context(request, 'painting')).event).toEqual(event);
});

test('прошедшая дата уточняет только год, сохраняет ответ, день и время после reload', async ({
  page,
  request,
}, info) => {
  const prepares: PrepareRequest[] = [];
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname.endsWith('/prepare'))
      prepares.push(outgoing.postDataJSON() as PrepareRequest);
  });
  const id = await prepareAssistant(page, 'Переносим Живопись на 20 сентября, 19:00', 'painting');
  await expect(page.getByRole('heading', { name: 'Уточните год', exact: true })).toBeVisible();
  let saved = await detail(request, id);
  expect(saved.proposed_start).toBeNull();
  expect(saved.assistant_state?.clarifications).toEqual([
    { field: 'year', reason: 'past', candidate_event_id: null },
  ]);
  expect(saved.assistant_state?.partial_date).toEqual({
    year: null,
    month: 9,
    day: 20,
    hour: 19,
    minute: 0,
  });
  await captureMobileState(page, info, 'organizer-clarification-360.png');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Уточните год', exact: true })).toBeVisible();
  expect(prepares).toHaveLength(1);
  const year = page.getByLabel('В каком году состоится мероприятие?', { exact: true });
  await expect(year).toBeVisible();
  await expect(page.getByLabel('Новая дата', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Новое время', { exact: true })).toHaveCount(0);
  await year.fill('2027');
  await page.getByRole('button', { name: 'Продолжить подготовку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Проверьте перенос', exact: true })).toBeVisible();
  expect(campaignId(page)).toBe(id);
  expect(prepares).toHaveLength(2);
  expect(prepares[1]!.answers).toEqual({ year: 2027 });
  expect(prepares[1]!.prompt).toBeUndefined();
  saved = await detail(request, id);
  expect(saved.proposed_start).toBe('2027-09-20T19:00:00+03:00');
  expect(saved.assistant_state?.answers).toEqual({ year: 2027 });
  expect(saved.assistant_state?.year_source).toBe('clarification');
  expect(saved.assistant_state?.partial_date).toEqual({
    year: 2027,
    month: 9,
    day: 20,
    hour: 19,
    minute: 0,
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Проверьте перенос', exact: true })).toBeVisible();
  expect(await detail(request, id)).toEqual(saved);
  expect(prepares).toHaveLength(2);
});

test('чтение и переключение режима не создают пустую подготовку, dirty отмена и уход явные', async ({
  page,
  request,
}, info) => {
  const before = await (await request.get('/api/organizer/campaigns')).json();
  const writes: string[] = [];
  page.on('request', (outgoing) => {
    const path = new URL(outgoing.url()).pathname;
    if (path.startsWith('/api/organizer/') && outgoing.method() !== 'GET')
      writes.push(`${outgoing.method()} ${path}`);
  });
  await beginTransfer(page, 'painting');
  await captureMobileState(page, info, 'organizer-initial-360.png');
  const manualToggle = page.getByRole('button', { name: 'Заполнить вручную', exact: true });
  await manualToggle.click();
  await expect(manualToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel(promptName, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Новая дата', { exact: true })).toBeVisible();
  await manualToggle.click();
  await expect(manualToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Новая дата', { exact: true })).toHaveCount(0);
  await page.reload();
  const prompt = page.getByLabel(promptName, { exact: true });
  await expect(prompt).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Подготовить перенос', exact: true }).click();
  await expect(prompt).toBeFocused();
  expect(writes).toEqual([]);
  await prompt.fill('Несохранённый запрос о переносе');
  const transferUrl = page.url();
  await Promise.all([
    page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('Есть несохранённые изменения');
      await dialog.dismiss();
    }),
    page.getByRole('link', { name: 'Билеты', exact: true }).click(),
  ]);
  await expect(page).toHaveURL(transferUrl);
  await expect(prompt).toHaveValue('Несохранённый запрос о переносе');
  await Promise.all([
    page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('Есть несохранённые изменения');
      await dialog.accept();
    }),
    page.getByRole('link', { name: 'Билеты', exact: true }).click(),
  ]);
  await expect(
    page.getByRole('heading', { name: 'Оформление билетов', exact: true }),
  ).toBeVisible();
  await beginTransfer(page, 'painting');
  await expect(page.getByLabel(promptName, { exact: true })).toHaveValue('');
  expect(writes).toEqual([]);
  expect(await (await request.get('/api/organizer/campaigns')).json()).toEqual(before);
});

function controlledCampaign() {
  const id = randomUUID();
  const event: OrganizerEvents['items'][number] = {
    id: 'ceramics',
    title: 'Керамика',
    starts_at: '2099-10-10T19:00:00+03:00',
    timezone: 'Europe/Moscow',
    revision: 0,
  };
  const draft: CampaignDetail = {
    id,
    phase: 'draft',
    revision: 0,
    created_at: '2026-10-26T12:00:00Z',
    updated_at: '2026-10-26T12:00:00Z',
    event_id: event.id,
    proposed_start: null,
    suggested_start: null,
    subject: '',
    body: '',
    text_reviewed: false,
    reviewed_event_revision: null,
    confirmed_at: null,
    event_snapshot: null,
    preview: null,
    status: 'draft',
    counters: { total: 0, pending: 0, sending: 0, retry_wait: 0, sent: 0, failed: 0, unknown: 0 },
    deliveries: [],
    assistant_state: {
      version: 1,
      mode: 'assistant',
      stage: 'intake',
      original_prompt: 'Переносим Керамику на 20 ноября 2099, 19:00',
      answers: {},
      context_event_id: event.id,
      partial_date: { year: null, month: null, day: null, hour: null, minute: null },
      manual_fields: [],
      clarifications: [],
      intake_revision: 0,
      applied_revision: null,
      year_source: null,
    },
  };
  const subject = `Перенос «Керамики»: ${'ДлинноеСлово'.repeat(14)}`;
  const body = [
    'Уведомление с буквальным текстом, который вернул помощник.',
    '<script data-sqoch-probe>document.documentElement.dataset.sqochProbe="executed"</script>',
    '<img data-sqoch-probe src="invalid-sqoch-image" onerror="document.documentElement.dataset.sqochProbe=\'executed\'">',
    'ОченьДлиннаяСтрокаБезПробелов'.repeat(14),
    'Содержательное пояснение переноса сохраняется целиком. '.repeat(12),
  ]
    .join('\n')
    .trim();
  const email = `${'r'.repeat(64)}@${'d'.repeat(60)}.example.com`;
  const error = `Служба отправки отклонила попытку. ${'ПодробноеОписаниеПричины'.repeat(12)}. Проверьте результат для этого адреса.`;
  const result: CampaignDetail = {
    ...draft,
    phase: 'confirmed',
    revision: 4,
    subject,
    body,
    proposed_start: '2099-11-20T19:00:00+03:00',
    text_reviewed: true,
    reviewed_event_revision: 0,
    confirmed_at: '2026-10-26T12:05:00Z',
    status: 'completed_with_errors',
    event_snapshot: {
      id: event.id,
      title: event.title,
      old_start: event.starts_at,
      new_start: '2099-11-20T19:00:00+03:00',
      timezone: event.timezone,
      event_revision_before: 0,
    },
    assistant_state: {
      ...draft.assistant_state!,
      stage: 'applied',
      partial_date: { year: 2099, month: 11, day: 20, hour: 19, minute: 0 },
      year_source: 'explicit',
      intake_revision: 2,
      applied_revision: 3,
    },
    counters: { total: 1, pending: 0, sending: 0, retry_wait: 0, sent: 0, failed: 1, unknown: 0 },
    deliveries: [
      {
        id: randomUUID(),
        email,
        state: 'failed',
        attempts: 1,
        next_attempt_at: null,
        sent_at: null,
        error_code: 'smtp_permanent_failure',
        error_message: error,
      },
    ],
  };
  return { id, event, draft, result, subject, body, email, error };
}

test('ссылка Mailpit в пояснении различима подчёркиванием', async ({ page }) => {
  const data = controlledCampaign();
  await page.route('**/api/organizer/events', (route) =>
    route.fulfill({ json: { items: [data.event] } }),
  );
  await page.route(`**/api/organizer/campaigns/${data.id}`, (route) =>
    route.fulfill({ json: data.result }),
  );
  await page.goto(`/#/organizer/campaigns/${data.id}`);
  const link = page.getByRole('link', { name: 'Открыть письма в Mailpit', exact: true });
  await expect(link).toBeVisible();
  expect(await link.evaluate((element) => getComputedStyle(element).textDecorationLine)).toContain(
    'underline',
  );
});

test('прогресс и действия восстановления видны перед длинным письмом и раскрываемой справкой', async ({
  page,
}, info) => {
  const data = controlledCampaign();
  const states = ['pending', 'retry_wait', 'unknown'] as const;
  const result: CampaignDetail = {
    ...data.result,
    status: 'processing',
    counters: { total: 3, pending: 1, sending: 0, retry_wait: 1, sent: 0, failed: 0, unknown: 1 },
    deliveries: states.map((state, index) => ({
      ...data.result.deliveries[0]!,
      id: randomUUID(),
      email: `recipient${index}@example.com`,
      state,
      attempts: index === 0 ? 0 : 1,
      error_code:
        state === 'unknown'
          ? 'smtp_outcome_unknown'
          : state === 'retry_wait'
            ? 'smtp_temporary_failure'
            : null,
      error_message:
        state === 'unknown'
          ? 'Результат отправки неизвестен'
          : state === 'retry_wait'
            ? 'Служба отправки временно отклонила письмо'
            : null,
      next_attempt_at: state === 'retry_wait' ? '2099-11-20T19:05:00+03:00' : null,
    })),
  };
  await page.route('**/api/organizer/events', (route) =>
    route.fulfill({ json: { items: [data.event] } }),
  );
  await page.route(`**/api/organizer/campaigns/${data.id}`, (route) =>
    route.fulfill({ json: result }),
  );
  await page.goto(`/#/organizer/campaigns/${data.id}`);
  await expect(page.getByText('Отправлено 0 из 3', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Что требует внимания', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Результат каждого получателя', exact: true }),
  ).toBeVisible();
  for (const [width, height] of [
    [360, 800],
    [320, 900],
    [768, 1050],
    [1440, 1050],
  ] as const) {
    await page.setViewportSize({ width, height });
    const button = await page
      .getByRole('button', { name: 'Проверить результат отправки' })
      .boundingBox();
    expect(button!.y + button!.height).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  const help = page
    .locator('details')
    .filter({ hasText: 'Как работают повторы и проверка отправки' });
  await expect(help).not.toHaveAttribute('open', '');
  await help.locator('summary').click();
  await expect(help).toHaveAttribute('open', '');
  await expect(help.getByText(/могли быть приняты Mailpit/)).toBeVisible();
  await expect(page.locator('.organizer-letter')).toHaveText(data.body);
  await page.screenshot({ path: info.outputPath('organizer-recovery-help.png'), fullPage: true });
});

test('unknown сверяется только явно, отсутствие подтверждения не разрешает слепую переотправку', async ({
  page,
}) => {
  const data = controlledCampaign();
  const campaignPath = `/api/organizer/campaigns/${data.id}`;
  let saved: CampaignDetail = {
    ...data.result,
    status: 'needs_attention',
    counters: { total: 1, pending: 0, sending: 0, retry_wait: 0, sent: 0, failed: 0, unknown: 1 },
    deliveries: data.result.deliveries.map((delivery) => ({
      ...delivery,
      state: 'unknown',
      error_code: 'not_found_in_mailpit',
      error_message: 'Результат отправки требует проверки',
    })),
  };
  let checks = 0;
  const writes: string[] = [];
  await page.route('**/api/organizer/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method !== 'GET') writes.push(`${method} ${path}`);
    if (path === '/api/organizer/events') return route.fulfill({ json: { items: [data.event] } });
    if (path === campaignPath && method === 'GET') return route.fulfill({ json: saved });
    if (path === `${campaignPath}/reconcile` && method === 'POST') {
      if (++checks === 2) {
        saved = {
          ...saved,
          status: 'completed',
          counters: { ...saved.counters, sent: 1, unknown: 0 },
          deliveries: saved.deliveries.map((delivery) => ({
            ...delivery,
            state: 'sent',
            sent_at: '2026-10-27T00:06:00Z',
            error_code: null,
            error_message: null,
          })),
        };
      }
      return route.fulfill({ json: saved });
    }
    return route.fulfill({
      status: 404,
      json: { detail: { code: 'not_found', message: 'Не найдено', related_campaign_id: null } },
    });
  });
  await page.goto(`/#/organizer/campaigns/${data.id}`);
  await expect(
    page.getByRole('heading', { name: 'Что требует внимания', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Результат каждого получателя', exact: true }),
  ).toBeVisible();
  const check = page.getByRole('button', { name: 'Проверить результат отправки', exact: true });
  await expect(check).toBeVisible();
  expect(writes).toEqual([]);
  await expect(page.getByRole('button', { name: 'Продолжить отправку', exact: true })).toHaveCount(
    0,
  );
  await check.click();
  await expect(page.getByText(/Проверка завершена\. Требуют проверки: 1\./)).toBeVisible();
  await expect(page.getByText('Отправлено 0 из 1', { exact: true })).toBeVisible();
  await expect(check).toBeEnabled();
  expect(saved.deliveries[0]!.attempts).toBe(1);
  await check.click();
  await expect(page.getByText('Отправлено 1 из 1', { exact: true })).toBeVisible();
  await expect(check).toHaveCount(0);
  expect(saved.deliveries[0]!.attempts).toBe(1);
  expect(writes).toEqual([`POST ${campaignPath}/reconcile`, `POST ${campaignPath}/reconcile`]);
});

test('длинные значения, ошибки и HTML помощника остаются читаемым plain text', async ({
  page,
}, info) => {
  const data = controlledCampaign();
  const campaignPath = `/api/organizer/campaigns/${data.id}`;
  let saved = data.draft;
  let preparations = 0;
  await page.route('**/api/organizer/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/organizer/events') return route.fulfill({ json: { items: [data.event] } });
    if (path === '/api/organizer/campaigns') {
      const item: CampaignSummary = {
        id: saved.id,
        phase: saved.phase,
        revision: saved.revision,
        created_at: saved.created_at,
        updated_at: saved.updated_at,
        event_id: saved.event_id,
        event_title: data.event.title,
        subject: saved.subject,
        proposed_start: saved.proposed_start,
        status: saved.status,
        counters: saved.counters,
        event_snapshot: saved.event_snapshot,
        has_content: Boolean(
          saved.event_id ||
          saved.proposed_start ||
          saved.subject ||
          saved.body ||
          saved.assistant_state?.original_prompt,
        ),
        preparation_stage:
          saved.phase === 'confirmed' ? null : (saved.assistant_state?.stage ?? 'manual'),
      };
      return route.fulfill({ json: { items: [item] } });
    }
    if (path === campaignPath && method === 'GET') return route.fulfill({ json: saved });
    if (path === campaignPath && method === 'PATCH') {
      const edit = route.request().postDataJSON() as SaveCampaignRequest;
      const state = saved.assistant_state;
      saved = {
        ...saved,
        revision: saved.revision + 1,
        event_id: edit.event_id,
        proposed_start: edit.proposed_start,
        subject: edit.subject,
        body: edit.body,
        text_reviewed: edit.text_reviewed,
        reviewed_event_revision: edit.reviewed_event_revision ?? null,
        assistant_state: state && {
          ...state,
          mode: edit.mode ?? state.mode,
          original_prompt: edit.prompt ?? state.original_prompt,
          manual_fields: [...new Set([...state.manual_fields, ...(edit.manual_fields ?? [])])],
        },
        preview: null,
      };
      return route.fulfill({ json: saved });
    }
    if (path === `${campaignPath}/prepare`) {
      preparations += 1;
      const prepare = route.request().postDataJSON() as PrepareRequest;
      const revision = saved.revision;
      saved = {
        ...saved,
        revision: revision + 2,
        subject: data.subject,
        body: data.body,
        proposed_start: '2099-11-20T19:00:00+03:00',
        suggested_start: null,
        text_reviewed: false,
        reviewed_event_revision: null,
        preview: null,
        assistant_state: {
          ...data.draft.assistant_state!,
          mode: 'assistant',
          stage: 'applied',
          original_prompt: prepare.prompt ?? saved.assistant_state!.original_prompt,
          partial_date: { year: 2099, month: 11, day: 20, hour: 19, minute: 0 },
          year_source: 'explicit',
          intake_revision: revision + 1,
          applied_revision: revision + 2,
        },
      };
      return route.fulfill({
        json: {
          outcome: 'applied',
          campaign: saved,
          fields_to_complete: [],
          clarifications: [],
          message: 'Проверьте подготовленный перенос',
        },
      });
    }
    if (path === `${campaignPath}/preview`) {
      const preview: CampaignPreview = {
        token: randomUUID(),
        campaign_id: data.id,
        draft_revision: saved.revision,
        event: data.event,
        old_start: data.event.starts_at,
        proposed_start: saved.proposed_start!,
        subject: saved.subject,
        body: saved.body,
        recipients: [data.email],
      };
      saved = { ...saved, preview };
      return route.fulfill({ json: preview });
    }
    if (path === `${campaignPath}/confirm`) {
      saved = { ...data.result, revision: saved.revision + 1, preview: saved.preview };
      return route.fulfill({ status: 202, json: saved });
    }
    return route.fulfill({
      status: 404,
      json: { detail: { code: 'not_found', message: 'Не найдено', related_campaign_id: null } },
    });
  });
  await page.goto(`/#/organizer/campaigns/${data.id}`);
  await page
    .getByLabel(promptName, { exact: true })
    .fill('Переносим Керамику на 20 ноября 2099, 19:00');
  await page.getByRole('button', { name: 'Подготовить перенос', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Проверьте перенос', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Изменить уведомление', exact: true }).click();
  await expect(page.getByLabel('Текст письма', { exact: true })).toHaveValue(data.body);
  expect(preparations).toBe(1);
  await openPreview(page);
  const letter = page.locator('.organizer-letter');
  await expect(letter).toHaveText(data.body);
  expect(await letter.textContent()).toBe(data.body);
  await expect(page.locator('script[data-sqoch-probe], img[data-sqoch-probe]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.sqochProbe)).toBeUndefined();
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.screenshot({
    path: info.outputPath('organizer-long-plain-preview.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: confirmName, exact: true }).click();
  await expect(page.getByText(data.error, { exact: true })).toBeVisible();
  await expect(page.getByText(data.email, { exact: true })).toBeVisible();
  await expect(letter).toHaveText(data.body);
  expect(await letter.textContent()).toBe(data.body);
  await expect(page.locator('script[data-sqoch-probe], img[data-sqoch-probe]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.sqochProbe)).toBeUndefined();
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const back = await page.getByRole('link', { name: 'К мероприятию', exact: true }).boundingBox();
    expect(back!.height).toBeGreaterThanOrEqual(44);
    expect(back!.width).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath('organizer-long-error.png'), fullPage: true });
  await page.getByRole('link', { name: 'К мероприятию', exact: true }).click();
  const history = page.getByRole('region', { name: 'История переносов', exact: true });
  const campaignLink = history.getByRole('link').filter({ hasText: data.subject });
  await expect(campaignLink).toBeVisible();
  const box = await campaignLink.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
});
