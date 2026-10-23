import { expect, test } from '@playwright/test';

test('отказ оформления виден рядом с повтором даже после четырёх участников', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Оформление билетов' })).toBeVisible();
  for (let index = 0; index < 4; index++) {
    if (index) await page.getByRole('button', { name: 'Добавить участника' }).click();
    const person = page.getByRole('group', { name: `Участник ${index + 1}`, exact: true });
    if (index) await expect(person.getByLabel('Имя', { exact: true })).toBeFocused();
    await person.getByLabel('Имя', { exact: true }).fill(`Участник ${index + 1}`);
    await person.getByLabel('Возраст, лет', { exact: true }).fill('18');
  }
  await page.getByLabel('Email', { exact: true }).fill('anna@example.com');
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByTestId('order-total')).toHaveText('8 000 ₽');
  await page.getByRole('radio', { name: 'Нет мест', exact: true }).check();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/orders') && r.status() === 409,
  );
  await page.getByRole('button', { name: 'Подтвердить заказ', exact: true }).click();
  await response;
  const alert = page.getByRole('alert');
  const retry = page.getByRole('button', { name: 'Повторить подтверждение', exact: true });
  await expect(alert).toBeFocused();
  await expect(alert).toContainText('Не удалось оформить заказ: места закончились');
  await expect(alert).toContainText('Заказ не создан');
  await expect(alert).toContainText('на этой странице');
  const alertBox = await alert.boundingBox();
  const retryBox = await retry.boundingBox();
  expect(alertBox!.y).toBeGreaterThanOrEqual(0);
  expect(retryBox!.y + retryBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(retryBox!.y - alertBox!.y - alertBox!.height).toBeLessThanOrEqual(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `test-results/feedback-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.screenshot({ path: `test-results/feedback-${testInfo.project.name}-viewport.png` });
  await page.getByRole('radio', { name: 'Успех', exact: true }).check();
  await expect(alert).toBeVisible();
  await retry.click();
  await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
