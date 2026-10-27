# Этап 2: точный контракт и тестовые границы

Документ владеет DTO, ошибками API и тестовыми границами второго этапа.
Текущие статусы реализации находятся в [плане](work-plan.md), результаты
проверок в [приёмке](acceptance.md). Дополняет
[архитектуру](notifications-technical.md); правила и полномочия определяются
там и в [брифе](notifications.md). Pydantic реализует этот контракт, из неё
генерируются TS-типы. Не создавать параллельные ручные модели frontend.

Пересмотр SQOCH-39 принят пользователем 27.10.2026 для реализации в
SQOCH-40–44. Новые DTO/state ниже являются нормативной целью; готовность
Pydantic, сгенерированных типов и UI подтверждают только статусы срезов и
приёмка, не факт обновления этого документа.

## Общие правила DTO

Все JSON-ключи ниже snake_case. Указанные поля ответа обязательны, nullable
обозначает явный null, а не пропуск ключа. Неизвестные поля запросов запрещены.
Revision — строго целое число >=0; boolean недопустим. Все campaign-параметры
пути в FastAPI называются `campaign_id`, имеют тип UUID; невалидный UUID даёт
422 с loc `['path', 'campaign_id']`. Название параметра не меняет URL.
Дата сериализуется ISO 8601, UI показывает Europe/Moscow; идентификаторы — строки.
Порядок recipients — normalized_email ASC; deliveries — тот же порядок.
Списки campaigns — created_at DESC, id ASC; events — id ASC.

Составные GET/list представления читают campaign, deliveries и counters в одной
явной read-транзакции SQLite начиная до первого SELECT. Иначе конкурентный
confirm/worker мог бы смешать разные версии состояния в одном ответе.

`GET /api/organizer/events` возвращает `{items: Event[]}`.
Event: `id, title, starts_at, timezone, revision`; timezone ровно Europe/Moscow.
На пустой БД items=[]; старт не загружает fixtures автоматически.

`PUT /api/organizer/campaigns/{campaign_id}` принимает CreateCampaignRequest.
Все его поля optional с defaults для совместимости `{}`:
`mode:assistant|manual` (assistant), `prompt:string` (пустая строка),
`context_event_id:string|null` (null), `event_id:string|null` (null),
`proposed_start:ISO|null` (null), `subject/body:string` (пустые),
`manual_fields:[]`. Непустой prompt trim и 1..4000 символов; явно переданный
пустой/пробельный prompt даёт 422, пропущенный допустим для legacy `{}`.
Остальные поля следуют типам PATCH и AssistantState ниже. Assistant отправляет
prompt/context, manual отправляет явно введённые поля. Первый содержательный
ввод сохраняется атомарно вместе с созданием, до LLM. Первая запись 201;
повтор UUID возвращает существующее состояние 200, даже confirmed и даже с
другим payload, без перезаписи. Не переоткрывает перенос и не сбрасывает поля.

Новый UI создаёт запись только по непустому submit либо явному сохранению
ручных данных. Посещение/refresh, переключение режима и один автоматически
выбранный контекст не вызывают PUT. Compatibility `{}` не разрешает делать
пустые записи основным UX. При потере ответа создания клиент читает тот же
UUID, не генерирует новый; LLM не вызывается до подтверждённого сохранения.

Содержательный assistant PUT создаёт assistant_state со stage=intake,
intake_revision=0 и applied_revision=null. Prompt вместе с context_event_id
сразу привязывает campaign.event_id к явно выбранному событию, не меняя его
дату; поэтому сохранённый запрос после ошибки остаётся у этого мероприятия.
Context_event_id и отдельно переданный event_id должны совпадать, иначе 422
без вставки. Глобальный запрос без контекста остаётся unassigned до выбора
события. Для manual create/PATCH stage=applied при полных event/date/subject/body,
иначе needs_input; resolver для ручного сохранения не вызывается. Это не
заменяет строгую проверку будущей даты и отметки при preview/confirm.

`GET`, `PUT`, `PATCH`, `confirm`, `resume`, `reconcile` одной campaign возвращают
CampaignDetail с одинаковой формой (кроме ошибок):

```json
{
  "id": "93ce9274-81a3-451e-8b90-993cf03be1d3",
  "phase": "draft",
  "revision": 0,
  "created_at": "2026-10-26T12:00:00Z",
  "updated_at": "2026-10-26T12:00:00Z",
  "event_id": null,
  "proposed_start": null,
  "suggested_start": null,
  "assistant_state": null,
  "subject": "",
  "body": "",
  "text_reviewed": false,
  "reviewed_event_revision": null,
  "confirmed_at": null,
  "event_snapshot": null,
  "preview": null,
  "status": "draft",
  "counters": {
    "total": 0,
    "pending": 0,
    "sending": 0,
    "retry_wait": 0,
    "sent": 0,
    "failed": 0,
    "unknown": 0
  },
  "deliveries": []
}
```

UUID и timestamps примера не константы продукта. В draft counters=0 и deliveries=[]
даже при наличии preview: потенциальные адресаты находятся внутри preview.
На confirmed phase status вычисляется из delivery; revision увеличена confirm
один раз и не изменяется от polling/worker/resume/reconcile. updated_at также
относится к содержимому campaign, а даты попыток принадлежат delivery.

`PATCH` — полная замена редактируемых полей, не произвольный JSON merge:

```json
{
  "expected_revision": 0,
  "event_id": null,
  "proposed_start": null,
  "subject": "Перенос занятия",
  "body": "Новую дату ещё нужно выбрать.",
  "text_reviewed": false
}
```

Все показанные поля обязательны. `reviewed_event_revision` можно опустить
только при false (нормализуется в null); при true обязательна целая revision
существующего выбранного события, которую видел клиент. Сохранение неполных
event/date/subject/body разрешено. Длина/тип/формат проверяются и для draft;
пустота и будущая дата требуются только preview/confirm. Каждая успешная PATCH,
в том числе no-op, увеличивает revision на 1 и инвалидирует preview.
Stale revision →409 без изменений. true без заполненного контекста либо со
старой event revision →409 text_review_required. Получатели не поле PATCH.

Optional `prompt` сохраняет актуальный исходный запрос без LLM: strict string
после trim, максимум 4000 символов; explicit null/неверный тип дают 422.
В manual mode explicit пустая строка явно очищает сохранённый запрос.
При отсутствии prompt прежний запрос сохраняется. Create/Prepare по-прежнему
требуют непустой запрос. Новый запрос атомарно обновляет original_prompt
и legacy campaigns.prompt, сбрасывает прежние answers и разобранные части
без ручного происхождения. Ручные date/time и manual_fields сохраняются;
неизменённые AI-поля не становятся ручными. Event/date/subject/body остаются
переданными полями формы; текст не генерируется автоматически. Stale revision
не меняет ни запрос, ни поля. Это позволяет явно сохранить запрос B после
отказа подготовки A и восстановить B через GET/reload. Смена режима сама
по себе запрос и answers не сбрасывает.

Optional `mode:assistant|manual` сохраняет выбранный режим в AssistantState.
Отсутствие mode не переключает текущий режим. Явное сохранение ручной формы
передаёт mode=manual, даже если изменились только subject/body; сохранение
человеческой отметки у готового результата mode не меняет. Само локальное
переключение экрана режима не выполняет PATCH/PUT и не создаёт запись:
оно сохраняется только вместе с явным сохранением или содержательным действием.

Optional `manual_fields` содержит уникальные `event_id|date|time`, максимум
три значения. Это реально затронутые пользователем структурированные поля,
не все отправленные значения формы. Пустой список не стирает накопленную
provenance. Legacy отсутствие метаданных позволяет считать фактически
изменённые структурированные поля ручными. Ручная смена события является
явным выбором нового контекста; новая дата/время инвалидирует противоречащие
partial components. Сохранение без новых правок не превращает AI-значения в
ручные. Новые subject/body меняются только явным редактированием или
AI-действием, но не автоматически при навигации/смене режима.

`GET /campaigns` → `{items: CampaignSummary[]}`, где summary содержит
`id,phase,revision,created_at,updated_at,event_id,event_title,subject,proposed_start,status,counters`
и новые `has_content:boolean`, `preparation_stage:string|null`,
`event_snapshot:EventSnapshot|null`. Event_title nullable для пустого draft,
для confirmed берётся из snapshot. Snapshot сохраняет old/new даты истории,
а не текущую дату события. Общий `Event`, вложенный в сохранённый Preview,
не получает новых required полей.

Has_content определяется сервером по prompt (включая legacy campaigns.prompt),
event/date/subject/body/suggested_start, а не одной теме. Один context_event_id
без пользовательского ввода незначим. Старые содержательные поля не теряются
при фильтрации. Пустой legacy draft без содержательных данных имеет false;
он не удаляется и доступен по старой ссылке. Preparation_stage для confirmed равен null; для пустого draft empty,
для нового assistant state соответствует его stage; содержательный legacy
проект без assistant state восстанавливается как ручная подготовка.

Обзор и история группируют существующие events/campaigns по event_id. Несколько
подготовок не сливаются; значимые без события доступны отдельно. GET не
создаёт подготовку и не вызывает LLM/SMTP. Для 20 покупок пагинация кабинета
не нужна; это допущение не относится к Mailpit search, где пагинация нужна
для доказательства точного совпадения.

## Preview и confirm

`POST /campaigns/{id}/preview`: JSON `{expected_revision: integer}`.
200 возвращает Preview и сохраняет его внутри CampaignDetail.preview:
`token, campaign_id, draft_revision, event, old_start, proposed_start,
subject, body, recipients`. Event соответствует указанной выше форме.
Recipients — массив строк normalized_email; old_start равен event.starts_at.
Preview не увеличивает draft revision. Повтор preview при неизменных данных
возвращает тот же token; изменение исходного snapshot выдаёт новый token,
но event revision прежде требует новой человеческой отметки через PATCH.
Проверка snapshot выполняется в одной короткой транзакции чтения/записи.

После открытия сохранённого draft GET может вернуть исторический preview;
он не считается свежим без нового запроса preview. UI не показывает кнопку
confirm до успешного preview в текущем сеансе. Сервер всё равно проверяет
снимок при confirm независимо от UI.

`POST /confirm`: JSON `{preview_token: UUID}`. UUID token случаен, сохраняется
после confirm как идентификатор принятого подтверждения. Первый успех 202,
повтор именно принятого token 200. Новый/чужой/устаревший token →409
preview_stale для draft или confirmation_conflict для confirmed.
Одна транзакция проверяет дату > now, отметку/event revision, все покупки
события, отсутствие незавершённого переноса и создаёт frozen snapshot/deliveries.
При несовпадении нет ни изменения даты, ни единственного delivery.

Confirmed event_snapshot: `id,title,old_start,new_start,timezone,event_revision_before`.
Delivery: `id,email,state,attempts,next_attempt_at,sent_at,error_code,error_message`;
последние четыре nullable. State — ровно pending/sending/retry_wait/sent/failed/unknown.
Ни MIME, ни сырой SMTP/LLM ответ не возвращаются UI. Message-ID остаётся в БД
и read-only диагностике тестов; UI может открыть общий Mailpit без знания ID.

`POST /resume` и `/reconcile` требуют `{}`. Draft →409 campaign_not_confirmed.
Для confirmed повтор безопасен: resume только ставит due-now для retry_wait
при attempts<5, не касается других состояний и не вызывает SMTP из API.
Reconcile перебирает текущие unknown (не sending), выполняет readback и CAS.
При недоступном Mailpit возвращает 200 с сохранённым unknown и безопасным
error_code `mailpit_unavailable`; отсутствие совпадения — `not_found_in_mailpit`.
GET не должен запускать сверку или отправку. Confirm pending не требует
доступного SMTP: долговременные задания допустимы при выключенном Mailpit.

## Ошибки

Ошибки формы: 422 `{detail:[{loc:[...],msg:string,type:string}]}` без input/ctx.
При неполноте preview loc относится к соответствующему body-полю draft;
type=`missing_draft_value`. Бизнес/интеграционные ошибки:
`{detail:{code:string,message:string,related_campaign_id:string|null}}`.
Сообщения безопасны, машинный код не локализуется. Ключ related_campaign_id
всегда есть; non-null только для event_campaign_unsettled.

| HTTP | Коды                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | host_not_allowed (локальная HTTP-граница)                                                                                                           |
| 403  | origin_not_allowed (локальная HTTP-граница)                                                                                                         |
| 415  | json_required (локальная HTTP-граница)                                                                                                              |
| 404  | not_found                                                                                                                                           |
| 409  | revision_conflict, preview_stale, text_review_required, campaign_immutable, confirmation_conflict, campaign_not_confirmed, event_campaign_unsettled |
| 422  | no_recipients, date_not_future, date_unchanged (бизнес-ошибки); либо массив ошибок схемы                                                            |
| 502  | ai_invalid_response, ai_unavailable                                                                                                                 |
| 503  | ai_not_configured, storage_unavailable                                                                                                              |
| 504  | ai_timeout                                                                                                                                          |

Порядок для известных campaign: phase/idempotency → revision/token → поля/
text review → дата/снимок → получатели/незавершённая campaign → запись.
Схема запроса и UUID проверяются раньше бизнес-логики. Missing campaign
в любом endpoint даёт not_found, а не встроенную строковую HTTPException.
Клиент разбирает discriminated форму detail, не предполагает, что любая 422
содержит список. Booking сохраняет собственные прежние ответы без изменений.

## AI-контракт и сохранённая подготовка

### AssistantState

`CampaignDetail.assistant_state` nullable для legacy-записей и содержит
строгую версионированную структуру, сохраняемую в `assistant_state_json`:

| Поле             | Тип и смысл                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| version          | Строго 1                                                                                                      |
| mode             | assistant или manual; восстанавливает выбранный режим                                                         |
| stage            | intake, applied, needs_input или failed                                                                       |
| original_prompt  | Последний исходный запрос, trim, максимум 4000 символов; может быть пуст при первоначальной ручной подготовке |
| answers          | Структурированные явно принятые ответы; не append-only история                                                |
| context_event_id | ID известного контекста или null                                                                              |
| partial_date     | Проверенные nullable year/month/day/hour/minute; источник года определяется нормативным resolver, не моделью  |
| manual_fields    | Уникальные event_id/date/time с сохранённым ручным происхождением                                             |
| clarifications   | Стабильные адресные уточнения, не свободный текст модели                                                      |
| intake_revision  | Revision последнего сохранённого intake либо null                                                             |
| applied_revision | Revision последнего применённого результата либо null; прежняя версия различима после ошибки                  |

Смена mode не стирает сохранённые original_prompt и answers.

После отдельного focused review политики года от 27.10.2026 в SQOCH-41
в AssistantState добавлено optional nullable поле `year_source`:
`explicit|current_year|clarification|manual`. Это не новое required поле
SQOCH-40; миграция 002 уже содержит JSON-колонку, дополнительный SQL не нужен.
Старые v1 JSON без year_source читаются с default null. Источник выбирает
backend, не LLM и не произвольный клиентский флаг.

Answers допускает только optional `event_id:string`, `year:integer 1..9999`,
`date:YYYY-MM-DD`, `time:HH:mm`. Числа strict, boolean недопустим; дата и время
проходят календарную проверку. Явный year дополняет сохранённые day/month/time
и имеет приоритет перед current_year. Год из prompt получает source=explicit,
из ответа year/date clarification, из ручной даты manual. Current_year
допустим только без явного года, при совпадении московского года мероприятия
с текущим годом injected server Clock и строго будущем корректном результате.
Иначе уточняется year; ни следующий год, ни год мероприятия не наследуются.
Сохранённый выбор и source не пересчитываются при GET/reload. После смены года
прошедшая дата требует коррекции/новой подготовки, а не автоматического сдвига.
Полный год и пометка current_year видимы в подготовленном результате.
Новый полный prompt заменяет прежний запрос и его разобранные части; ответы
текущего уточнения объединяются с сохранёнными, без дублирования реплик.
Ручные значения не исчезают из-за пустого manual_fields или модельного null.

Clarification: `{field,reason,candidate_event_id}`. Field ровно
`event_id|year|date|time`; reason ровно `missing|ambiguous|invalid|past|conflict`.
Candidate_event_id всегда присутствует, nullable; non-null только для
предложения перейти к другому существующему мероприятию. UI не извлекает ID
из message. При неоднозначном событии варианты берутся из `GET /events`.
Ручной выбор либо явно принятый answers.event_id разрешает смену контекста.

### Prepare

PrepareRequest: `expected_revision` и optional `prompt`, `answers`,
`context_event_id`. Prompt после trim 1..4000, если передан. Для первого
обращения нужен непустой prompt; для уточнения/явного повтора допустимы
сохранённый prompt и ответы. Один контекст без содержательного запроса не
начинает AI. Формы/UUID проверяются до intake. Перед действием UI сохраняет
ручные изменения PATCH; сбой сохранения не вызывает модель.

200: `{outcome:applied|needs_input|out_of_scope,campaign:CampaignDetail,
fields_to_complete:string[],clarifications:Clarification[],message:string}`.
Fields_to_complete сохраняет совместимые значения
`event_id|proposed_start|subject|body`; подробный UI использует clarifications.
Message объясняет состояние человеку, не управляет навигацией.

1. Intake в короткой транзакции проверяет draft/expected_revision, сохраняет
   исходный запрос и ответы, явно ставит mode=assistant и stage=intake,
   увеличивает revision на 1,
   снимает text_reviewed/reviewed_event_revision и preview. Прежние готовые
   event_id/proposed_start/subject/body остаются сохранёнными.
2. Resolver/tools/HTTP выполняются вне SQLite write-lock. Полная однозначная
   дата с временем и годом из допустимого источника заполняется автоматически:
   explicit, clarification, manual либо проверенный current_year.
   Поддерживаемые формы и запреты принадлежат технической спецификации.
3. Applied либо needs_input применяется CAS к phase=draft и intake_revision,
   увеличивает revision ещё на 1. Applied означает полный подготовленный
   результат; needs_input возвращает только нужные вопросы и сохраняет уже
   определённое. Пользовательская отметка остаётся false.
4. Ошибка провайдера помечает stage=failed операционным CAS без дополнительной
   content revision; ошибка старого вызова не меняет новый intake. Out_of_scope
   возвращает outcome=out_of_scope, stage=failed, прежние готовые поля и
   сохранённый intake на revision +1. Byte-identical всего CampaignDetail
   после отказа не обещается: ввод сохранён, review/preview инвалидированы.

После error/unknown/reload клиент GET-восстанавливает ввод и актуальную
revision того же UUID. Прежний текст обозначен предыдущим результатом.
Оставшийся intake означает незавершённую подготовку, не обещание работающего
фонового процесса. GET и UI не перезапускают LLM автоматически; повтор явный.
Новая PATCH, новый intake или confirm отменяют право позднего результата.

Внешний JSON prepare: `status:ready|needs_input|out_of_scope`,
`event_id:string|null`, `subject:string`, `body:string`; все ключи обязательны,
лишние запрещены. Provider DTO не включает proposed_start: проверенные
resolver факты передаются модели как фиксированный контекст для письма.
Статус ready и ISO от модели не заменяют проверку источника года и условий
current_year на backend.
Ненулевой event_id применяется только после get_event_context этого ID в
текущем действии; неизвестный ID не применяется. Неоднозначный глобальный
выбор допустим после list_events, без get_event_context, но не сбрасывает
известный или вручную выбранный контекст. Tools сохраняют прежние бюджеты,
строгие схемы и read-only полномочия.

### Rewrite и человеческая проверка

RewriteRequest остаётся `{expected_revision,instruction}`; instruction trim,
1..4000 символов. Rewrite вызывается после сохранения текущих полей. Его JSON:
`status:ready|out_of_scope,subject,body`, без event/date. Applied меняет только
тему/текст и снимает отметку; успешное применение увеличивает revision один раз.
Out_of_scope/ошибка rewrite не применяют новый текст. Серверные структурированные
поля неизменны, соответствие свободного текста проверяет человек.

«Проверить перенос» доступно после явной человеческой отметки и получает
свежий authoritative preview. Только последующее «Подтвердить перенос и
уведомить покупателей» меняет мероприятие и создаёт доставки. Автозаполнение,
готовый JSON и просьба отправить в prompt не являются этим подтверждением.

## Тестовые границы и правила реализации

- Существующий create_app используется без заглушки приложения. В реализации
  хранения настройки читаются при каждом создании app, не при import модуля.
  App не стартует worker/SMTP/DeepSeek автоматически.
- Factory принимает keyword-only `clock` с callable aware UTC datetime;
  по умолчанию используется реальное время. Worker получает тот же узкий Clock.
- Store работает с реальной временной SQLite; HTTPX transport double и
  SMTP-adapter double заменяют только сеть, а не алгоритмы выбора/состояния.
- Отказ между SQL-записями инъецируется только в тестах через monkeypatch
  владеющей функции/соединения. Нельзя вводить публичный fault endpoint.
- Параллельный confirm — два соединения к одной временной БД с барьером,
  не два последовательных запроса. Worker lock — два OS-процесса. Restart
  app через TestClient проверяет persistence, но не заменяет kill/restart worker.
- При росте среза сначала позитивный и отрицательный red, затем минимальный
  green. Для completed среза тесты находятся в обычном backend/tests.

Первоначальный pending-набор перенесён в `backend/tests/test_draft_contract.py`:
создание/чтение, неполное сохранение/повтор PUT, конфликт revision, UUID,
unknown fields, not_found, persistence и изоляция БД. Контроль работоспособности
harness был отдельным green control до реализации. После 23b/c fixture
объединена с основным suite, pending-команды и control удалены; все 38 draft/
flow cases обязательны в verify. При дальнейшем test-first не использовать
xfail/skip, перехват исключений или ожидаемый 404 вместо требуемого результата.
Многошаговый тест, остановившийся на первом шаге, ещё не доказывает red
последующих assertions. Текущие результаты находятся в приёмке.

### Каталог проверок по срезам

Каталог связывает исходные T-ID с фактическими файлами. Backend-файлы ниже
находятся в `backend/tests`, интеграционные — в `backend/integration`,
компонентные — в `src/features/organizer`. Выполнение и предел доказательства
фиксирует [приёмка](acceptance.md); существование теста само по себе не означает
успешный прогон. Один T-ID может включать parameterized cases. Имена
`test_preview.py`, отдельного notification `test_confirmation.py` и двух
Organizer-компонентных suites из первоначального плана заменены фактическими
`test_campaign_flow.py` и `Organizer.test.tsx`.

Каталог сохраняет исходные T01–T30 и связывает их с текущими проверками.
Resolver, intake и последовательный UI добавлены через RED/green в
[SQOCH-40–44](event-transfer-implementation.md); последующие исправления
описаны в [браузерной приёмке](reports/event-transfer-browser-20261027.md).
Legacy suggestion не становится датой переноса; совместимый пустой PUT
сохранён на API, но новый UI не создаёт запись при чтении или смене режима.
Остальные гарантии остаются регрессионными. Фактические прогоны и их
ограничения принадлежат приёмке.

| ID  | Фактический файл / проверяемый результат                                                                                                                                                                                                                                            | Уровень                   | Требования     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------- |
| T01 | `test_notification_store.py`: повторные миграции, rollback fixtures/DDL, отказ чужой/неполной схеме, live-lock/reset и сохранность bytes                                                                                                                                            | SQLite/process            | N-01,N-10      |
| T02 | `test_recipients.py`: 2/20, ceramics=8, painting=5, cancelled-only=0, active+cancelled=1, case/trim dedup, изоляция и unknown event                                                                                                                                                 | unit/SQLite               | N-01,N-05      |
| T03 | `test_draft_contract.py::test_create_and_read_empty_draft`; `test_preparation_drafts.py`: содержательный PUT, legacy empty create, валидация без частичной записи                                                                                                                   | HTTP                      | N-10           |
| T04 | `test_draft_contract.py::test_repeat_create_preserves_saved_incomplete_draft`; `test_preparation_drafts.py`: повтор UUID, mode/provenance и сохранение prompt после ошибки                                                                                                          | HTTP                      | N-04,N-10      |
| T05 | `test_draft_contract.py::test_stale_save_rejects_overwrite`                                                                                                                                                                                                                         | HTTP                      | N-13,N-15      |
| T06 | `test_draft_contract.py`: invalid_campaign_uuid, unknown fields PUT/PATCH, stable not_found без мутации                                                                                                                                                                             | HTTP                      | N-04,N-13      |
| T07 | `test_draft_contract.py::test_saved_draft_survives_new_app_and_other_database_is_isolated`                                                                                                                                                                                          | HTTP/SQLite               | N-10           |
| T08 | `test_campaign_flow.py::test_preview_shows_unique_recipients_and_does_not_create_deliveries`: полный snapshot, 8 email, стабильный token до PATCH                                                                                                                                   | HTTP/SQLite               | N-03,N-07      |
| T09 | `test_campaign_flow.py::test_event_change_before_first_preview_requires_new_human_review`: reviewed R1 → event R2, новая ручная проверка                                                                                                                                            | HTTP                      | N-04,N-15      |
| T10 | `test_campaign_flow.py`: incomplete_preview и no_recipients; нет даты/темы/проверки текста → нет event/delivery mutations                                                                                                                                                           | HTTP                      | N-05,N-06,N-14 |
| T11 | `test_campaign_flow.py::test_purchase_change_with_same_email_list_invalidates_confirmation`; E2E «чужой перенос после preview»                                                                                                                                                      | HTTP/SQLite/browser       | N-15           |
| T12 | `test_campaign_flow.py`: confirmation_is_atomic_and_repeat_is_same_campaign и failure_after_first_delivery_rolls_back_date_and_confirmation                                                                                                                                         | SQLite                    | N-06           |
| T13 | `test_campaign_flow.py::test_two_connections_confirm_once`; `organizer.spec.ts` «потеря ответа confirm»                                                                                                                                                                             | concurrent SQLite/browser | N-07           |
| T14 | `test_campaign_flow.py`: date_becomes_past_after_preview и confirmed_campaign_rejects_edits_and_other_token; AI late-apply tests                                                                                                                                                    | HTTP/clock                | N-07,N-14      |
| T15 | `test_campaign_flow.py::test_unsettled_same_event_blocks_next_transfer_until_terminal`                                                                                                                                                                                              | HTTP/SQLite               | N-07,N-09      |
| T16 | `test_claim.py`: один победитель claim, durable attempt до сети; `test_progress.py`: смешанные auto/manual/restart не делают шестой вызов                                                                                                                                           | SQLite/double             | N-09,N-10      |
| T17 | `test_smtp.py`: фазы connect/MAIL/RCPT/DATA, 4xx/5xx/250/parser/QUIT; `test_progress.py`: 5/15/60/120 на fake clock; `test_claim.py`: точное CRLF framing                                                                                                                           | adapter/unit              | N-09,N-11      |
| T18 | Исторические DeepSeek smoke SQOCH-21/25 и последующие реальные prepare/rewrite/current_year/уточнения; датированные результаты и ограничения в приёмке, ключ не сохранён                                                                                                            | external/manual           | N-02,N-16      |
| T19 | `test_worker_process.py`: два OS-worker, SIGKILL/SIGTERM, recovery sending→unknown, счётчик/locks и остановка при ошибке записи                                                                                                                                                     | process                   | N-10,N-11      |
| T20 | `test_reconcile.py`: точные ID/recipient/subject/body, filtered count/pagination/raw MIME, false/duplicate/missing/API down, exhausted unknown                                                                                                                                      | HTTP double/SQLite        | N-11           |
| T21 | `test_reconcile.py::test_late_negative_reconcile_cannot_lower_success`                                                                                                                                                                                                              | concurrency/SQLite        | N-11           |
| T22 | `test_progress.py`: counters/status, общий бюджет и resume; `test_reconcile.py`: endpoint без SMTP                                                                                                                                                                                  | HTTP                      | N-08,N-09      |
| T23 | `test_ai_prepare.py`: tools/JSON/budgets/safe errors, запрет даты модели; `test_date_resolver.py`, `test_ai_intake.py`: explicit/current_year/clarification, Moscow Clock, reload, manual conflict и late CAS                                                                       | unit/HTTPX double/SQLite  | N-02,N-13,N-14 |
| T24 | `test_ai_rewrite.py`: структурированные event/date неизменны, CAS после сети, invalid JSON/out_of_scope без повреждения draft                                                                                                                                                       | HTTPX double/SQLite       | N-04,N-13      |
| T25 | `test_delivery_acceptance.py::test_real_sender_failure_continues_without_resending_successes`: 3 успеха →451→остановка дольше deadline→resume→8 unique; `mailpit_support.py` cleanup                                                                                                | real SMTP/process         | N-12           |
| T26 | `Organizer.test.tsx`: PATCH-before-AI, local fields, UUID retry, legacy suggestion, leave/late callback/GET; `Organizer.progressive.test.tsx`, `TransferStart.regressions.test.tsx`: подготовка/уточнения/dirty; `preparation-contract.test.ts`, `api.test.ts`: DTO guards/deadline | component                 | N-04,N-10,N-13 |
| T27 | `Organizer.test.tsx` и `organizer.spec.ts`: stale preview, lost confirm same ID, reconcile/polling epoch, фокус и восстановление загрузки                                                                                                                                           | component/browser         | N-06–11,N-15   |
| T28 | `organizer.spec.ts`: desktop/mobile/768/360/320, CSS zoom200%, keyboard/reduced motion/forced colors; controlled-HTTP underline/long values/literal HTML; дополнительные ручные проверки — в приёмке                                                                                | browser/manual            | N-03,N-08,N-16 |
| T29 | `test_delivery_acceptance.py`: crash_after_real_smtp_acceptance, missing/deleted/unavailable readback, Mailpit restart и два новых OS API-процесса                                                                                                                                  | real SMTP/process         | N-10,N-11      |
| T30 | `test_campaign_flow.py`: local Host/Origin/JSON guard; AI/config safe-error tests; clean source-copy/setup/verify и live integration evidence — в приёмке                                                                                                                           | integration/manual        | N-16           |

T03–T07 обозначают сценарии, не число тестов. История red/green находится
в [Backend TDD](../backend/TDD.md), текущие числа и review-fixes в приёмке.
