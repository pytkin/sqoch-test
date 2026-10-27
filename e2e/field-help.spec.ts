import { expect, test } from '@playwright/test';

test.use({ hasTouch: true });

test('помощь возраста: hover, Escape, touch, reflow и неподвижная форма', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const help = page.getByRole('button', { name: 'Подсказка к полю «Возраст, лет»', exact: true });
  const age = page.getByLabel('Возраст, лет', { exact: true });
  const tooltip = page.getByRole('tooltip');
  for (const width of [320, 360, 719, 720, 768, 1440]) {
    // Keep resizing from moving the help trigger under a resting mouse pointer.
    await page.mouse.move(0, 0);
    await age.focus();
    await page.setViewportSize({ width, height: 800 });
    await age.scrollIntoViewIfNeeded();
    const before = await age.evaluate((input) => input.getBoundingClientRect().top + scrollY);
    await expect(tooltip).toBeHidden();
    await page.mouse.move(0, 0);
    await age.focus();
    await help.hover();
    await expect(tooltip).toHaveText(
      'Укажите число полных лет. Если ребёнку ещё нет года, введите 0',
    );
    const bounds = await tooltip.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const inputBounds = await age.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(inputBounds!.y);
    await tooltip.hover();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await expect(age).toBeFocused();
    await help.tap();
    await expect(tooltip).toBeVisible();
    const target = await help.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(44);
    expect(target!.height).toBeGreaterThanOrEqual(44);
    if (width === 360 || width === 1440) {
      await page.screenshot({ path: testInfo.outputPath(`age-help-${width}.png`) });
    }
    await help.tap();
    await expect(tooltip).toBeHidden();
    const after = await age.evaluate((input) => input.getBoundingClientRect().top + scrollY);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByRole('button', { name: 'Добавить участника', exact: true }).click();
  const second = page.getByRole('group', { name: 'Участник 2', exact: true });
  await second.getByRole('button', { name: 'Подсказка к полю «Возраст, лет»' }).tap();
  await expect(second.getByRole('tooltip')).toBeVisible();
  await page.getByRole('heading', { name: 'Оформление билетов' }).click();
  await expect(page.getByRole('tooltip')).toBeHidden();
});
