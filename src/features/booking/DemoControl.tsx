import type { Scenario } from './api';

export function DemoControl({
  scenario,
  onChange,
  disabled,
  retry = false,
}: {
  scenario: Scenario;
  onChange: (scenario: Scenario) => void;
  disabled: boolean;
  retry?: boolean;
}) {
  return (
    <fieldset
      className={retry ? 'demo-controls demo-retry' : 'demo-controls'}
      disabled={disabled}
      aria-describedby="demo-help"
    >
      <legend>Сценарий демо</legend>
      <div className="demo-options">
        <label>
          <input
            type="radio"
            name="demo-scenario"
            value="success"
            checked={scenario === 'success'}
            onChange={() => onChange('success')}
          />
          Успех
        </label>
        <label>
          <input
            type="radio"
            name="demo-scenario"
            value="sold_out"
            checked={scenario === 'sold_out'}
            onChange={() => onChange('sold_out')}
          />
          Нет мест
        </label>
      </div>
      <p id="demo-help">
        {retry && scenario === 'sold_out'
          ? 'Для успешного повтора выберите «Успех»'
          : 'Только при подтверждении'}
      </p>
    </fieldset>
  );
}
