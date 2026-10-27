import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const removedIndex of [0, 3]) {
  test(`возврат удаления участника ${removedIndex + 1} виден без дополнительной прокрутки и восстанавливает порядок`, async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Оформление билетов' })).toBeVisible();
    const names = ['Анна', 'Борис', 'Вера', 'Глеб'];
    for (const [index, name] of names.entries()) {
      if (index > 0) await page.getByRole('button', { name: 'Добавить участника' }).click();
      const person = page.getByRole('group', { name: `Участник ${index + 1}`, exact: true });
      if (index > 0) await expect(person.getByLabel('Имя', { exact: true })).toBeFocused();
      await person.getByLabel('Имя', { exact: true }).fill(name);
      await person.getByLabel('Возраст, лет', { exact: true }).fill(String(18 + index));
    }
    await page.getByLabel('Email', { exact: true }).fill('anna@example.com');
    await page.getByRole('button', { name: `Удалить участника ${removedIndex + 1}` }).click();
    const focusedIndex = Math.min(removedIndex, names.length - 2);
    await expect(
      page
        .getByRole('group', { name: `Участник ${focusedIndex + 1}`, exact: true })
        .getByLabel('Имя', { exact: true }),
    ).toBeFocused();
    const undo = page.getByRole('button', { name: 'Вернуть участника', exact: true });
    await expect(undo).toBeInViewport({ ratio: 1 });
    await capture(
      page,
      testInfo,
      removedIndex === 0 ? '35-undo-first-visible' : '37-undo-last-visible',
    );
    await undo.click();
    for (const [index, name] of names.entries()) {
      const person = page.getByRole('group', { name: `Участник ${index + 1}`, exact: true });
      await expect(person.getByLabel('Имя', { exact: true })).toHaveValue(name);
      await expect(person.getByLabel('Возраст, лет', { exact: true })).toHaveValue(
        String(18 + index),
      );
    }
    await expect(
      page
        .getByRole('group', { name: `Участник ${removedIndex + 1}`, exact: true })
        .getByLabel('Имя', { exact: true }),
    ).toBeFocused();
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue('anna@example.com');
    await capture(
      page,
      testInfo,
      removedIndex === 0 ? '36-undo-first-restored' : '38-undo-last-restored',
    );
  });
}

test('повторная ошибка GET сохраняет фокус и описание; клавиатурный повтор загружает настоящий API', async ({
  page,
}, testInfo) => {
  let eventRequests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/event')) eventRequests++;
  });
  await page.route('**/api/event', (route) => route.abort('failed'));
  await page.goto('/');
  const retry = page.getByRole('button', { name: 'Повторить загрузку' });
  await expect(retry).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => eventRequests).toBe(2);
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAccessibleDescription(/Не удалось связаться с сервером/);
  await capture(page, testInfo, '31-event-retry-error');
  expect(eventRequests).toBe(2);
  await page.unroute('**/api/event');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Оформление билетов' })).toBeFocused();
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('');
  expect(eventRequests).toBe(3);
  await capture(page, testInfo, '32-event-retry-success');
});

test('повреждённый HTTP 201 сохраняет сводку до ручного подтверждения настоящим API', async ({
  page,
}, testInfo) => {
  const confirmBodies: unknown[] = [];
  let quoteRequests = 0;
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/orders')) confirmBodies.push(request.postDataJSON());
    if (request.url().endsWith('/api/orders/quote')) quoteRequests++;
  });
  await page.goto('/');
  await page.getByLabel('Имя', { exact: true }).fill('Анна');
  await page.getByLabel('Возраст, лет', { exact: true }).fill('18');
  await page.getByLabel('Email', { exact: true }).fill('anna@example.com');
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
  await page.route('**/api/orders', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }),
  );
  await page.getByRole('button', { name: 'Подтвердить заказ' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Результат подтверждения неизвестен');
  await expect(alert).toContainText('«Подтвердить заказ»');
  await expect(alert).toContainText('Автоматически запрос не повторяется');
  await expect(alert).not.toContainText('Заказ не создан');
  await expect(alert).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
  await expect(page.getByText('Анна', { exact: true })).toBeVisible();
  await expect(page.getByText('anna@example.com', { exact: true })).toBeVisible();
  await expect(page.getByTestId('order-total')).toHaveText('2 000 ₽');
  await capture(page, testInfo, '33-confirm-malformed-201');
  expect(confirmBodies).toHaveLength(1);
  expect(quoteRequests).toBe(1);
  await page.unroute('**/api/orders');
  await page.getByRole('button', { name: 'Подтвердить заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toBeFocused();
  await expect(page.getByTestId('order-total')).toHaveText('2 000 ₽');
  expect(confirmBodies).toHaveLength(2);
  expect(confirmBodies[1]).toEqual(confirmBodies[0]);
  expect(quoteRequests).toBe(1);
  await capture(page, testInfo, '34-confirm-manual-success');
});
