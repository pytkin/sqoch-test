import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Оформление билетов' })).toBeVisible();
});
async function fillAdult(page: import('@playwright/test').Page) {
  await page.getByLabel('Имя', { exact: true }).fill('Анна');
  await page.getByLabel('Возраст, лет', { exact: true }).fill('18');
  await page.getByLabel('Email', { exact: true }).fill('anna@example.com');
}
async function noOverflow(page: import('@playwright/test').Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}
test('реальный API: ребёнок+взрослый → редактирование → перерасчёт → успех', async ({
  page,
}, testInfo) => {
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST') posts.push(r.url());
  });
  await fillAdult(page);
  await page.getByRole('button', { name: 'Добавить участника' }).click();
  const child = page.getByRole('group', { name: 'Участник 2', exact: true });
  await child.getByLabel('Имя', { exact: true }).fill('Лев');
  await child.getByLabel('Возраст, лет', { exact: true }).fill('13');
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByTestId('order-total')).toHaveText('3 000 ₽');
  await expect(page.getByRole('heading', { name: 'Проверьте заказ' })).toBeFocused();
  await page.getByRole('button', { name: 'Изменить участника 2' }).click();
  await expect(child.getByLabel('Имя', { exact: true })).toBeFocused();
  await expect(child.getByLabel('Имя', { exact: true })).toHaveValue('Лев');
  await child.getByLabel('Возраст, лет', { exact: true }).fill('14');
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByTestId('order-total')).toHaveText('4 000 ₽');
  await page.getByRole('button', { name: 'Подтвердить заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toBeVisible();
  await expect(page.getByTestId('order-total')).toHaveText('4 000 ₽');
  expect(posts.filter((p) => p.endsWith('/quote'))).toHaveLength(2);
  expect(posts.filter((p) => p.endsWith('/orders'))).toHaveLength(1);
  await noOverflow(page);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-success.png`,
    fullPage: true,
  });
});
test('реальный API: отказ из-за мест только на подтверждении, черновик сохраняется', async ({
  page,
}) => {
  await fillAdult(page);
  await expect(page.getByRole('radio')).toHaveCount(0);
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
  await page.getByRole('radio', { name: 'Нет мест', exact: true }).check();
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/orders') && r.status() === 409,
  );
  await page.getByRole('button', { name: 'Подтвердить заказ' }).click();
  await response;
  await expect(page.getByRole('heading', { name: 'Места закончились' })).toBeVisible();
  const refusal = page.getByRole('alert');
  await expect(refusal).toBeFocused();
  await expect(refusal).toContainText('Не удалось оформить заказ: места закончились');
  await expect(refusal).toContainText('Заказ не создан');
  await expect(refusal).toContainText('«Повторить подтверждение»');
  await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Вернуться к проверке' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Повторить подтверждение' })).toBeEnabled();
  await expect(page.getByTestId('order-total')).toHaveText('2 000 ₽');
  await page.getByRole('button', { name: 'Изменить email' }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('anna@example.com');
  await noOverflow(page);
});
test('ошибки и основной путь доступны клавиатурой; 360px без overflow', async ({
  page,
}, testInfo) => {
  // macOS WebKit uses Option+Tab to include all controls in keyboard navigation.
  const nextControlKey =
    process.platform === 'darwin' && testInfo.project.use.browserName === 'webkit'
      ? 'Alt+Tab'
      : 'Tab';
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(
    page.getByText('Введите имя участника — поле не должно быть пустым', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Имя', { exact: true })).toBeFocused();
  await page.keyboard.type('Мария');
  await page.keyboard.press(nextControlKey);
  await expect(page.getByRole('button', { name: 'Подсказка к полю «Возраст, лет»' })).toBeFocused();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();
  await page.keyboard.press(nextControlKey);
  await expect(page.getByLabel('Возраст, лет', { exact: true })).toBeFocused();
  await page.keyboard.type('17');
  await page.keyboard.press(nextControlKey);
  await expect(page.getByRole('button', { name: 'Добавить участника' })).toBeFocused();
  await page.keyboard.press(nextControlKey);
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
  await page.keyboard.type('maria@example.com');
  await page.keyboard.press(nextControlKey);
  await expect(page.getByRole('button', { name: 'Проверить заказ' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Проверьте заказ' })).toBeFocused();
  await page.keyboard.press(nextControlKey);
  await expect(page.getByRole('button', { name: 'Изменить участника 1' })).toBeFocused();
  await page.keyboard.press(nextControlKey);
  await expect(page.getByRole('button', { name: 'Изменить email' })).toBeFocused();
  await page.keyboard.press(nextControlKey);
  await expect(page.getByRole('radio', { name: 'Успех', exact: true })).toBeFocused();
  await page.keyboard.press(nextControlKey);
  await expect(page.getByRole('button', { name: 'Подтвердить заказ' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toBeFocused();
  await noOverflow(page);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-keyboard.png`,
    fullPage: true,
  });
});
test('сетевая ошибка сохраняет данные; повтор работает с настоящим API', async ({ page }) => {
  await fillAdult(page);
  await page.route('**/api/orders/quote', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось связаться с сервером');
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('Анна');
  await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toHaveCount(0);
  await page.unroute('**/api/orders/quote');
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByRole('heading', { name: 'Проверьте заказ' })).toBeVisible();
  await noOverflow(page);
});

test('серверная проверка email привязана к полю', async ({ page }) => {
  await fillAdult(page);
  await page.getByLabel('Email', { exact: true }).fill('john..doe@example.com');
  const rejected = page.waitForResponse(
    (r) => r.url().endsWith('/api/orders/quote') && r.status() === 422,
  );
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await rejected;
  await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Email', { exact: true })).toHaveAccessibleDescription(
    'Введите email в формате name@example.com, без пробелов',
  );
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('john..doe@example.com');
  await noOverflow(page);
});

test('контекстные подсказки: сопровождающий, пустой слот, адресное редактирование email', async ({
  page,
}) => {
  await fillAdult(page);
  const rules = page.locator('details').filter({ hasText: 'Правила покупки билетов' });
  const rulesTrigger = rules.locator('summary');
  await rulesTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(rules).toHaveAttribute('open', '');
  await expect(page.getByText(/Возраст указывается в полных годах/)).toBeVisible();
  await expect(rules).toContainText('Ребёнку младше 14 лет нужен сопровождающий от 18 лет');
  await page.keyboard.press('Escape');
  await expect(rules).not.toHaveAttribute('open');
  await expect(rulesTrigger).toBeFocused();
  await expect(page.getByText(/Возраст указывается в полных годах/)).toBeHidden();
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('Анна');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('anna@example.com');
  await page.getByLabel('Возраст, лет', { exact: true }).fill('13');
  await expect(page.getByLabel('Возраст, лет', { exact: true })).toHaveAccessibleDescription(
    /Детский билет.*1\s000\s₽/,
  );
  await page.getByRole('button', { name: 'Добавить участника', exact: true }).click();
  const companion = page.getByRole('group', { name: 'Участник 2', exact: true });
  await expect(companion.getByLabel('Имя', { exact: true })).toBeFocused();
  await expect(companion.getByLabel('Имя', { exact: true })).toHaveValue('');
  await expect(companion.getByLabel('Возраст, лет', { exact: true })).toHaveValue('');
  await companion.getByLabel('Имя', { exact: true }).fill('Борис');
  await companion.getByLabel('Возраст, лет', { exact: true }).fill('17');
  await expect(page.getByRole('button', { name: 'Добавить участника', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(
    page.getByRole('group', { name: 'Состав заказа', exact: true }),
  ).toHaveAccessibleDescription(/Для ребёнка младше 14 лет нужен сопровождающий от 18 лет/);
  await expect(page.getByRole('heading', { name: 'Проверьте заказ' })).toHaveCount(0);
  await companion.getByLabel('Возраст, лет', { exact: true }).fill('18');
  await expect(page.getByRole('button', { name: 'Добавить участника', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByTestId('order-total')).toHaveText('3 000 ₽');
  await page.getByRole('button', { name: 'Изменить email' }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
  await expect(page.getByTestId('order-total')).toHaveCount(0);
  await expect(companion.getByLabel('Имя', { exact: true })).toHaveValue('Борис');
  await page.getByLabel('Email', { exact: true }).fill('updated@example.com');
  await page.getByRole('button', { name: 'Проверить заказ' }).click();
  await expect(page.getByText('updated@example.com', { exact: true })).toBeVisible();
  await expect(page.getByTestId('order-total')).toHaveText('3 000 ₽');
  await noOverflow(page);
});
