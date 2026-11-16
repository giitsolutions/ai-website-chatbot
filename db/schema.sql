-- Schema for the chatbot registry (PostgreSQL).
-- Safe to run more than once: nothing is dropped, and existing rows are never changed.

CREATE TABLE IF NOT EXISTS chatbots (
    id             UUID PRIMARY KEY,
    website_url    TEXT NOT NULL,
    allowed_domain TEXT NOT NULL,
    status         VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | indexing | ready | failed
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Chatbot settings shown in the widget (all optional).
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS display_name     TEXT;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS welcome_message  TEXT;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS accent_color     TEXT;
-- Comma-separated website origins allowed to embed the widget; empty = any.
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS allowed_origins  TEXT;

-- Result of the latest successful indexing run.
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS last_indexed_at  TIMESTAMPTZ;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS pages_indexed    INTEGER;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS pages_failed     INTEGER;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS chunks_indexed   INTEGER;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS crawl_complete   BOOLEAN;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS page_limit       INTEGER;
-- Short, customer-safe reason for the latest failed indexing run (NULL when it succeeded).
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS last_error       TEXT;

-- Crawl report of the latest successful indexing run: pages found (links + sitemap),
-- pages found but not opened because a limit stopped the crawl, why it stopped
-- ('complete', 'page-limit' or 'request-limit'), and the addresses involved
-- ({ indexedUrls, failedPages: [{ url, reason }], notProcessedUrls }, at most 100 each).
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS pages_discovered    INTEGER;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS pages_not_processed INTEGER;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS crawl_stop_reason   TEXT;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS crawl_report        JSONB;

-- Pages read and pages skipped in the latest successful crawl (see crawl_urls).
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS pages_read    INTEGER;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS pages_skipped INTEGER;

-- Crawl setting: click the start page's menu buttons (for websites whose menu is buttons, not
-- links). Off by default; only the platform admin can turn it on.
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS button_discovery BOOLEAN NOT NULL DEFAULT false;

-- URL-level report of the latest successful crawl of each chatbot's website: every address
-- found and what happened to it. Replaced when the website is indexed again (a failed
-- crawl keeps the previous report, like the previous knowledge).
--   status: indexed | failed | skipped | not-processed
CREATE TABLE IF NOT EXISTS crawl_urls (
    chatbot_id    UUID        NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
    url           TEXT        NOT NULL,
    status        TEXT        NOT NULL,
    reason        TEXT,
    source        TEXT,
    http_status   INTEGER,
    sections      INTEGER,
    final_url     TEXT,
    discovered_at TIMESTAMPTZ,
    processed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crawl_urls_chatbot_idx ON crawl_urls (chatbot_id, status);
-- Added later (additive): page title, time spent on the address, and page-load attempts
-- (transient failures are retried). NULL for crawls recorded before these columns existed.
ALTER TABLE crawl_urls ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE crawl_urls ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE crawl_urls ADD COLUMN IF NOT EXISTS attempts INTEGER;

-- Documents uploaded by an administrator (PDF, DOCX) as extra knowledge for one chatbot.
-- The file itself is stored on the server under storage_name (a generated name, never the
-- uploaded file name); its sections are in Qdrant with sourceType "document" and documentId.
--   status: processing | indexed | failed
CREATE TABLE IF NOT EXISTS documents (
    id           UUID        PRIMARY KEY,
    chatbot_id   UUID        NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
    filename     TEXT        NOT NULL,
    file_type    TEXT        NOT NULL,
    size_bytes   INTEGER     NOT NULL,
    sha256       TEXT        NOT NULL,
    storage_name TEXT        NOT NULL,
    status       TEXT        NOT NULL,
    error        TEXT,
    pages        INTEGER,
    sections     INTEGER,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    indexed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS documents_chatbot_idx ON documents (chatbot_id);
-- Added later (additive): visitors may open a cited document through a signed, expiring link only
-- when the administrator allows it for that document (off by default: documents stay private).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS visitor_access BOOLEAN NOT NULL DEFAULT false;
-- Added later (additive): where a visitor's unanswered question can be sent ("Email your question").
-- NULL = no email option for this chatbot.
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS support_email TEXT;

-- Added later (additive): questions visitors sent with the contact form after an unanswered question.
-- Saved before any email is attempted, so a question is never lost when the notification fails.
-- One row per form (request_id); deleted with their chatbot.
--   status: open | handled            email_status: pending | no-recipient | disabled | accepted | failed
--   (no-recipient: the chatbot had no support email, recipient is NULL; accepted: the mail transport
--   accepted it, which is not proof of delivery)
CREATE TABLE IF NOT EXISTS enquiries (
    id           UUID        PRIMARY KEY,
    chatbot_id   UUID        NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
    request_id   TEXT        NOT NULL,
    name         TEXT        NOT NULL,
    email        TEXT        NOT NULL,
    question     TEXT        NOT NULL,
    details      TEXT,
    recipient    TEXT,
    status       TEXT        NOT NULL DEFAULT 'open',
    email_status TEXT        NOT NULL DEFAULT 'pending',
    email_error  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    emailed_at   TIMESTAMPTZ,
    handled_at   TIMESTAMPTZ,
    UNIQUE (chatbot_id, request_id)
);
CREATE INDEX IF NOT EXISTS enquiries_chatbot_idx ON enquiries (chatbot_id, created_at DESC);

-- Customer accounts (dashboard logins, created by the platform admin only). Passwords are stored only as
-- scrypt strings (scrypt$N$r$p$salt$hash), never in plain text. status: active | disabled
CREATE TABLE IF NOT EXISTS accounts (
    id                  UUID        PRIMARY KEY,
    email               TEXT        NOT NULL,
    password_hash       TEXT        NOT NULL,
    status              TEXT        NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_idx ON accounts (lower(email));

-- Server-side login sessions. token_hash = SHA-256 of the cookie value (the token itself is never stored).
CREATE TABLE IF NOT EXISTS sessions (
    token_hash   BYTEA       PRIMARY KEY,
    account_id   UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- The one owner of each chatbot. NULL = not assigned yet (visible to the platform admin key only).
-- ON DELETE RESTRICT: an account that still owns chatbots cannot be deleted by accident.
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS owner_account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS chatbots_owner_idx ON chatbots (owner_account_id);
