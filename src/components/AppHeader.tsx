export function AppHeader({ section }: { section: 'booking' | 'organizer' }) {
  return (
    <header className="site-header">
      {section === 'booking' ? (
        <span className="brand">sqoch.</span>
      ) : (
        <a className="brand" href="#/organizer">
          sqoch.
        </a>
      )}
      <nav aria-label="Разделы приложения" className="organizer-nav">
        <a href="#/booking" aria-current={section === 'booking' ? 'page' : undefined}>
          Билеты
        </a>
        <a href="#/organizer" aria-current={section === 'organizer' ? 'page' : undefined}>
          Мероприятия
        </a>
      </nav>
    </header>
  );
}
