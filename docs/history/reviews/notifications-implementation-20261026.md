# Этап 2: итоговое ревью реализации

Дата: 26.10.2026. SQOCH-29: **PASS**, открытых подтверждённых P0–P2 нет.
Новый независимый рецензент рассмотрел конечный tracked diff и новые файлы
второго этапа после завершения срезов 21–28. Автор исправлял замечания;
рецензент работал read-only и повторно проверял затронутые границы.

Это исторический результат SQOCH-29. Ссылки ниже ведут к документам,
которые позднее обновлялись; последующие изменения SQOCH-31–44 и нового
сценария переноса этим PASS не охвачены. Текущие правила и результаты
перечислены в [индексе документации](../../README.md).

Основание — [бизнес-требования](../../notifications.md),
[контракт и тест-каталог](../../notifications-contract.md),
[технические решения](../../notifications-technical.md) и
[фактическая приёмка](../../acceptance.md). Предыдущее
[ревью проектного решения](notifications-architecture-20261026.md) — отдельный исторический
артефакт, оно не заменяет это ревью реализации.

## Архитектурные выводы

- SQLite владеет сохранённым состоянием. Проверка источников, перенос даты,
  неизменяемый снимок рассылки и задания фиксируются одной транзакцией.
  Read-транзакции исключают смешение старого draft с новыми deliveries.
  Init/load/reset и worker имеют явные блокировки и владельцев.
- Worker фиксирует claim и попытку до сети. Неопределённый результат SMTP
  остаётся unknown; resume не разрешает слепую переотправку. После аварии
  используется точная сверка Mailpit. CAS защищает sent от позднего
  отрицательного результата сверки.
- AI-инструменты только читают события. SQL, SMTP, confirm и произвольные
  URL модели недоступны. Проверяются схема, ID, бюджеты, размер ответа,
  общий deadline, phase и revision после сети. Дата модели — подсказка.
- UI сохраняет форму до AI/preview. Потерянный confirm проверяется по тому
  же ID; исторический preview после reload не открывает подтверждение.
  Abort/epoch отсекают поздние callbacks. Текст модели отображается буквально.
- Обычные проверки отделены от настоящих интеграций. E2E имеют свою SQLite
  и явно названные doubles; Compose закрепляет файл, project, cwd и env-file.
  Один локальный worker и 20 покупок не требуют ORM, брокера или lease-системы.

## Существенные отказы

| Отказ                                         | Сдерживание                                      | Восстановление и предел                                        |
| --------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| Чужая/неполная схема, ошибка миграции         | Отказ запуска, rollback DDL/version              | Автоматического уничтожения чужой БД нет                       |
| Конкурентный/repeat confirm, потерянный ответ | BEGIN IMMEDIATE, token, revision, snapshot       | GET той же campaign без нового эффекта                         |
| SMTP250 → crash до commit                     | sending → unknown при новом worker               | Точный Mailpit readback; отсутствие письма не разрешает resend |
| Постоянный отказ/исчерпание попыток           | Сохранённый бюджет ≤5, terminal failed           | Кнопка и restart не сбрасывают счётчик                         |
| AI timeout/invalid/stale result               | Нет частичного применения                        | Прежний сохранённый draft, ручное редактирование               |
| Ошибка сохранения/поздний UI callback         | Ошибка у действия, сохранение ввода, abort/epoch | Возврат читает серверное состояние                             |
| Операторское Compose-окружение                | Явные file/project/cwd/env-file                  | Регрессия проверяет фактические argv/env                       |

## Полная матрица методов

Единицы: **D** — SQLite/миграции/fixtures/locks; **C** — campaign/API/контракт;
**W** — worker/SMTP/Mailpit/recovery; **A** — DeepSeek; **U** — organizer UI/
навигация/shared TS; **H** — запуск/test harness/изоляция; **X** — композиция,
документы и готовность всего решения.

**S = selected**. N означает not-selected с указанной причиной:
N0 — нет исполняемого изменения; N1 — системный вопрос рассмотрен в X;
N2 — реализация существует, предварительная feasibility не требуется;
N3 — нет собственного доменного решения; N4 — алгоритмы принадлежат другим
единицам; N5 — нет отдельной операторской процедуры; N6 — готовность
оценивается в X; N7 — нет отдельной нагрузочной цели или наблюдаемого capacity
concern; N8 — пользовательская поверхность рассмотрена в U. Blocked-методов нет.

| Метод                      | D   | C   | W   | A   | U   | H   | X   |
| -------------------------- | --- | --- | --- | --- | --- | --- | --- |
| code-quality               | S   | S   | S   | S   | S   | S   | N0  |
| architecture               | S   | S   | S   | S   | S   | S   | S   |
| comprehensive-architecture | N1  | N1  | N1  | N1  | N1  | N1  | S   |
| flow                       | S   | S   | S   | S   | S   | S   | S   |
| feasibility                | N2  | N2  | N2  | N2  | N2  | N2  | N2  |
| contract                   | S   | S   | S   | S   | S   | S   | S   |
| domain-logic               | S   | S   | S   | S   | S   | N3  | N3  |
| algorithm                  | S   | S   | S   | S   | S   | S   | N4  |
| security-threat-model      | S   | S   | S   | S   | S   | S   | S   |
| privacy-data               | S   | S   | S   | S   | S   | S   | S   |
| failure-mode-fmea          | S   | S   | S   | S   | S   | S   | S   |
| operational-tabletop       | S   | N5  | S   | N5  | S   | S   | S   |
| release-readiness          | N6  | N6  | N6  | N6  | N6  | N6  | S   |
| test-strategy              | S   | S   | S   | S   | S   | S   | S   |
| documentation              | S   | S   | S   | S   | S   | S   | S   |
| traceability               | S   | S   | S   | S   | S   | S   | S   |
| performance-capacity       | N7  | N7  | S   | S   | N7  | N7  | N7  |
| ux-cognitive-walkthrough   | N8  | N8  | N8  | N8  | S   | N8  | N8  |

## Покрытие согласованного объёма

Вердикт covered относится к указанным flow/evidence, а не к внешней доставке
или произвольному будущему deployment. Точные тестовые файлы и T-ID находятся
в [каталоге](../../notifications-contract.md#каталог-проверок-по-срезам).

| ID   | Вердикт | Рассмотренное evidence                                                              |
| ---- | ------- | ----------------------------------------------------------------------------------- |
| N-01 | covered | Fixtures/store/recipients; clean startup: 2 мероприятия, 20 покупок                 |
| N-02 | covered | AI whitelist/context/budgets; авторские первичные live DeepSeek tool outputs        |
| N-03 | covered | Серверный preview и UI: мероприятие, обе даты, тема/текст, полный список8           |
| N-04 | covered | PATCH/rewrite contracts; снятие review; сохранение перед AI                         |
| N-05 | covered | Active/cancelled/case/trim/cross-event; независимый readback8+5                     |
| N-06 | covered | Atomic confirm/rollback; worker читает сохранённые задания                          |
| N-07 | covered | Concurrent/repeat confirm, immutable campaign/MIME, lost-response E2E               |
| N-08 | covered | Counters/status, attempts/errors/unknown, runtime DTO guards                        |
| N-09 | covered | SMTP phases, общий бюджет5, resume/restart, настоящий451                            |
| N-10 | covered | SQLite, OS stop/crash/locks, API/Mailpit restart, авторский browser-close           |
| N-11 | covered | Exact Message-ID/raw MIME/CAS; missing/deleted/unavailable остаются unknown         |
| N-12 | covered | Sender451 integration, demo:failure, конечный Mailpit readback                      |
| N-13 | covered | Ошибки AI/save/validation, late callbacks/deadlines без потери draft/ложного успеха |
| N-14 | covered | Moscow/ISO/now boundary; AI suggestion-only; явный ручной ввод                      |
| N-15 | covered | Event/purchase snapshots, stale revision, новый preview и review                    |
| N-16 | covered | Contract check, 492-test evidence, clean setup/startup, booking regression          |

## Независимые проверки и предел доказательства

Рецензент самостоятельно выполнил:

- 49 тестов `test_campaign_flow.py`, `test_reconcile.py`,
  `test_worker_process.py` — green;
- `contracts:check`, regression `scripts/test-mailpit.test.mjs` и
  `git diff --check` — green;
- read-only SQLite + production MailpitClient: 13/13 matched. В рассылке8
  семь адресов имеют attempts1, один attempts2; в рассылке5 — attempts2.
  Проверены точный Message-ID без дублей, From/To/Subject/plain-text;
- осмотр актуальных desktop/mobile PNG и сверка SHA-256 clean manifest.

Полный verify самостоятельно повторно не запускался: его 112 frontend +288
backend +28 tooling +64 E2E =492 подтверждены отдельным clean evidence и
совпадением исполняемого кода/конфигурации/lockfiles. Проверены также результаты
clean setup/startup и освобождение портов/locks. Последующие изменения были
документационными и обновлением PNG; финальные docs/format проверяются отдельно.

Настоящие DeepSeek, последовательность ручных UI-действий, browser-close и
axe — первичные tool outputs авторской задачи, а не лично повторённые
рецензентом действия. SMTP readback13 подтверждён независимо. Известный
Starlette/HTTPX deprecation warning сохранён и не скрывается.

В финальном ревью найден P3: дизайн-система называла кабинет ещё не
реализованным. Автор исправил статус, рецензент повторно прочитал изменение.
Открытых findings не осталось. Закрытые поведенческие замечания прошлых
срезов и их red/green описаны в [приёмке](../../acceptance.md).

Готовность относится к согласованному локальному демо. Не заявлены внешняя
доставка, public deployment, SMTP exactly-once, чистая ОС или исследование со
screen reader/физическими устройствами. Clean-копия использовала package/
browser caches той же машины. Видео SQOCH-30 отложено до отдельного указания;
оно не является функциональным пробелом этого handoff.
