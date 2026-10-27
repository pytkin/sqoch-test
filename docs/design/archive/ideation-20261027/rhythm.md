# Группировка и ритм выбранного направления

Историческая итерация. Пользователь позже отклонил это визуальное направление.
Актуальное основание и последние варианты: [новые UI kit](../../ui-kits-20261027/README.md).
Статусы и предложения ниже описывают прежний этап, а не текущее решение.

Дата: 27 октября 2026 года. Продолжение [уточнения третьего направления](refinement.md).
Пользователь отметил, что интерфейс по-прежнему слипается: не нравятся
типографика, интервалы, видимая нумерация «Участник 1» и верхняя надпись
«Все поля обязательны».

## Последовательные редакции

- [Вертикальный ритм v3](images/option-3-refined-v3.png): каждое поле
  с собственной ошибкой расположено отдельной группой; убраны общий служебный
  текст, дублирующий заголовок участника и счётчик «1 из 4».
- [Уточнённая типографика v4](images/option-3-refined-v4.png): сохранена
  новая группировка, уменьшен визуальный вес заголовков. После обратной связи
  о потере общей группы и вида кнопки подготовлена
  [редакция v5 с единой типографикой](group-typography.md).

Использован встроенный Image Gen. Для каждого изменения приложен предыдущий
локальный растр. Файлы сохранены без масштабирования и обрезания, исходные
версии не заменены.

## Предлагаемые правила реализации

1. При одном участнике нет отдельного видимого заголовка «Участник 1».
   Заголовок раздела «Участники» сразу переходит в поля имени и возраста.
2. Для нескольких участников видимые порядковые номера также не обязательны:
   каждая группа отделяется поверхностью/интервалом и содержит своё поле имени
   и собственное действие удаления. Доступные имена групп и удаления обязаны
   различаться, включая пустые и совпадающие имена; индекс допустим как
   техническое уточнение доступного имени, без крупного видимого номера.
   Стабильные идентификаторы групп не зависят от редактируемого имени.
3. Ограничение заказа показывается словами «До 4 участников в одном заказе»
   около добавления. Счётчик не выглядит как дополнительный шаг мастера.
4. Общая надпись «Все поля обязательны» и её значок удаляются. Обязательность
   полей, required, валидация и фокус при ошибке сохраняются. Контекстная
   помощь объясняет формат и назначение конкретного поля; звёздочки по всему
   интерфейсу и новый общий баннер не добавляются.
5. Подпись → поле → собственная ошибка — одна группа. На этой форме используется
   последовательное размещение имени и возраста. Длинная ошибка возраста
   занимает доступную ширину группы и не наследует ширину короткого input.
   Ошибки разных полей не собираются в неадресный список под общей строкой.
6. Ориентиры интервалов: подпись → input 8–10 px, input → ошибка 8–10 px,
   ошибка → следующее поле 28–32 px, между разделами 40–48 px,
   ошибка email → основное действие 28–32 px. Разница внутренних и внешних
   интервалов должна быть заметна. На mobile значения уточняются проверкой
   начального viewport и длины формы, а не механическим переносом desktop.
7. Та же иерархия «поле — помощь — ошибка — следующий блок» применяется
   к кабинету организатора. Она не удаляет необходимые инструкции о дате,
   часовом поясе, проверке текста и последствиях отправки.

## Проверка при реализации

Проверить один/два/четыре участника, пустые и одинаковые имена,
добавление/удаление/возврат, адресную серверную валидацию, сохранность значений,
фокус и доступные имена. Изменения поведения требуют содержательного red/green
по правилам проекта. В текущем шаге создан растр и обновлены документы;
UI-код и действующие правила ещё не менялись.

Растр задаёт композиционную гипотезу, но не подтверждает точные шрифт/размеры.
В частности, возраст всё ещё шире запрошенного, поле сохраняет розовый оттенок,
а короткая подпись лимита получила конечную точку. Эти отклонения не заменяют
целевые параметры и редакционные правила проекта.

## Полный запрос редакции группировки

```text
Use case: ui-mockup. Refine the attached selected Sqoch UI to solve a specific usability/design critique. The attached image is the edit target, not merely a moodboard. Output ONE revised 1487 x 1058 desktop app-content image, no browser chrome, no device frame or explanatory annotations. Date anchor October 27, 2026, Europe/Moscow.

USER FEEDBACK: the softened palette is better, but the typography and spacing still feel like all the elements stick together. They dislike the redundant 'Участник 1' label and the odd generic 'Все поля обязательны' line. This revision must solve STRUCTURAL RHYTHM, not merely recolor the attached image or shrink all text.

Keep the chosen calm two-zone composition: pale blue-gray contextual LEFT sidebar and white RIGHT form workspace, subtle surface depth, slate-blue brand. Do not revert to dark contrast. Remove redundant chrome to make room for real whitespace. Maintain readable informative Russian text, minimum16px help/errors and18px body/input text. A clean neutral Inter-style regular/medium Cyrillic UI family, 400 and500 weights, no bold700/800. Title around28-30px, section titles20px, field labels16px. Distinct alignment and spacing carry the hierarchy.

CRITICAL CONTENT REMOVALS:
- Entirely REMOVE the top 'Все поля обязательны' text and its info icon; do not replace it with another global compulsory-fields banner, asterisks everywhere, a status chip, or a warning. The first thing in the main work area is the actual participants section.
- Entirely REMOVE 'Участник 1', its number and all participant-number badges.
- REMOVE '1 из 4'. It resembles step progress and is redundant with the actual page step. Use the small textual limit 'До 4 участников в одном заказе' near the add action instead.
- Do not invent an alternative per-person title for this single participant. The section title 'Участники' is sufficient.

RECOMPOSE THE FORM TO SHOW REAL BREATHING ROOM:
The right work column begins aroundx470 and has a max content width of about760px, with generous outer whitespace. Keep the left contextual area about360px wide and gently separate it with subtle depth.
Inside the main form, use ONE VERTICAL FIELD SEQUENCE, rather than the current crowded two-column inputs with a pooled error list.
Section 'Участники' at the top. Its content is one coherent white/light surface, not a card nested inside another card.
1. Field 'Имя участника', an empty wide input (about520-600px) with 'Например, Анна', then its own readable error sentence directly beneath.
2. After28-32px of clearly visible vertical space from the end of the name error, field 'Возраст, лет', a SHORT128px input. Its help/error blocks may occupy the full form width, so long text is never cramped in a128px column. The age error is immediately beneath the age input, not pooled with the name error far away. There is no second participant title.
3. Then a compact '+ Добавить участника' action with a44px minimum hit area. Under/alongside it, a quiet16px 'До 4 участников в одном заказе', followed by the child/accompanying-adult rule, or place the limit in contextual area if needed. Preserve substantive rule copy.
4. Separate the entire next 'Email для заказа' section by a distinct40-48px breathing interval or a calm subtle surface change. It should visibly read as a different logical step, not as the next sentence in the same text block.
5. Email's own persistent helper is next to its field, followed by the input and its error. Separate the primary action from that error by28-32px.

Spacing system must be visible, not just named:
- label to input8px
- input to its own error8px
- error to the NEXT FIELD label28-32px
- heading to first field24px
- major section to major section40-48px
- form error to primary CTA28-32px
- inline helper to its own action8-12px
Use noticeably smaller gaps WITHIN a field than BETWEEN fields. Do not spread every line equally and do not fill empty room with cards, dividers, ornaments or text. Keep sections softly dimensional without bulky header strips. Section title on white, not a tall tinted banner. Comfortable24-32px group padding, not huge boxes.
A main content top at~48px leaves enough height. Removing the old global notice and duplicate participant title creates space for the vertical rhythm. Fit all meaningful content cleanly in1058px height without microscopic text or clipping; recompose sensibly if needed.

ERROR STYLE:
Fine red border and a short red error sentence are enough. No large exclamation icons, no repeating red circular icons, no pink gradient or pink fill inside inputs. Errors16px/24px, normal weight, on white; preserve all exact meaning. Name and age errors are associated with their OWN field and have the full readable column width. Avoid a group of generic error bullets below unrelated controls.

Exact UI copy, reorganized but never shortened into cryptic labels:
LEFT:
sqoch.
Шаг 1 из 2 · Данные
Оформление билетов
Мероприятие Sqoch
От 14 лет — 2 000 ₽ · Младше 14 лет — 1 000 ₽
Правила покупки билетов

RIGHT:
Участники
Имя участника
[empty input placeholder] Например, Анна
[error] Введите имя участника — поле не должно быть пустым
Возраст, лет
[short empty input]
[error] Введите возраст в полных годах — целое число от 0
Добавить участника
До 4 участников в одном заказе
Ребёнку младше 14 лет нужен сопровождающий от 18 лет в том же заказе

Email для заказа
Один email для всех участников заказа. В демо письма не отправляются
[empty input placeholder] you@example.com
[error] Введите email в формате name@example.com, без пробелов

[primary button, compact about250 x52px] Проверить заказ
[quiet footer] Sqoch · тестовый проект
[quiet footer] Без оплаты и отправки писем

Do not reintroduce 'Участник 1', '1 из 4', 'Все поля обязательны', participant number badges, or any replacement boilerplate at the top. Do not add payment, authentication, real sending, extra navigation, images, dashboards, new business rules or decorative feature cards. Produce one focused practical form whose spacing clearly groups each label/input/error while separating unrelated fields and sections.
```

## Полный запрос уточнения типографики после группировки

```text
Precisely refine the attached Russian Sqoch form mockup. Keep its new vertical field layout, meaningful whitespace, pale sidebar, content, input positions, individual error placement, and removal of participant numbering. Output one1488 x1057 desktop app-content image. Date anchor October27,2026.

The only remaining emphasis to correct is TYPOGRAPHY. The attached right-hand headings are too large and heavy. Change them visibly:
- 'Участники' and 'Email для заказа' must be small calm SECTION LABELS, around21-22px Medium500, about60% of their current apparent letter height. They must be only slightly larger than the input labels. Do not render these as page hero headings.
- The sidebar title 'Оформление билетов' must be about28px Regular400, around75% of its current apparent letter height, still two lines. The logo can remain unchanged.
- 'Мероприятие Sqoch' should be18px Medium500, not another display heading.
- Field labels 'Имя участника' and 'Возраст, лет' are16px Medium500. Primary/secondary button labels18px Medium500. No heavy bold anywhere.
- Input/body text18px Regular400. Error and helper text16px/24px Regular400, never smaller. Use a neutral, understated Cyrillic sans-serif UI family with open counters. Typography should look compact and light while every sentence remains comfortably readable.
- Do not increase font sizes to fill the space made available by removing 'Участник 1' and 'Все поля обязательны'.

Preserve the new RHYTHM exactly: label to input8-10px, input to its own error8-10px, error to next field28-32px, between major groups40-48px, to final primary action28-32px. Maintain the separate vertical name and age fields. Keep long errors directly under their own field and on the full readable column width. Avoid equal spacing everywhere.
Keep the input boxes white with thin red borders, with NO pink gradient inside. Age field should be visibly SHORT, around128-144px wide at this image width, not220px. Name and email remain comfortably wide, not full-viewport. Existing subtle surface depth can remain. Do not add new boundaries, cards or decoration.

Keep ALL substantive Russian copy unchanged from the attached image, including full informative error and help sentences. 'До 4 участников в одном заказе' is a short helper and must have no trailing full stop. Preserve 'Добавить участника', the accompanying-adult rule, 'Проверить заказ', tariffs and quiet footer. Absolutely do not reintroduce 'Участник 1', '1 из 4', 'Все поля обязательны', number badges, general error banners, extra headings, navigation, payment or features. No large warning icons. No comments outside the actual UI. Make this an intentionally restrained product form, with the existing generous grouping, and noticeably smaller, lighter section titles.
```
