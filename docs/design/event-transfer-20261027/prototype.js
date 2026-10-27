const views = new Set(['initial', 'clarification', 'prepared', 'preview', 'progress', 'events']);
const parameters = new URLSearchParams(window.location.search);
const main = document.getElementById('prototype-main');
const manualPanel = document.getElementById('manual-panel');
const manualToggle = document.getElementById('manual-toggle');
const letterEditor = document.getElementById('letter-editor');
const letterToggle = document.getElementById('letter-edit-toggle');
// A fixed prototype clock keeps these two scripted date examples reproducible.
const prototypeYear = 2026;
const prototypeMonthDay = '10-27';
const normalExample = { dayMonth: '2 декабря', monthDay: '12-02' };
const pastDateExample = { dayMonth: '20 сентября', monthDay: '09-20' };
const pastDateRequest = 'Переносим Керамику на 20 сентября, 19:00';
let clarificationExample = pastDateExample;

function minimumExampleYear(example) {
  return example.monthDay > prototypeMonthDay ? prototypeYear : prototypeYear + 1;
}

function showExampleDate(example, year = prototypeYear, source = 'current_year') {
  const date = `${example.dayMonth} ${year} года`;
  const subject = `Новая дата мастер-класса «Керамика»: ${date}`;
  const body = [
    'Здравствуйте!',
    '',
    `Мастер-класс «Керамика» переносится на ${date}, 19:00 по московскому времени.`,
    '',
    'Пожалуйста, учтите новую дату при планировании.',
  ].join('\n');
  const yearOrigin =
    source === 'current_year'
      ? `Год ${year} выбран по текущей дате в Москве.`
      : source === 'explicit_clarification'
        ? `Год ${year} указан вами при уточнении.`
        : `Год ${year} явно указан в запросе.`;

  document.querySelectorAll('.prototype-new-date dd').forEach((label) => {
    label.firstChild.textContent = date;
  });
  document.querySelectorAll('.prototype-subject').forEach((label) => {
    label.textContent = subject;
  });
  document.querySelectorAll('.organizer-letter').forEach((letter) => {
    letter.textContent = body;
  });
  ['manual-subject', 'prepared-subject'].forEach((id) => {
    document.getElementById(id).value = subject;
  });
  ['manual-body', 'prepared-body'].forEach((id) => {
    document.getElementById(id).value = body;
  });
  document.querySelectorAll('.prototype-year-source').forEach((label) => {
    label.textContent = `${yearOrigin} До подтверждения его можно изменить.`;
    label.dataset.yearSource = source;
  });
  const progressOrigin = document.querySelector('.prototype-year-origin');
  progressOrigin.textContent = yearOrigin;
  progressOrigin.dataset.yearSource = source;
  document.getElementById('manual-date').value = `${year}-${example.monthDay}`;
  document.getElementById('progress-introduction').textContent =
    `Дата мастер-класса «Керамика» изменена на ${date}, 19:00 по Москве.`;
  const checkbox = document.getElementById('prepared-reviewed');
  checkbox.checked = false;
  checkbox.setAttribute('aria-invalid', 'false');
  checkbox.removeAttribute('aria-describedby');
  document.getElementById('prepared-reviewed-error').hidden = true;
}

function setYearClarification(example, request, rejectedYear = prototypeYear) {
  clarificationExample = example;
  const minimumYear = minimumExampleYear(example);
  document.getElementById('clarification-reason').textContent =
    `${example.dayMonth} ${rejectedYear} года уже прошло: сегодня 27 октября 2026 года по Москве. День и время сохранены. Укажите будущий год проведения.`;
  document.getElementById('clarification-request').textContent = request;
  document.getElementById('clarification-day').textContent = example.dayMonth;
  document.getElementById('clarification-year-help').textContent =
    `Укажите будущий год четырьмя цифрами. ${example.dayMonth} и 19:00 повторно вводить не нужно.`;
  document.getElementById('clarification-year-error').textContent =
    `Укажите год не раньше ${minimumYear} четырьмя цифрами`;
  const input = document.getElementById('clarification-year');
  input.placeholder = `Например, ${minimumYear}`;
  input.value = '';
  input.setAttribute('aria-invalid', 'false');
  input.setAttribute('aria-describedby', 'clarification-year-help');
  document.getElementById('clarification-year-error').hidden = true;
}

function show(view, { focus = true, manual = false } = {}) {
  const selected = views.has(view) ? view : 'initial';
  document.querySelectorAll('[data-view]').forEach((section) => {
    section.hidden = section.dataset.view !== selected;
  });
  document.querySelectorAll('.prototype-states [data-show]').forEach((button) => {
    if (button.dataset.show === selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (manual) {
    manualPanel.hidden = false;
    manualToggle.setAttribute('aria-expanded', 'true');
  }
  const next = new URL(window.location.href);
  next.searchParams.set('view', selected);
  next.hash = '';
  window.history.replaceState(null, '', next);
  document.getElementById('prototype-status').textContent = 'Показано состояние макета';
  if (focus) {
    if (manual) document.getElementById('manual-date').focus();
    else main.querySelector(`[data-view="${selected}"] h1`).focus();
  }
}

document.querySelectorAll('[data-show]').forEach((control) => {
  control.addEventListener('click', (event) => {
    event.preventDefault();
    if (control.closest('.prototype-states')) {
      showExampleDate(normalExample);
      setYearClarification(pastDateExample, pastDateRequest);
    }
    show(control.dataset.show, { manual: control.hasAttribute('data-open-manual') });
  });
});

manualToggle.addEventListener('click', () => {
  manualPanel.hidden = !manualPanel.hidden;
  manualToggle.setAttribute('aria-expanded', String(!manualPanel.hidden));
  if (!manualPanel.hidden) document.getElementById('manual-date').focus();
});

document.getElementById('assistant-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('initial-request');
  const empty = !input.value.trim();
  document.getElementById('initial-request-error').hidden = !empty;
  input.setAttribute('aria-invalid', String(empty));
  input.setAttribute(
    'aria-describedby',
    empty ? 'initial-request-help initial-request-error' : 'initial-request-help',
  );
  if (empty) {
    input.focus();
    return;
  }
  // This mockup switches between fixed December and September examples, not a resolver.
  const example = /20\s+сентябр/iu.test(input.value) ? pastDateExample : normalExample;
  const explicitYear = input.value.match(/\b[0-9]{4}\b/)?.[0];
  const year = explicitYear ? Number(explicitYear) : prototypeYear;
  if (year < minimumExampleYear(example)) {
    setYearClarification(example, input.value.trim(), year);
    show('clarification');
    return;
  }
  showExampleDate(example, year, explicitYear ? 'explicit_request' : 'current_year');
  show('prepared');
});

document.getElementById('clarification-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('clarification-year');
  const invalid =
    !/^[0-9]{4}$/.test(input.value.trim()) ||
    Number(input.value) < minimumExampleYear(clarificationExample);
  document.getElementById('clarification-year-error').hidden = !invalid;
  input.setAttribute('aria-invalid', String(invalid));
  input.setAttribute(
    'aria-describedby',
    invalid ? 'clarification-year-help clarification-year-error' : 'clarification-year-help',
  );
  if (invalid) {
    input.focus();
    return;
  }
  showExampleDate(clarificationExample, Number(input.value.trim()), 'explicit_clarification');
  show('prepared');
});

letterToggle.addEventListener('click', () => {
  letterEditor.hidden = !letterEditor.hidden;
  letterToggle.setAttribute('aria-expanded', String(!letterEditor.hidden));
  if (!letterEditor.hidden) document.getElementById('prepared-subject').focus();
});

document.getElementById('letter-edit-done').addEventListener('click', () => {
  letterEditor.hidden = true;
  letterToggle.setAttribute('aria-expanded', 'false');
  document.getElementById('prepared-reviewed').checked = false;
  letterToggle.focus();
});

document.getElementById('review-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const checkbox = document.getElementById('prepared-reviewed');
  document.getElementById('prepared-reviewed-error').hidden = checkbox.checked;
  checkbox.setAttribute('aria-invalid', String(!checkbox.checked));
  if (!checkbox.checked) checkbox.setAttribute('aria-describedby', 'prepared-reviewed-error');
  else checkbox.removeAttribute('aria-describedby');
  if (!checkbox.checked) {
    checkbox.focus();
    return;
  }
  show('preview');
});

document.getElementById('mock-reconcile').addEventListener('click', () => {
  document.getElementById('mock-reconcile-result').hidden = false;
});

showExampleDate(normalExample);
setYearClarification(pastDateExample, pastDateRequest);
show(parameters.get('view'), { focus: false });
