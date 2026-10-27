import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import App from '../../App';

export const event = {
  id: 'sqoch-demo',
  title: 'Встреча Sqoch',
  currency: 'RUB',
  max_participants: 4,
  child_age_limit: 14,
  companion_min_age: 18,
  full_ticket_price: 2000,
  child_ticket_price: 1000,
};

export type BookingApiMock = {
  requests: { path: string; body: Record<string, unknown>; scenario: string | null }[];
  mode: 'success' | 'network' | 'validation' | 'malformed';
  confirmResponse: (() => Promise<Response>) | undefined;
};

export function mockBookingApi(): BookingApiMock {
  const state: BookingApiMock = { requests: [], mode: 'success', confirmResponse: undefined };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/event') return Response.json(event);
      const body = JSON.parse(String(init?.body)) as {
        participants: { name: string; age: number }[];
        email: string;
      };
      const scenario = new Headers(init?.headers).get('X-Demo-Scenario');
      state.requests.push({ path, body, scenario });
      if (state.mode === 'malformed') return Response.json({});
      if (state.mode === 'network') throw new TypeError('Failed to fetch');
      if (state.mode === 'validation')
        return Response.json(
          { detail: [{ loc: ['body', 'email'], msg: 'invalid', type: 'value_error' }] },
          { status: 422 },
        );
      if (path === '/api/orders' && state.confirmResponse) return state.confirmResponse();
      if (path === '/api/orders' && scenario === 'sold_out')
        return Response.json(
          { detail: { code: 'sold_out', message: 'Места закончились' } },
          { status: 409 },
        );
      const participants = body.participants.map((p) => ({
        ...p,
        ticket_type: p.age < 14 ? 'child' : 'full',
        price: p.age < 14 ? 1000 : 2000,
      }));
      return Response.json(
        {
          participants,
          email: body.email,
          total: participants.reduce((n, p) => n + p.price, 0),
          currency: 'RUB',
          ...(path === '/api/orders' ? { order_id: 'demo-123' } : {}),
        },
        { status: path === '/api/orders' ? 201 : 200 },
      );
    }),
  );
  return state;
}

export async function fillPerson(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  age: string,
  index = 0,
) {
  const group = screen.getAllByRole('group', { name: /Участник/ })[index]!;
  await user.type(within(group).getByLabelText('Имя'), name);
  await user.type(within(group).getByLabelText(/^Возраст/), age);
}
export async function readyForm(age = '18') {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { name: 'Оформление билетов' });
  await fillPerson(user, 'Анна', age);
  await user.type(screen.getByLabelText('Email'), 'anna@example.com');
  return user;
}
