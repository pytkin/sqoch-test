import { expect, test } from '@playwright/test';
import type { Page, Route, TestInfo } from '@playwright/test';

const quoteUrl = '**/api/orders/quote';
const confirmUrl = '**/api/orders';

async function openBooking(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Оформление билетов' })).toBeVisible();
}

async function fillAdult(page: Page) {
  await page.getByLabel('Имя', { exact: true }).fill('Анна');
  await page.getByLabel('Возраст, лет', { exact: true }).fill('18');
  await page.getByLabel('Email', { exact: true }).fill('anna@example.com');
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function capture(page: Page, testInfo: TestInfo, name: string, fullPage = true) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function holdRequests(page: Page, pattern: string) {
  const requests: Route[] = [];
  await page.route(pattern, (route) => {
    requests.push(route);
  });
  return requests;
}

test('дизайн: реальные размеры, 4 участника, длинные значения и адаптивность', async ({
  page,
  browser,
}, testInfo) => {
  await openBooking(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(
      () =>
        [...document.fonts].some(
          (font) =>
            font.family.replaceAll(/["']/g, '') === 'Commissioner' && font.status === 'loaded',
        ) && document.fonts.check('18px Commissioner', 'Оформление билетов Ёж'),
    ),
  ).toBe(true);
  const firstName = page.getByLabel('Имя', { exact: true }).first();
  const firstAge = page.getByLabel('Возраст, лет', { exact: true }).first();
  await expect(firstName).toHaveCSS('font-size', '18px');
  await expect(firstAge).toHaveCSS('font-size', '18px');
  for (const field of [firstName, firstAge]) {
    const box = await field.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(56);
    if (testInfo.project.name === 'mobile-360') {
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(800);
    }
  }
  const textSizes = await page
    .locator('.field label, .field-hint, .steps, .site-footer')
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => parseFloat(getComputedStyle(node).fontSize)),
    );
  expect(textSizes.length).toBeGreaterThan(0);
  expect(textSizes.every((size) => size >= 16)).toBe(true);
  const primaryBox = await page.getByRole('button', { name: 'Проверить заказ' }).boundingBox();
  expect(primaryBox!.height).toBeGreaterThanOrEqual(56);
  const layoutBox = await page.locator('.layout').boundingBox();
  expect(layoutBox!.width).toBeLessThanOrEqual(800);
  await expect(page.getByText('Шаг 1 из 2 · Данные', { exact: true })).toBeVisible();
  await noOverflow(page);
  await capture(page, testInfo, '01-data-initial-viewport', false);
  await capture(page, testInfo, '02-data-initial-full');

  for (let index = 1; index < 4; index++) {
    await page.getByRole('button', { name: 'Добавить участника' }).click();
  }
  const longName = 'Александра Владимировна Соколова-Долгорукова '.repeat(2).trim();
  const longEmail = `anna.${'booking'.repeat(7)}@example.com`;
  for (let index = 0; index < 4; index++) {
    const person = page.getByRole('group', { name: `Участник ${index + 1}`, exact: true });
    await person.getByLabel('Имя', { exact: true }).fill(longName);
    await person.getByLabel('Возраст, лет', { exact: true }).fill('18');
  }
  await page.getByLabel('Email', { exact: true }).fill(longEmail);
  await expect(page.getByRole('button', { name: 'Добавить участника' })).toBeDisabled();
  for (const button of await page.getByRole('button', { name: /^Удалить участника/ }).all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  await page.locator('.brand').click();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(longEmail);
  await expect(page.getByRole('group', { name: /^Участник \d$/, exact: true })).toHaveCount(4);
  await noOverflow(page);
  await capture(page, testInfo, '03-data-four-long-values');
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Проверьте заказ' })).toBeFocused();
  await expect(page.getByTestId('order-total')).toHaveText('8 000 ₽');
  await noOverflow(page);
  await capture(page, testInfo, '04-review-four-long-values');
  await page.getByRole('button', { name: 'Изменить участника 1' }).click();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(longEmail);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
  const transitions = await firstName.evaluate((node) => getComputedStyle(node).transitionDuration);
  expect(transitions.split(',').every((duration) => parseFloat(duration) === 0)).toBe(true);
  await noOverflow(page);
  await capture(page, testInfo, '05-tablet-768-reduced-motion');

  // Equivalent CSS viewport/DPR for 200% reflow of 1440×1050; this is not native browser zoom.
  const reflowContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    viewport: { width: 720, height: 525 },
    deviceScaleFactor: 2,
  });
  try {
    const reflowPage = await reflowContext.newPage();
    await openBooking(reflowPage);
    await reflowPage.evaluate(() => document.fonts.ready);
    const metrics = await reflowPage.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      deviceScaleFactor: devicePixelRatio,
      fontReady: [...document.fonts].some(
        (font) =>
          font.family.replaceAll(/["']/g, '') === 'Commissioner' && font.status === 'loaded',
      ),
    }));
    expect(metrics).toEqual({ width: 720, height: 525, deviceScaleFactor: 2, fontReady: true });
    await testInfo.attach('reflow-200-percent-emulation', {
      body: JSON.stringify({ ...metrics, sourceViewport: '1440×1050', nativeBrowserZoom: false }),
      contentType: 'application/json',
    });
    await expect(reflowPage.getByLabel('Имя', { exact: true })).toHaveCSS('font-size', '18px');
    await fillAdult(reflowPage);
    await noOverflow(reflowPage);
    await capture(reflowPage, testInfo, '29-reflow-200-emulated-data');
    await reflowPage.getByRole('button', { name: 'Проверить заказ' }).click();
    await expect(reflowPage.getByRole('heading', { name: 'Проверьте заказ' })).toBeFocused();
    await expect(reflowPage.getByTestId('order-total')).toHaveText('2 000 ₽');
    await noOverflow(reflowPage);
    await capture(reflowPage, testInfo, '30-reflow-200-emulated-review');
  } finally {
    await reflowContext.close();
  }
});

test('состояния: загрузка, восстановление и доступные ошибки полей/состава', async ({
  page,
}, testInfo) => {
  const eventRequests = await holdRequests(page, '**/api/event');
  await page.goto('/');
  await expect(page.getByText('Загружаем мероприятие…', { exact: true })).toBeVisible();
  await expect.poll(() => eventRequests.length).toBe(1);
  await capture(page, testInfo, '06-event-loading');
  await eventRequests[0]!.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'temporarily_unavailable' }),
  });
  await expect(page.getByRole('alert')).toContainText('Сервер временно недоступен');
  await capture(page, testInfo, '07-event-failure');
  await page.unroute('**/api/event');
  await page.getByRole('button', { name: 'Повторить загрузку' }).click();
  await expect(page.getByRole('heading', { name: 'Оформление билетов' })).toBeFocused();
  await capture(page, testInfo, '08-event-retry');

  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByLabel('Имя', { exact: true })).toBeFocused();
  await expect(page.getByText('Укажите имя', { exact: true })).toBeVisible();
  await capture(page, testInfo, '09-field-errors');
  await fillAdult(page);
  await page.getByLabel('Возраст, лет', { exact: true }).fill('13');
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  const composition = page.getByRole('group', { name: 'Состав заказа', exact: true });
  await expect(composition).toBeFocused();
  await expect(composition).toHaveAccessibleDescription(/нужен сопровождающий от 18 лет/);
  await capture(page, testInfo, '10-companion-error');

  await page.getByLabel('Возраст, лет', { exact: true }).fill('18');
  await page.getByLabel('Email', { exact: true }).fill('john..doe@example.com');
  const emailRejection = page.waitForResponse(
    (response) => response.url().endsWith('/api/orders/quote') && response.status() === 422,
  );
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await emailRejection;
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Email', { exact: true })).toHaveAccessibleDescription(
    'Проверьте email, например name@example.com',
  );
  await capture(page, testInfo, '11-server-email-error');

  await page.getByLabel('Email', { exact: true }).fill('anna@example.com');
  await page.route(quoteUrl, (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        detail: [
          { loc: ['body', 'participants'], msg: 'Invalid composition', type: 'value_error' },
        ],
      }),
    }),
  );
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(composition).toBeFocused();
  await expect(composition).toHaveAccessibleDescription(/Проверьте состав заказа/);
  await noOverflow(page);
  await capture(page, testInfo, '12-server-composition-error');
});

test('восстановление: ожидание, сеть и 15 секунд без автоматического confirm', async ({
  page,
}, testInfo) => {
  await openBooking(page);
  await fillAdult(page);
  await page.clock.install();
  const quotePending = await holdRequests(page, quoteUrl);
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect.poll(() => quotePending.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Рассчитываем…', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Имя', { exact: true })).toBeDisabled();
  await expect(page.getByRole('radio')).toHaveCount(0);
  await capture(page, testInfo, '13-quote-pending');
  await quotePending[0]!.abort('failed');
  await expect(page.getByRole('alert')).toContainText('Не удалось связаться с сервером');
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('anna@example.com');
  await capture(page, testInfo, '14-quote-network-error');
  await page.unroute(quoteUrl);

  const quoteTimeout = await holdRequests(page, quoteUrl);
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect.poll(() => quoteTimeout.length).toBe(1);
  await page.clock.fastForward(15_001);
  await expect(page.getByRole('alert')).toContainText(/время ожидания/);
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('Анна');
  await capture(page, testInfo, '15-quote-timeout');
  await quoteTimeout[0]!.abort().catch(() => {});
  await page.unroute(quoteUrl);
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Проверьте заказ' })).toBeFocused();
  await expect(page.getByTestId('order-total')).toHaveText('2 000 ₽');
  await capture(page, testInfo, '16-review-after-quote-retry');

  let confirmRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/orders')) confirmRequests++;
  });
  const confirmPending = await holdRequests(page, confirmUrl);
  await page.getByRole('button', { name: 'Подтвердить заказ' }).click();
  await expect.poll(() => confirmPending.length).toBe(1);
  const confirming = page.getByRole('button', { name: 'Подтверждаем…', exact: true });
  await expect(confirming).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Изменить участника 1' })).toBeDisabled();
  await confirming.dispatchEvent('click');
  expect(confirmRequests).toBe(1);
  await capture(page, testInfo, '17-confirm-pending');
  await confirmPending[0]!.abort('failed');
  await expect(page.getByRole('alert')).toContainText('Результат подтверждения неизвестен');
  await expect(page.getByRole('alert')).toContainText('Не удалось связаться с сервером');
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByTestId('order-total')).toHaveText('2 000 ₽');
  await capture(page, testInfo, '18-confirm-network-error');
  await page.unroute(confirmUrl);

  // A later timeout must replace the last sold_out verdict, rather than repeat it as fact.
  await page.getByRole('radio', { name: 'Нет мест', exact: true }).check();
  await page.getByRole('button', { name: 'Подтвердить заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Места закончились' })).toBeFocused();
  expect(confirmRequests).toBe(2);
  const confirmTimeout = await holdRequests(page, confirmUrl);
  await page.getByRole('button', { name: 'Повторить подтверждение' }).click();
  await expect.poll(() => confirmTimeout.length).toBe(1);
  await page.clock.fastForward(15_001);
  await expect(page.getByRole('alert')).toContainText('Результат подтверждения неизвестен');
  await expect(page.getByRole('alert')).toContainText(/время ожидания/);
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Места закончились' })).toHaveCount(0);
  await expect(page.getByText(/^Заказ не создан/)).toHaveCount(0);
  await expect(page.getByText(/^Мест нет\./)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toHaveCount(0);
  expect(confirmRequests).toBe(3);
  await noOverflow(page);
  await capture(page, testInfo, '19-confirm-timeout');
  await confirmTimeout[0]!.abort().catch(() => {});
  await page.unroute(confirmUrl);
  await page.getByRole('radio', { name: 'Успех', exact: true }).check();
  await page.getByRole('button', { name: 'Подтвердить заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toBeFocused();
  await expect(page.getByTestId('order-total')).toHaveText('2 000 ₽');
  expect(confirmRequests).toBe(4);
  await capture(page, testInfo, '20-success-after-manual-retry');
});

test('реальный поток: отмена удаления, перерасчёт, sold_out, успех и новый заказ', async ({
  page,
}, testInfo) => {
  await openBooking(page);
  await fillAdult(page);
  await page.getByRole('button', { name: 'Добавить участника' }).click();
  const child = page.getByRole('group', { name: 'Участник 2', exact: true });
  await child.getByLabel('Имя', { exact: true }).fill('Лев');
  await child.getByLabel('Возраст, лет', { exact: true }).fill('13');
  await page.getByRole('button', { name: 'Удалить участника 2', exact: true }).click();
  await expect(page.getByLabel('Имя', { exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: /^Вернуть участника/ })).toBeVisible();
  await capture(page, testInfo, '21-removal-undo-available');
  await page.getByRole('button', { name: /^Вернуть участника/ }).click();
  await expect(child.getByLabel('Имя', { exact: true })).toHaveValue('Лев');
  await expect(child.getByLabel('Имя', { exact: true })).toBeFocused();
  await expect(child.getByLabel('Возраст, лет', { exact: true })).toHaveValue('13');
  await capture(page, testInfo, '22-removal-restored');
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByTestId('order-total')).toHaveText('3 000 ₽');
  await capture(page, testInfo, '23-review-3000');
  await page.getByRole('button', { name: 'Изменить участника 2' }).click();
  await expect(child.getByLabel('Имя', { exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Подтвердить заказ' })).toHaveCount(0);
  await expect(child.getByLabel('Возраст, лет', { exact: true })).toHaveValue('13');
  await child.getByLabel('Возраст, лет', { exact: true }).fill('14');
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByTestId('order-total')).toHaveText('4 000 ₽');
  await capture(page, testInfo, '24-review-recalculated-4000');
  const successScenario = page.getByRole('radio', { name: 'Успех', exact: true });
  await successScenario.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Нет мест', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Подтвердить заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Места закончились' })).toBeFocused();
  await capture(page, testInfo, '25-sold-out');
  await expect(page.getByRole('button', { name: 'Вернуться к проверке' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Повторить подтверждение' })).toBeEnabled();
  await expect(page.getByTestId('order-total')).toHaveText('4 000 ₽');
  await capture(page, testInfo, '26-summary-after-sold-out');
  await page.getByRole('radio', { name: 'Успех', exact: true }).check();
  await page.getByRole('button', { name: 'Повторить подтверждение' }).click();
  await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toBeFocused();
  await expect(page.getByTestId('order-total')).toHaveText('4 000 ₽');
  await expect(page.locator('.success-summary')).toHaveText('2 билета · 4 000 ₽');
  await expect(page.getByText(/Шаг \d из 2/)).toHaveCount(0);
  await noOverflow(page);
  await capture(page, testInfo, '27-success');
  await page.getByRole('button', { name: 'Оформить новый заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Оформление билетов' })).toBeFocused();
  await expect(page.getByRole('group', { name: /^Участник \d$/, exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  await capture(page, testInfo, '28-new-order');
});
