import { expect, test } from '@playwright/test';

test('футер не мелькает на месте формы во время загрузки мероприятия', async ({
  page,
}, testInfo) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/event', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/');
  try {
    await expect(page.getByText('Загружаем данные мероприятия…')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('event-loading-layout.png') });
    await expect(page.locator('.site-footer')).not.toBeInViewport();
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { name: 'Оформление билетов' })).toBeVisible();
  await expect(page.locator('.site-footer')).not.toBeInViewport();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`иконки действий различимы при forced colors: ${colorScheme}`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ forcedColors: 'active', colorScheme });
    await page.goto('/');
    await page.getByRole('button', { name: 'Добавить участника', exact: true }).click();
    const remove = page.getByRole('button', { name: 'Удалить участника 1', exact: true });
    await remove.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`forced-colors-${colorScheme}.png`) });
    const icon = await remove.locator('.icon').screenshot();
    const paintedColors = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const colors = new Set<string>();
      for (let index = 0; index < data.length; index += 4) {
        colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
      }
      image.close();
      return colors.size;
    }, icon.toString('base64'));
    expect(paintedColors).toBeGreaterThan(1);
    await expect(remove).toHaveAccessibleName('Удалить участника 1');
    const target = await remove.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(44);
    expect(target!.height).toBeGreaterThanOrEqual(44);
    await remove.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(remove).toBeFocused();
    await expect(remove).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('group', { name: /^Участник \d$/ })).toHaveCount(1);
  });
}

test('форма и результат сохраняют reflow на 320px и вокруг breakpoint', async ({
  page,
}, testInfo) => {
  for (const width of [320, 360, 719, 720, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await page.getByLabel('Имя', { exact: true }).fill('Анна');
    await page.getByLabel('Возраст, лет', { exact: true }).fill('18');
    await page.getByLabel('Email', { exact: true }).fill('anna@example.com');
    await page.getByRole('button', { name: 'Добавить участника', exact: true }).click();
    const child = page.getByRole('group', { name: 'Участник 2', exact: true });
    await child.getByLabel('Имя', { exact: true }).fill('Александра Соколова-Долгорукова');
    await child.getByLabel('Возраст, лет', { exact: true }).fill('13');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Проверить заказ', exact: true }).click();
    await expect(page.getByTestId('order-total')).toHaveText('3 000 ₽');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 320 || width === 720) {
      await page.screenshot({ path: testInfo.outputPath(`reflow-${width}.png`), fullPage: true });
    }
    await page.getByRole('button', { name: 'Подтвердить заказ', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Заказ подтверждён' })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});
