import { useCallback, useEffect, useRef, useState } from 'react';
import Booking from './features/booking/Booking';
import Organizer from './features/organizer/Organizer';
import { AppHeader } from './components/AppHeader';
import { Events } from './features/organizer/Events';
import { TransferStart } from './features/organizer/TransferStart';

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  const currentHash = useRef(hash);
  const dirty = useRef(false);
  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  useEffect(() => {
    const change = () => {
      const next = window.location.hash;
      if (next === currentHash.current) return;
      if (dirty.current && !window.confirm('Есть несохранённые изменения. Покинуть черновик?')) {
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}${currentHash.current}`,
        );
        return;
      }
      dirty.current = false;
      currentHash.current = next;
      setHash(next);
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  if (hash === '#/organizer' || hash === '#/organizer/')
    return <Events key="events" eventId={null} />;
  if (hash === '#/organizer/transfer')
    return <TransferStart key="transfer" eventId={null} onDirtyChange={onDirtyChange} />;
  const eventRoute = /^#\/organizer\/events\/([^/]+)(\/transfer)?$/.exec(hash);
  if (eventRoute) {
    let eventId: string;
    try {
      eventId = decodeURIComponent(eventRoute[1]!);
    } catch {
      eventId = '';
    }
    return eventRoute[2] ? (
      <TransferStart key={`transfer-${eventId}`} eventId={eventId} onDirtyChange={onDirtyChange} />
    ) : (
      <Events key={`event-${eventId}`} eventId={eventId} />
    );
  }
  const route = /^#\/organizer\/campaigns\/([^/]+)$/.exec(hash);
  if (route)
    return <Organizer key={route[1]} campaignId={route[1]!} onDirtyChange={onDirtyChange} />;
  if (hash.startsWith('#/organizer'))
    return (
      <div className="page organizer">
        <AppHeader section="organizer" />
        <main className="layout">
          <h1>Страница не найдена</h1>
          <p className="organizer-back">
            <a href="#/organizer">К мероприятиям</a>
          </p>
        </main>
      </div>
    );
  return <Booking />;
}
