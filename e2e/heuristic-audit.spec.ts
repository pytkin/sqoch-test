import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function fillOrder(page: Page) {
  await page.goto('/');
  await page.getByLabel('Имя', { exact: true }).fill('Анна');
  await page.getByLabel('Возраст, лет', { exact: true }).fill('18');
  await page.getByLabel('Email', { exact: true }).fill('anna@example.com');
}

test('сетевая ошибка и действие восстановления находятся рядом в одном viewport', async ({
  page,
}, testInfo) => {
  await fillOrder(page);
  await page.route('**/api/orders/quote', (route) => route.abort('failed'));
  const calculate = page.getByRole('button', { name: 'Проверить заказ', exact: true });
  await calculate.click();
  let alert = page.getByRole('alert');
  await expect(alert).toBeFocused();
  await expect(alert).toBeInViewport({ ratio: 1 });
  await expect(calculate).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('Анна');
  let gap = await calculate.evaluate((button) => {
    const error = document.querySelector('[role="alert"]')!;
    return button.getBoundingClientRect().top - error.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(16);
  expect(gap).toBeLessThanOrEqual(32);
  await page.screenshot({ path: testInfo.outputPath('39-quote-recovery-viewport.png') });
  const quoteGap = gap;
  await page.unroute('**/api/orders/quote');
  await page.keyboard.press('Tab');
  await expect(calculate).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Проверьте заказ' })).toBeFocused();

  await page.route('**/api/orders', (route) => route.abort('failed'));
  const confirm = page.getByRole('button', { name: 'Подтвердить заказ', exact: true });
  await confirm.click();
  alert = page.getByRole('alert');
  await expect(alert).toContainText('Результат подтверждения неизвестен');
  await expect(alert).toBeFocused();
  await expect(alert).toBeInViewport({ ratio: 1 });
  await expect(confirm).toBeInViewport({ ratio: 1 });
  gap = await confirm.evaluate((button) => {
    const error = document.querySelector('[role="alert"]')!;
    return button.getBoundingClientRect().top - error.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(16);
  expect(gap).toBeLessThanOrEqual(32);
  await page.screenshot({ path: testInfo.outputPath('40-confirm-recovery-viewport.png') });
  await testInfo.attach('recovery-gaps', {
    body: Buffer.from(JSON.stringify({ quoteGap, confirmGap: gap })),
    contentType: 'application/json',
  });
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.unroute('**/api/orders');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toBeFocused();
});

test('помощь возраста доступна с клавиатуры, а лимит объяснён до добавления', async ({ page }) => {
  await page.goto('/');
  const age = page.getByLabel('Возраст, лет', { exact: true });
  await expect(age).toHaveAccessibleDescription('Полных лет; 0 — до года');
  await expect(
    page.getByRole('button', { name: 'Добавить участника' }),
  ).toHaveAccessibleDescription('В заказе не больше 4 участников');
  await age.focus();
  await expect(age).toBeFocused();
  await expect(age).toHaveCSS('outline-style', 'solid');
  await expect(age).toHaveCSS('outline-width', '3px');
  await page.keyboard.type('13');
  await expect(age).toHaveAccessibleDescription(/Детский билет.*1\s000\s₽/);
});

test('смена демосценария после отказа не сдвигает кнопку повтора', async ({ page }, testInfo) => {
  await fillOrder(page);
  await page.getByRole('button', { name: 'Проверить заказ', exact: true }).click();
  await page.getByRole('radio', { name: 'Нет мест', exact: true }).check();
  await page.getByRole('button', { name: 'Подтвердить заказ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Места закончились' })).toBeVisible();
  const retry = page.getByRole('button', { name: 'Повторить подтверждение', exact: true });
  const position = () =>
    retry.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return { y: rect.top + window.scrollY, width: rect.width, height: rect.height };
    });
  const before = await position();
  for (const scenario of ['Успех', 'Нет мест', 'Успех']) {
    await page.getByRole('radio', { name: scenario, exact: true }).check();
    const after = await position();
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
  }
  await testInfo.attach('demo-retry-layout', {
    body: Buffer.from(JSON.stringify({ before, after: await position() })),
    contentType: 'application/json',
  });
  await retry.click();
  await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toBeVisible();
});
