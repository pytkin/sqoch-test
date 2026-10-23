import { test, expect } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';

type Geometry = { documentY: number; width: number; height: number };
type FormGeometry = Record<'firstName' | 'email' | 'add' | 'submit', Geometry>;

test.use({ reducedMotion: 'reduce' });

async function geometry(locator: Locator): Promise<Geometry> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { documentY: rect.top + window.scrollY, width: rect.width, height: rect.height };
  });
}

async function settleLayout(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function formGeometry(page: Page): Promise<FormGeometry> {
  await settleLayout(page);
  const first = page.getByRole('group', { name: 'Участник 1', exact: true });
  return {
    firstName: await geometry(first.getByLabel('Имя', { exact: true })),
    email: await geometry(page.getByLabel('Email', { exact: true })),
    add: await geometry(page.locator('.add-button')),
    submit: await geometry(page.getByRole('button', { name: 'Проверить заказ', exact: true })),
  };
}

function expectUnchanged(actual: Geometry, expected: Geometry, state: string) {
  for (const property of ['documentY', 'width', 'height'] as const) {
    expect
      .soft(Math.abs(actual[property] - expected[property]), `${state}: ${property}`)
      .toBeLessThanOrEqual(1);
  }
}

async function attachGeometry(testInfo: TestInfo, name: string, samples: unknown) {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(samples, null, 2)),
    contentType: 'application/json',
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Оформление билетов' })).toBeVisible();
  await settleLayout(page);
});

test('ввод возраста не сдвигает имя, email и действия формы', async ({ page }, testInfo) => {
  const first = page.getByRole('group', { name: 'Участник 1', exact: true });
  const age = first.getByLabel('Возраст, лет', { exact: true });
  const initial = await formGeometry(page);
  const samples: { age: string; geometry: FormGeometry }[] = [{ age: '', geometry: initial }];

  for (const value of ['1', '18', '', '13', '14', '17', '18']) {
    await age.fill(value);
    await expect(age).toHaveValue(value);
    const current = await formGeometry(page);
    samples.push({ age: value, geometry: current });
    for (const element of ['firstName', 'email', 'add', 'submit'] as const) {
      expectUnchanged(current[element], initial[element], `возраст «${value}», ${element}`);
    }
  }

  await attachGeometry(testInfo, 'age-layout.json', samples);
});

test('зона тарифа постоянна, а название добавления не зависит от возраста', async ({
  page,
}, testInfo) => {
  const first = page.getByRole('group', { name: 'Участник 1', exact: true });
  const age = first.getByLabel('Возраст, лет', { exact: true });
  const status = first.locator('.participant-status');
  const add = page.getByRole('button', { name: 'Добавить участника', exact: true });
  await expect(status).toBeVisible();
  await expect(status).toBeEmpty();
  await expect(age).toHaveAccessibleDescription('Полных лет; 0 — до года');
  const initial = await geometry(status);
  expect(initial.height).toBeGreaterThan(0);
  const samples = [{ age: '', geometry: initial }];

  for (const value of ['1', '18', '', '13', '14', '17', '18']) {
    await age.fill(value);
    await expect(age).toHaveValue(value);
    await expect(add).toBeVisible();
    await expect(status).toBeVisible();
    if (value) {
      const tariff = Number(value) < 14 ? /Детский билет.*1\s000\s₽/ : /Полный билет.*2\s000\s₽/;
      await expect(status).toContainText(tariff);
      await expect(age).toHaveAccessibleDescription(tariff);
    } else {
      await expect(status).toBeEmpty();
      await expect(age).toHaveAccessibleDescription('Полных лет; 0 — до года');
      await expect(status).not.toContainText(/билет.*₽/);
    }
    await settleLayout(page);
    const current = await geometry(status);
    samples.push({ age: value, geometry: current });
    expectUnchanged(current, initial, `зона тарифа, возраст «${value}»`);
  }

  await attachGeometry(testInfo, 'status-layout.json', samples);
});

test('добавление, удаление второго и отмена не сдвигают первую строку', async ({
  page,
}, testInfo) => {
  const first = page.getByRole('group', { name: 'Участник 1', exact: true });
  await first.getByLabel('Имя', { exact: true }).fill('Анна');
  await first.getByLabel('Возраст, лет', { exact: true }).fill('18');
  const initial = await formGeometry(page);
  const samples = [{ state: 'один участник', geometry: initial }];

  await page.getByRole('button', { name: 'Добавить участника', exact: true }).click();
  const second = page.getByRole('group', { name: 'Участник 2', exact: true });
  await expect(second.getByLabel('Имя', { exact: true })).toBeFocused();
  await expect(second.getByLabel('Имя', { exact: true })).toHaveValue('');
  await expect(second.getByLabel('Возраст, лет', { exact: true })).toHaveValue('');
  const added = await formGeometry(page);
  samples.push({ state: 'добавлен пустой второй', geometry: added });
  expectUnchanged(added.firstName, initial.firstName, 'добавление 1 → 2, имя первого');
  expect(added.email.documentY).toBeGreaterThan(initial.email.documentY);

  await second.getByLabel('Имя', { exact: true }).fill('Борис');
  await second.getByLabel('Возраст, лет', { exact: true }).fill('18');
  const filled = await formGeometry(page);
  await page.getByRole('button', { name: 'Удалить участника 2', exact: true }).click();
  await expect(second).toHaveCount(0);
  const removed = await formGeometry(page);
  samples.push({ state: 'удалён второй', geometry: removed });
  expectUnchanged(removed.firstName, initial.firstName, 'удаление второго, имя первого');

  await page.getByRole('button', { name: 'Вернуть участника', exact: true }).click();
  await expect(second.getByLabel('Имя', { exact: true })).toHaveValue('Борис');
  await expect(second.getByLabel('Возраст, лет', { exact: true })).toHaveValue('18');
  const restored = await formGeometry(page);
  samples.push({ state: 'восстановлен второй', geometry: restored });
  expectUnchanged(restored.firstName, initial.firstName, 'отмена удаления, имя первого');
  for (const element of ['email', 'add', 'submit'] as const) {
    expectUnchanged(restored[element], filled[element], `отмена удаления, ${element}`);
  }

  await attachGeometry(testInfo, 'participants-layout.json', samples);
});
