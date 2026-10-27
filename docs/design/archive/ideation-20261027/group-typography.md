# Группа участника, добавление и единая типографика

Историческая итерация. Пользователь позже отклонил это визуальное направление.
Актуальное основание и последние варианты: [новые UI kit](../../ui-kits-20261027/README.md).
Статусы и предложения ниже описывают прежний этап, а не текущее решение.

Дата: 27 октября 2026 года. Продолжение [редакции ритма](rhythm.md).
Пользователь отметил, что форма стала свободнее, но потерялась общая группа
полей участника, а добавление выглядит отдельной ссылкой. Запрошено согласовать
font-size, letter-spacing, line-height и font-weight на всей странице.

## Предложенная редакция

[Макет v5](images/option-3-refined-v5.png) показан в чате.
Он продолжает выбранное пользователем третье направление и уточнения v1–v4.
Его окончательное принятие ожидается. Исходные варианты не заменены.

Использован встроенный Image Gen с приложенным локальным макетом v4.
Полный запрос сохранён ниже. Файл результата скопирован без преобразования;
оригинал в каталоге генерации сохранён.

## Состав и границы группы

- Одна общая поверхность секции «Участники», с тонкой различимой границей,
  небольшим радиусом и сдержанным объёмом. Имя, возраст и их собственные ошибки
  воспринимаются как данные одного человека. Вложенных карточек полей нет.
- Внизу той же секции находится связанная зона добавления: настоящая
  вторичная кнопка с границей и заливкой, плюс внутри, затем лимит и правило
  сопровождения. Добавление не оформляется подчёркнутой ссылкой.
- Список участников и зона добавления — разные семантические части одной
  секции. При нескольких людях их группы повторяются, а кнопка добавления
  остаётся общей в конце списка; её не нужно дублировать у каждого человека.
- Видимые «Участник 1», «1 из 4» и «Все поля обязательны» не возвращаются.
  Различимые доступные имена при пустых/одинаковых именах и стабильные ID
  сохраняются по правилам предыдущей итерации.
- Email расположен отдельным разделом за пределами группы участников.
  Основная кнопка проверки отличается от добавления заполнением и приоритетом,
  но использует те же размер, вес и трекинг текста кнопок.

## Целевая типографическая шкала

Это точные предлагаемые параметры реализации, а не измерения растра.
Исследуется одна нейтральная гарнитура с кириллицей по образцу Inter.
Фактический шрифт Image Gen не подтверждён; новая гарнитура и её локальный
файл ещё не утверждены. Действующие токены до принятия принадлежат
[дизайн-системе](../../../design-system.md).

| Роль                         | font-size                  | line-height                | font-weight | letter-spacing |
| ---------------------------- | -------------------------- | -------------------------- | ----------- | -------------- |
| Заголовок страницы           | 28 px                      | 36 px                      | 500         | -0.015em       |
| Заголовки разделов           | 20 px                      | 28 px                      | 500         | -0.005em       |
| Название мероприятия         | 18 px                      | 28 px                      | 500         | 0              |
| Основной текст, тарифы, ввод | 18 px                      | 28 px                      | 400         | 0              |
| Подписи полей                | 16 px                      | 24 px                      | 500         | 0              |
| Подсказки и ошибки           | 16 px                      | 24 px                      | 400         | 0              |
| Первичная и вторичная кнопки | 18 px                      | 24 px                      | 500         | 0              |
| Шаг, метаданные и футер      | 16 px                      | 24 px                      | 400         | 0              |
| Текстовые ссылки             | По роли окружающего текста | По роли окружающего текста | 400         | 0              |

Существующий брендовый wordmark сохраняется отдельно от текстовых ролей;
не нужно имитировать его новым случайным шрифтом. Отрицательный трекинг
применяется только к заголовкам, без искусственного разрежения подписей.
Веса 400/500 создают основную иерархию без повсеместного bold. Текст
не уменьшается ниже 16 px для подгонки; длинные предложения переносятся.
На mobile сохраняются читаемость и роли, а ширина и компоновка адаптируются.

## Интервалы и размеры

| Отношение                                  | Ориентир |
| ------------------------------------------ | -------- |
| Внутренние поля общей поверхности          | 24–28 px |
| Заголовок секции → первое поле             | 24 px    |
| Подпись → input                            | 8 px     |
| Input → собственная ошибка                 | 8 px     |
| Конец ошибки → следующее поле              | 24–28 px |
| Поля участника → связанная зона добавления | 24 px    |
| Кнопка добавления → помощь                 | 8–12 px  |
| Секция участников → Email                  | 40 px    |
| Ошибка email → основное действие           | 28–32 px |

Кнопки и input — ориентировочно 52 px высоты; область нажатия не меньше
44 px. Вторичная кнопка имеет видимую границу, спокойную заливку, плюс
около 20 px и текст на том же baseline. Имя/email ограничены разумной
шириной порядка 520–600 px, возраст — около 128–144 px. Длинная ошибка
возраста использует ширину группы и не ограничена коротким input.

## Границы доказательства и приёмка

Растр подтверждает направление композиции: поверхность группы восстановлена,
кнопка добавления имеет рамку и находится внутри секции. Он не доказывает
точные CSS-параметры, контраст, фактический шрифт или адаптивность.
В частности, возраст и поля по-прежнему шире запрошенного, плюс крупнее
ориентира, а короткие подписи получили конечные точки. В код не следует
переносить эти случайные отклонения генерации.

После принятия направления проверить фактические computed styles всех
текстовых ролей, реальный локальный шрифт, переносы и baseline иконки/кнопки.
Проверить один/два/четыре участника, добавление/удаление/возврат, пустые и
совпадающие имена, все ошибки, 320/360/720/1440 px, клавиатуру и 200% zoom.
Тот же набор ролей применяется к кабинету организатора: отдельные случайные
font-size/weight на каждой форме не вводятся. Содержательные инструкции
о переносе, часовом поясе, отправке и восстановлении сохраняются.

В текущем шаге UI-код, поведение, API и зависимости не менялись. Сохранены
растровая редакция и предлагаемые правила. Поведенческие изменения далее
следуют TDD и независимому ревью по правилам проекта.

## Полный запрос Image Gen

```text
Use case: ui-mockup, focused revision of an already selected product direction.
EDIT the attached Russian Sqoch form mockup. Keep its pale contextual sidebar, calm colors, readable full copy and uncluttered overall form. Output ONE coherent1489 x1056 desktop app-content frame, matching this reference. No browser chrome, comparison board, concept labels or device frame. Date anchor October27,2026, Europe/Moscow.

User feedback to solve:
1. The previous revision improved spacing but LOST THE GROUPING of name and age as one participant.
2. 'Добавить участника' now floats detached and looks like a link, not a button.
3. Balance ALL typography together: font-size, line-height, font-weight and letter-spacing across sidebar, headings, fields, helpers, errors, actions and footer.

STRUCTURE AND GROUPING — make a clearly visible change from the supplied image:
- The right-hand 'Участники' section has ONE shared lightly elevated white working surface, with a fine blue-gray boundary (#D5DDE4), restrained8px radius and24-28px internal padding. No huge shadow or tall colored header strip.
- Include the section heading 'Участники' and ALL participant-related content INSIDE that shared surface. The name and age fields are visibly one unit, in a vertical sequence. Their errors remain directly beneath their own input, never pooled in an unrelated list. There is no separate participant-number title.
- In the same surface, immediately AFTER the age error, create a modest connected footer zone for the add action and its instructions. A subtle surface tint or fine separator may mark this footer, but keep it unmistakably PART OF the participants section.
- 'Добавить участника' is a REAL SECONDARY BUTTON: visible thin slate-blue outline, very pale blue fill,6px corners,52px height, around260px width, a small20px plus INSIDE the button before the label. Label18px Medium, no underline. The plus is NOT a large separate symbol. Do not render it as bare text or a hyperlink.
- The short helper 'До 4 участников в одном заказе' is close to that button. The full child/accompanying-adult rule follows below within the SAME connected footer.
- Do not enclose each field in a card. The whole participant section is one meaningful grouped surface; its internal fields need no extra nested boxes. For future multiple participants, this group treatment can repeat while the collection footer remains shared. Do NOT add a second person to this particular screenshot.
- Email is a separate unboxed section OUTSIDE the participant surface, with40px separation. The primary confirm/calculation action follows Email. Visually distinguish secondary add vs primary 'Проверить заказ'.
- Keep the name and email inputs comfortably bounded, around520-600px wide; age input short around128-144px. Long error messages can use the full inner content width, NOT the short input width.
- The right working column should be roughly800px wide, not an ocean of viewport-wide inputs. Keep generous outer white space without widening controls merely to fill room.

ONE COHERENT TYPOGRAPHY SYSTEM:
Use one neutral Inter-style Cyrillic sans-serif family. No mixture of display/condensed/wide fonts, no decorative type, no bold700/800, no very light300. Font/spacing sizes below are UI design targets and their RELATIONSHIPS must be visible:
- brand wordmark: keep the actual recognizable sqoch. mark from the reference, proportionally around32px text height; do not make it huge.
- Page heading 'Оформление билетов':28px font /36px line-height, Medium500, letter-spacing -0.015em. This must be only around1.5x body text, never a giant marketing hero heading.
- Section headings 'Участники' and 'Email для заказа':20px /28px, Medium500, letter-spacing -0.005em. They must be slightly larger than labels, visibly smaller than the page heading.
- Event title 'Мероприятие Sqoch':18px /28px, Medium500, letter-spacing0.
- Body, tariffs and input values:18px /28px, Regular400, letter-spacing0.
- Field labels:16px /24px, Medium500, letter-spacing0.
- Helpers, errors, step/meta/footer:16px /24px, Regular400, letter-spacing0.
- BOTH primary and secondary button labels:18px /24px, Medium500, letter-spacing0. Equal typographic scale for both; color/fill expresses priority.
No all-caps, artificial wide tracking or needlessly heavy labels. Do not shrink helper/error text below16px, delete sentences, or enlarge heading text to fill open space. Keep line lengths comfortable, roughly55-65characters perline. Long helpers may wrap naturally.

VISIBLE RHYTHM:
- Section heading to first field24px.
- Label to input8px.
- Input to its own error8px.
- From end of one field's error to next field's label24-28px.
- Participant field area to its connected add footer24px.
- Button to helper8-12px.
- Participants surface to separate Email section40px.
- Email error to primary action28-32px.
- Footer quieter and clearly separated.
Preserve these differentiated spacings; do not make every gap equal. The group must feel cohesive, and different sections must feel distinct.

COLOR:
Pale sidebar #E7EDF2, near-white work area, slate text #3D4855, muted #63717D, primary #536B83. Participant group has an actual visible but restrained edge and slight depth. Error #AD2632 as NORMAL WEIGHT text plus fine red input border; input interiors WHITE, NO pink fill or gradient. No large repeated red exclamation icons. Keep words readable on every surface, not low-contrast pale typography.

Exact substantive Russian copy:
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
[wide empty input] Например, Анна
[own error] Введите имя участника — поле не должно быть пустым
Возраст, лет
[short empty input]
[own error] Введите возраст в полных годах — целое число от 0

[outlined secondary BUTTON with small plus inside] Добавить участника
До 4 участников в одном заказе
Ребёнку младше 14 лет нужен сопровождающий от 18 лет в том же заказе

[separate section] Email для заказа
Один email для всех участников заказа. В демо письма не отправляются
[wide empty input] you@example.com
[own error] Введите email в формате name@example.com, без пробелов

[filled slate primary BUTTON] Проверить заказ
[quiet footer] Sqoch · тестовый проект
[quiet footer] Без оплаты и отправки писем

Do not reintroduce 'Участник 1', '1 из 4', 'Все поля обязательны', number badges or general notices. Short labels/helpers have no trailing full stop; meaningful multi-sentence explanations retain punctuation. No added features, payment, authentication, external sending, extra navigation or decorative metrics. Fit the frame cleanly with no clipping or minified text. This is one focused form demonstrating a grouped participant surface, an unmistakable connected add BUTTON and a balanced typographic hierarchy.
```
