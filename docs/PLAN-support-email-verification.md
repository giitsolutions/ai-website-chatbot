# Plan: verify each support email before sending (not implemented)

Status: design only, awaiting approval. Nothing here is built, and the SQL has not been run anywhere.

## Problem

Enquiries contain a visitor's name, email address and question, and they are emailed to whatever address is saved as the
chatbot's support email. Today that address is only checked for format. Without proof that someone controls it:

- a typo sends a visitor's personal details to a stranger;
- a customer can point the platform's mail at any third party;
- bounces and spam complaints hurt the one sender address that every customer shares.

Since 2026-11-01 the first index saves an address found on the website automatically, unconfirmed (the user's decision for now). This plan is what makes that safe for real customers.

The suggestions on the Customise tab do not solve this. A customer's website is not verified on this platform, and an
address found on a website proves nothing about who is typing in the dashboard. **Suggested addresses, and addresses on the
website's own domain, go through the same confirmation as any other.**

## Rules

| Situation | What happens |
|---|---|
| Address set or changed (customer or admin) | Saved at once and a confirmation email is sent to it. Enquiries are saved, not emailed, until it is confirmed |
| Saved again with no real change (only upper/lower case differs) | Nothing is sent and the status stays the same |
| Changed again while waiting | The older links stop working at once and a new email goes to the new address. Only the latest address can be confirmed |
| Changed away from a confirmed address | The old address stops getting mail immediately, because the owner replaced it for a reason |
| Changed back to the last confirmed address | It counts as confirmed with no new email, because that person already agreed for this chatbot |
| Address cleared | Pending links stop working; enquiries get today's `no-recipient` status |
| Link expired (after 72 hours) | The dashboard shows "Confirmation expired" with **Resend confirmation**. 72 hours allows for weekends and shared inboxes |
| Link opened a second time, replaced or unknown | The same page each time: "This link is no longer valid." It reveals nothing about the chatbot |
| Recipient clicks "This wasn't me" | Links for this address stop working and it is blocked platform-wide. The dashboard says it could not be confirmed |
| Admin changes a customer's address | Same rules. There is no way to skip confirmation (see open question 2) |
| Chatbot deleted | Its verification rows go with it (`ON DELETE CASCADE`) |

### Order of checks when an enquiry arrives

`no-recipient` → `disabled` (no email setup) → **`unverified-recipient`** (new) → send (`accepted` / `failed`).

- `email_status` is plain `TEXT`, so the new value needs no SQL. It is added to `ENQUIRY_EMAIL_STATUSES` and to the dashboard's text.
- Visitors see the existing "saved for the support team" message and are never told why it was not emailed.

### After confirmation

Enquiries held as `unverified-recipient` from the last 30 days are sent to the confirmed address, newest first, at most 50,
one at a time in the background. Older ones keep their per-enquiry **Resend email** button. The existing resend route
refuses with `409` while the current address is unconfirmed. Without this catch-up, questions asked during the wait would
go unanswered unless the owner happened to look.

### Dashboard

- Customise, next to the field: "Waiting for confirmation of `<address>`" with **Resend confirmation**, or "Confirmed", or
  "Confirmation expired", or "This address declined".
- Enquiries tab: the same line replaces the "email not sent" explanation.
- The address is rendered as text only, like every other value on the page.

## Abuse limits (anti-spam)

The confirmation email is the one thing a customer can make the platform send to any address, so it carries limits and
fixed content.

Limits are counted from `support_email_verifications` in the database: they must survive a restart and cover all customers,
which the current in-memory, per-IP `rateLimit()` cannot do.

| Limit | Value | Why |
|---|---|---|
| Per chatbot | 1 per 60 s, 3 per hour, 10 per day | Stops repeated changes and Resend clicks |
| Per recipient address, across all chatbots | 5 per day | Protects a third party from many customers or accounts |
| Per customer account | 20 per day | Stops one account working through a list of addresses |
| Whole platform | 500 per day (`SUPPORT_EMAIL_DAILY_LIMIT`) | Circuit breaker that protects the sender's reputation; logs an error |
| Blocked address ("This wasn't me") | Never sent again | Lets a stranger end it with one click |

- Over a limit, the address is still saved, nothing is sent, and the dashboard says when to try again. Resend answers `429`.
- **Fixed content:** the email has only fixed text, the website's host name and the links. It leaves out the chatbot's name,
  welcome message and anything else a customer typed, so it cannot carry someone else's advert. No Reply-To.
- Logs show the domain only, never the full address or the token.

## Links and tokens

- 32 random bytes (`crypto.randomBytes`, base64url). Only the SHA-256 is stored, as with session tokens.
- **Opening the link changes nothing.** `GET` shows a page with **Confirm** and **This wasn't me** buttons, and only the
  `POST` acts on it. Mail security scanners open links automatically, so a link that confirmed on `GET` could be confirmed
  with no person involved.
- Single use, enforced by one atomic statement, which also requires that the address is still the chatbot's current one:

```sql
WITH used AS (
    UPDATE support_email_verifications v
    SET confirmed_at = NOW()
    FROM chatbots c
    WHERE v.token_hash = $1 AND v.chatbot_id = c.id
      AND v.confirmed_at IS NULL AND v.ended_at IS NULL AND v.expires_at > NOW()
      AND lower(v.address) = lower(c.support_email)
    RETURNING v.chatbot_id, v.address
)
UPDATE chatbots c
SET support_email_verified_address = used.address, support_email_verified_at = NOW()
FROM used WHERE c.id = used.chatbot_id
RETURNING c.id;
```

- A page with a token is served with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and request logging must
  leave out its query string.

"Confirmed" is derived rather than stored as a flag: `lower(support_email) = lower(support_email_verified_address)`. A
changed address is therefore unconfirmed automatically, with no second column to keep in step.

## SQL (additive only)

Needs separate approval, then goes in `db/schema.sql` and is applied with `npm run setup:db`.

```sql
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS support_email_verified_address TEXT;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS support_email_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS support_email_verifications (
    id           UUID        PRIMARY KEY,
    chatbot_id   UUID        NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
    address      TEXT        NOT NULL,
    token_hash   BYTEA       NOT NULL UNIQUE,
    account_id   UUID,       -- who asked; NULL = platform admin. No foreign key: the row outlives nothing it needs.
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    confirmed_at TIMESTAMPTZ,
    ended_at     TIMESTAMPTZ,  -- replaced, cleared or declined
    end_reason   TEXT
);
CREATE INDEX IF NOT EXISTS support_email_verifications_chatbot_idx ON support_email_verifications (chatbot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_email_verifications_address_idx ON support_email_verifications (lower(address), created_at DESC);
CREATE INDEX IF NOT EXISTS support_email_verifications_account_idx ON support_email_verifications (account_id, created_at DESC);

-- "This wasn't me": SHA-256 of the lower-case address, so a person who said no is not kept in readable form.
CREATE TABLE IF NOT EXISTS support_email_blocks (
    address_hash BYTEA       PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Verification rows older than 90 days are removed at startup. The limits only need the last 24 hours.

### Rollback

Turn the feature off (`SUPPORT_EMAIL_VERIFICATION=off`) and restore the previous code first, then:

```sql
UPDATE enquiries SET email_status = 'pending' WHERE email_status = 'unverified-recipient';
DROP TABLE IF EXISTS support_email_blocks;
DROP TABLE IF EXISTS support_email_verifications;
ALTER TABLE chatbots DROP COLUMN IF EXISTS support_email_verified_at;
ALTER TABLE chatbots DROP COLUMN IF EXISTS support_email_verified_address;
```

The enquiries themselves are never removed. The `UPDATE` only keeps held enquiries resendable under the older code.

## Existing chatbots

Addresses saved before this feature have never been confirmed. The options:

| Option | Effect | Risk |
|---|---|---|
| A. **Grandfather once (recommended)** | Addresses existing at rollout count as confirmed, with one `UPDATE` run as a reviewed step | An old typo stays until someone notices, as it does today |
| B. Confirm everything | A confirmation goes to each existing address and mail stops until it is answered | Working chatbots silently stop emailing if nobody clicks |

Recommended because customer accounts are new, so these addresses were set by the platform admin rather than by unknown
customers. List them and review them first.

```sql
UPDATE chatbots
SET support_email_verified_address = support_email, support_email_verified_at = NOW()
WHERE support_email IS NOT NULL AND support_email_verified_address IS NULL;
```

**Rollout order:** migration → grandfather `UPDATE` → switch `SUPPORT_EMAIL_VERIFICATION=on`. The switch defaults to `off`,
which keeps today's behaviour exactly.

## Routes

| Route | Who | What |
|---|---|---|
| `PATCH /api/admin/chatbots/:id` (existing) | Owner or admin | A changed `supportEmail` ends older links and sends a confirmation. The response adds `settings.supportEmailStatus`: `none`, `confirmed`, `pending`, `expired`, `declined`, plus `confirmationSent` (`true`, or why not) |
| `GET /api/admin/chatbots`, `/:id` (existing) | Owner or admin | Include `supportEmailStatus` |
| `POST /api/admin/chatbots/:id/support-email/resend-confirmation` | Owner or admin | New token, older links end. `200`; `409` no address, already confirmed, or email not set up; `429` over a limit; another customer's chatbot `404` |
| `GET /support-email/confirm?token=…` | Public | The page with two buttons. Changes nothing |
| `POST /support-email/confirm` `{ token }` | Public | Confirms, then starts the catch-up send |
| `POST /support-email/decline` `{ token }` | Public | Ends the link and blocks the address |
| `POST /api/admin/chatbots/:id/enquiries/:enquiryId/resend` (existing) | Owner or admin | Adds `409` "Waiting for confirmation" while unconfirmed |

Public routes are rate-limited per IP (20 per 10 minutes) and use a plain HTML form, so they need no script. The token is
the only credential. They need no login, because the person confirming often has no account.

## The server's public address

The link must point at this server, and it must **not** be built from the request's `Host` header: a forged header would put
an attacker's address in an email sent by the platform.

New setting `APP_BASE_URL`, used only for these links:

| Where | Value | Effect |
|---|---|---|
| Local development now | Empty, or `http://localhost:<port>` | With `EMAIL_TRANSPORT=test` the link is read from the in-memory outbox. A real email with a `localhost` link only works on the same computer |
| Hosted | `https://app.<platform domain>` | Required. The address must be `https://` unless it is `localhost` |

With the feature on, real SMTP in use and `APP_BASE_URL` missing or invalid, no confirmation is sent, the server logs the
setting's name at startup, and the dashboard says confirmation is not available. Enquiries stay saved.

## Email sending setup for a SaaS

**One platform sender for everyone**, for example `notifications@<platform domain>`, through a transactional email service.
This is the shape the code already has, using nodemailer and SMTP settings in `.env`:

- The sender name is per chatbot ("Shop Chatbot").
- Enquiry emails use the visitor as Reply-To.
- The confirmation email uses a fixed name and no Reply-To.

Every service below offers SMTP, so **no new dependency and no code change** is needed to switch between them. Never send
*from* a customer's or visitor's domain: without that domain's DKIM it fails DMARC and is likely to be rejected or filed as
spam.

### Comparison

Checked 2026-10-31, mostly from third-party pricing pages, which disagree in places. **Check each official pricing page
before signing up.** The India notes are from general knowledge and were not checked with the providers.

| Service | Free tier | Paid entry | Setup | India |
|---|---|---|---|---|
| **Brevo** | 300 emails/day, no card | About $9/month for 5,000 | Simple: verify the domain, add DNS, copy SMTP login | Check if free-plan emails carry Brevo branding |
| **Amazon SES** | Small and time-limited; sources conflict | About $0.10 per 1,000, plus data costs | Most work: AWS account, then a request to leave the sandbox, and bounce handling is yours to build | Mumbai region reported; check AWS India billing |
| **Postmark** | 100 emails/month | About $15/month for 10,000 | Simple, transactional-only, known for deliverability | Check that the card works for recurring payments |
| **SendGrid** | No lasting free plan: 60-day trial, 100/day | About $19.95/month | Moderate | Check that the card works for recurring payments |

**Recommendation:** start on **Brevo's free tier**. It costs nothing, needs little setup and comfortably covers a pilot. Move
to **SES** when volume makes price matter, or **Postmark** if deliverability becomes the problem. Switching only means new
`.env` values and DNS records.

### Domain setup (so emails don't land in spam)

Exact values come from the chosen service's dashboard. Consider a sending subdomain such as `mail.<platform domain>`: its
reputation then stays separate from the main domain's own mail. All of these are public DNS records and contain no secrets.

| Record | Example | Purpose |
|---|---|---|
| SPF (TXT) | `v=spf1 include:<service's value> ~all` | Says which servers may send for the domain. **Only one SPF record per domain**: merge rather than add a second |
| DKIM (TXT or CNAME) | Name and value from the service | Signs each email, proving it was not altered |
| DMARC (TXT at `_dmarc`) | `v=DMARC1; p=none; rua=mailto:dmarc@<platform domain>` | What to do when the checks fail, and where reports go. Start at `p=none`, read the reports, then move to `p=quarantine` |
| Custom return path (CNAME, if offered) | From the service | Lets SPF align with the From domain |

DMARC needs the From domain to match the domain passing DKIM or SPF, so a service's shared default domain is not enough.

Gmail's stricter bulk-sender rules start at about 5,000 messages a day and include a complaint rate under 0.3%. The sources
checked did not settle whether one-click unsubscribe applies to transactional mail. Volume here should be far below that,
but set up all three records from the start.

Before launch, send to Gmail, Outlook and Yahoo mailboxes and read the "SPF / DKIM / DMARC: pass" lines in the headers.
Bounces and complaints reported by the service are a later step: they should eventually mark an address as not deliverable.

## Tests (planned)

Isolated (`tests/run-isolated.js`), `EMAIL_TRANSPORT=test`, at least two customers:

- **Set and change:** setting an address sends one email to it, from the platform sender, with no Reply-To; only the hash is in the database; re-saving the same address, in any case, sends nothing.
- **Content:** a chatbot name with spam text or header injection never appears in the email.
- **Held enquiries:** until confirmed the status is `unverified-recipient`, nothing is emailed, the visitor sees "saved", and enquiry resend answers `409`.
- **Scanners:** `GET` with a valid token, repeated, changes nothing.
- **Confirming:** `POST` confirms and later enquiries are sent; held ones are sent (newest first, 30 days, 50 at most), and older ones stay resendable.
- **Token rules:** a second use, an expired token, an unknown token and a token for an older address all give the same "no longer valid" page.
- **Simultaneous:** two `POST`s at once confirm once and send the catch-up once.
- **Changes:** A → B ends A's links and stops mail to A; B → A counts as confirmed with no email; clearing ends the links.
- **Limits:** each limit is enforced, survives a server restart, and counts across chatbots and accounts; a platform limit stops sending.
- **Decline:** "This wasn't me" blocks the address for every customer and stores only a hash.
- **Isolation:** customer A resending or reading B's status gets `404`; A's token confirms only A's chatbot.
- **Base address:** a forged `Host` header never changes the link; a missing or `http://` hosted `APP_BASE_URL` sends nothing and says so.
- **Logs:** no token and no full address.
- **Switch off:** today's behaviour, exactly (all existing contact and enquiry suites).
- **Migration:** applying it twice is harmless; rollback works on a copy; the grandfather `UPDATE` touches only rows with an address.
- **Browser at 375 px:** waiting, confirmed and expired states; Resend confirmation; the public page works without JavaScript.

## Open questions

1. Grandfather existing addresses, or confirm them all? Recommended: grandfather once.
2. Should the platform admin be able to mark an address confirmed, for example for a customer whose mail system blocks the
   link? Recommended: no at first. If added later, it should be recorded in the log.
3. Should the old confirmed address keep receiving mail until the new one is confirmed? This plan says no, as requested.
   The cost is a gap in email (not in saved enquiries) if nobody confirms.
4. Are the catch-up limits of 30 days and 50 enquiries right?
5. Which email service, and which platform domain? Both must be decided by a person, and the domain needs DNS access.
