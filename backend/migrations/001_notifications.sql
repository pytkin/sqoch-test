CREATE TABLE events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    starts_at_utc TEXT NOT NULL,
    timezone TEXT NOT NULL CHECK(timezone = 'Europe/Moscow'),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);

CREATE TABLE purchases (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    email TEXT NOT NULL,
    normalized_email TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'cancelled'))
);

CREATE INDEX purchases_event_status ON purchases(event_id, status);

CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL DEFAULT 'draft' CHECK(phase IN ('draft', 'confirmed')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    event_id TEXT REFERENCES events(id),
    proposed_start TEXT,
    suggested_start TEXT,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    text_reviewed INTEGER NOT NULL DEFAULT 0 CHECK(text_reviewed IN (0, 1)),
    reviewed_event_revision INTEGER,
    prompt TEXT NOT NULL DEFAULT '',
    preview_json TEXT,
    event_snapshot_json TEXT,
    accepted_token TEXT,
    confirmed_at TEXT
);

CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    email TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending', 'sending', 'retry_wait', 'sent', 'failed', 'unknown')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
    next_attempt_at TEXT,
    message_id TEXT NOT NULL UNIQUE,
    mime BLOB NOT NULL,
    last_error_code TEXT,
    last_error_message TEXT,
    sent_at TEXT,
    mailpit_message_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(campaign_id, email)
);

CREATE INDEX deliveries_ready ON deliveries(state, next_attempt_at, created_at, id);
