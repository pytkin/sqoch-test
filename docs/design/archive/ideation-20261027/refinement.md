# Уточнение выбранного направления Sqoch

Историческая итерация. Пользователь позже отклонил это визуальное направление.
Актуальное основание и последние варианты: [новые UI kit](../../ui-kits-20261027/README.md).
Статусы и предложения ниже описывают прежний этап, а не текущее решение.

Последняя предложенная редакция — [v5](images/option-3-refined-v5.png).
Она возвращает группу участника и полноценную кнопку добавления; параметры
типографики всей страницы зафиксированы [в отдельном уточнении](group-typography.md).
Окончательное принятие ожидается. Описание новой группировки, правил
нумерации и полные запросы — [в следующей итерации](rhythm.md).

Дата: 27 октября 2026 года. Пользователю ближе третий фактически показанный
вариант из [исходного исследования](README.md), но он отметил
избыточный контраст, громоздкость элементов и доминирование типографики.
Это предпочтение направления с запросом доработки; окончательное принятие
новой дизайн-системы и гарнитуры пока не зафиксировано.

Исходный [третий вариант](images/option-3.png) сохранён без изменений.
Доработка касается общей системы обеих волн; сравнение проводится на той же
форме билетов с ошибками, без изменения бизнес-правил или UI-кода.

## Результаты

- [Первая редакция](images/option-3-refined-v1.png): смягчён фон,
  убраны крупный номер участника и сплошная рамка добавления. При просмотре
  обнаружено, что визуальная масса заголовков снизилась недостаточно.
- [Уточнение типографики](images/option-3-refined-v2.png): более
  лёгкое начертание заголовков и действий; ошибки имени и возраста вынесены
  в отдельные широкие строки. После обратной связи подготовлены редакции
  группировки v3/v4 в следующей итерации.

Первые два PNG — 1487×1058. Использован встроенный Image Gen, приложен реальный
локальный растр предыдущей редакции. Исходники в каталоге генерации сохранены.
Файлы проекта скопированы без масштабирования и обрезания.

## Проверяемая гипотеза

В исходном эскизе внимание одновременно притягивают тёмная контекстная
область, крупный жирный заголовок, заголовки секций, плашки и большой маркер
участника. Основная гипотеза — уменьшить конкуренцию акцентов, сохранив
постоянную информативную помощь и ясное разделение разделов.

Первая редакция запрошена с Commissioner. Для второй в запросе исследуется
более нейтральное начертание по образцу Inter, веса 400/500. Это предложение
гарнитуры, а не подтверждение её фактического использования в растре.

Ориентиры следующего прототипа, если редакция будет принята:

| Роль                    | Ориентир                                              |
| ----------------------- | ----------------------------------------------------- |
| Заголовок страницы      | 28–30 / 36–38 px, вес 400–550                         |
| Названия разделов       | 18–20 / 26–28 px, вес 500                             |
| Участник                | 18 / 28 px, вес 500                                   |
| Основной текст и ввод   | 17–18 / 26–28 px, вес 400                             |
| Подписи, помощь, ошибки | 16 / 24 px, вес 400–500                               |
| Контролы                | 48–52 px высоты, цель нажатия не меньше 44 px         |
| Возраст                 | Короткий input около 128 px; отдельная широкая ошибка |

Это исследуемые пропорции; принятые числовые токены ещё принадлежат
[дизайн-системе](../../../design-system.md). По Image Gen нельзя подтвердить точную
гарнитуру, CSS-размеры, межстрочные интервалы, контраст или адаптивность.
В частности, растр всё ещё показывает более широкое поле возраста и отдельные
градиенты, чем запрошено. Их не следует автоматически переносить в код.

Содержательные тексты сохраняются. Исправления E1–E5 из
[аудита ошибок](../../../history/reviews/error-messages-20261027.md) остаются обязательными при реализации.
В текущем шаге UI-код, зависимости и шрифтовые файлы не менялись.

## Полный запрос первой редакции

```text
Use case: ui-mockup, refinement of the user's selected design.
Create ONE realistic, production-quality revised Russian Sqoch desktop UI image. Edit target: the attached image is the exact selected third design; preserve its recognizable left-context/right-form composition and the complete real booking workflow. Do not create other concepts or a multi-image board. No browser chrome, device frame or commentary annotations.
Target dimensions: match the supplied 1487 x 1058 pixel reference, maintaining natural proportions. Date anchor: October 27, 2026, Europe/Moscow. There are no dates to add to this screen.

User feedback: they prefer this design but find it too contrasty, bulky and typographically dominant. The goal is a visibly calmer and more refined version with dimensional section separation. Do not regress to a flat page of horizontal rules. Do not solve bulk by deleting informative text or shrinking helper/error text.

Specific revision:
- Replace the dark full-height left wall with a pale desaturated blue-gray surface #E7EDF2. Its text is dark slate #3D4855, not white; muted text #63717D must remain comfortably readable. Narrow its width from roughly32% to around26%. Keep the logo, step, page heading, event, tariffs and rules here. No dark or saturated full-height areas. No gradients. Keep subtle depth only at the vertical surface join.
- Keep the right work area near-white with no enclosing outer app-card. The participant and email groups are lightly differentiated through gentle white/tinted planes, delicate boundaries, restrained 6-8px corners and subtle elevation. Avoid nested cards. Do not make every line its own box.
- Typography is Commissioner with Cyrillic, the project's existing type family. Render visibly lighter and smaller headings than the reference. Page heading about30px /38px, weight550, section headings20px /28px weight550; participant title18px /28px weight500; labels16px /24px weight500. Body and input text18px /28px weight400. Helpers/errors16px /24px weight400. Buttons18px /26px weight500. Do not use bold700/800 in this revision, inflated headline sizes or faux wide display text. Main text must remain readable. These are target proportions, not tiny labels.
- Remove the large circular participant-number badge; the unobtrusive text 'Участник 1' is sufficient. Make 'Все поля обязательны' a quiet readable line above the form, not a large colored banner.
- Reduce visual mass of controls: input height around52px and button height around48-52px, at least44px hit targets; restrained border1px. Keep the age input short, around128px, never as wide as the name. Use an ordinary compact '+ Добавить участника' text-and-icon action with a generous hit target, not a full-width dashed enclosure.
- Make the primary button compact, approximately250px wide; slate-blue #536B83, no gradient or heavy shadow. It remains clearly primary.
- Errors use red #AD2632 and a small unobtrusive icon or red left cue, without pink fills inside the entire input and without conspicuous solid red circles. Crucially, long age and name errors must use wide separate rows below the input row, each explicitly naming its field as in their text. Never constrain the age error to128px. Keep them close to their inputs, with comfortable16px type. Email also has a separate error AND its persistent help.
- Intentional spacing: field label to input8-10px, input to message8px, related areas16-20px, between major groups28-32px. Avoid both oversized blank padding and cramped elements. Use a comfortable content width around820px and sensible line lengths. Keep all content unclipped with balanced negative space.

Preserve all exact substantive Russian content and business rules:
'sqoch.'
'Шаг 1 из 2 · Данные'
'Оформление билетов'
'Мероприятие Sqoch'
'От 14 лет — 2 000 ₽ · Младше 14 лет — 1 000 ₽'
'Правила покупки билетов'
'Все поля обязательны'
'Участники', '1 из 4', 'Участник 1'
'Имя', placeholder 'Например, Анна'
'Введите имя участника — поле не должно быть пустым'
'Возраст, лет', empty short input
'Введите возраст в полных годах — целое число от 0'
'+ Добавить участника'
'Ребёнку младше 14 лет нужен сопровождающий от 18 лет в том же заказе'
'Email', placeholder 'you@example.com'
'Введите email в формате name@example.com, без пробелов'
'Один email для всех участников заказа. В демо письма не отправляются'
'Проверить заказ'
'Sqoch · тестовый проект'
'Без оплаты и отправки писем'.

This is a form in a validation-error state. Do not add payment, authentication, new features, actual email sending, extra navigation, invented rules, numbered design-option labels or concept titles. Show one coherent revision, app content only. Preserve a professional product feel with subtle depth, calmer contrast and balanced typography.
```

## Полный запрос уточнения типографики

```text
Edit the attached Sqoch UI mockup. This is a precise TYPOGRAPHIC REFINEMENT of the same selected pale-left-panel / right-form composition, not a new design. Output one 1487 x 1058 desktop app-content image, no browser chrome, no presentation labels. Date anchor October 27, 2026.

The user specifically says the UI fonts, oversized headings and bulky controls dominate everything. The pale color change in the attached intermediate revision is good; preserve its soft low-contrast blue-gray left pane, white content region and gentle dimensional group separation. THE TYPOGRAPHY MUST CHANGE VISIBLY. The current attached image's title and section headings are STILL TOO LARGE AND TOO BOLD. Do not reproduce their apparent sizes.

Use a restrained neutral Inter-style humanist UI sans with Cyrillic, Regular400 and Medium500 ONLY. This is an exploration of a calmer alternative to the existing Commissioner. No Bold, Semibold or ExtraBold anywhere, including title, section headings, participant name and buttons. Prefer regular weight for large text, medium only for short labels and actions.
Explicit relative size constraints:
- The current giant two-line title 'Оформление билетов' must become around60% of its current apparent size and around60% of its apparent ink weight. It should feel like a quiet 28px/36px interface heading, not a hero title. Two short lines in the left pane are okay. Its letters should be at most1.65 times the height of the actual main body letters, never2.5-3 times. Title must look SMALLER than the sqoch logo.
- Current big 'Участники' and 'Email' headings must become around65% of current apparent size, regular-to-medium18-20px. Their scale should be only slightly larger than form labels.
- 'Участник 1' becomes18px Medium with no badge.
- Actual body/input text17px/26px Regular; labels16px/24px Medium; ALL help/error text16px/24px Regular. Never minify long explanations below16px. The user wants informative wording and readable errors. Do not shorten, summarize, abbreviate or omit required text.
- Button label17px Medium, compact primary button about240 x48px. Inputs52px tall. Age input128px wide, not as wide as the name.
- Slim the add-participant action to an inline plus and text at17px, with44px hit area. No giant plus, no full-width container.

Keep the layout elegantly bounded: narrow left context pane about340px; main form's content starts aroundx410 with comfortable40px outer padding. Main form width around880px, not an enormous expanded input ocean. Preserve a balanced viewport, no clipping. Individual group headers have16-20px vertical padding; avoid huge padding bands. Subtle8px group corners, fine1px boundary, no nested cards. The left panel is pale #E7EDF2 with dark slate #3D4855 text, main region near-white, brand/action #536B83, muted text #63717D. Keep legible contrast for all words.

Errors: fine red borders on white inputs (NO pink gradient inside input), text #AD2632, small outlined16px error icon (NO huge solid red circles). Below the name/age input row, place TWO SEPARATE WIDE TEXT ROWS, left-aligned with the name field and each using the whole participant group's inner width:
'Введите имя участника — поле не должно быть пустым'
'Введите возраст в полных годах — целое число от 0'
Thus the long age error is NOT placed in the short input column. These rows remain clearly associated by their explicit field words. Email gets its own error and persistent instruction on separate rows.

Keep exact copy, no invented restrictions or features:
sqoch.
Шаг 1 из 2 · Данные
Оформление билетов
Мероприятие Sqoch
От 14 лет — 2 000 ₽ · Младше 14 лет — 1 000 ₽
Правила покупки билетов
Все поля обязательны
Участники
1 из 4
Участник 1
Имя
Например, Анна
Возраст, лет
Введите имя участника — поле не должно быть пустым
Введите возраст в полных годах — целое число от 0
Добавить участника
Ребёнку младше 14 лет нужен сопровождающий от 18 лет в том же заказе
Email
you@example.com
Введите email в формате name@example.com, без пробелов
Один email для всех участников заказа. В демо письма не отправляются
Проверить заказ
Sqoch · тестовый проект
Без оплаты и отправки писем

One participant, invalid empty inputs, one clear primary action. No payment, authentication, extra navigation, new features, decorative illustration or analytics. Match the softened reference palette, but produce the significantly lighter, smaller and more balanced typography the user requested. Do not leave the old oversized type hierarchy unchanged.
```
