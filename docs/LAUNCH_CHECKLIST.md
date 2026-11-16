# Launch checklist: hosting this for real customers

Status on 2026-11-01. **The platform is not ready for real customers yet.** It runs on one Windows laptop over plain HTTP.

The biggest gaps are hosting with HTTPS, automated backups, confirmed support email addresses, and a privacy policy.

- **DONE:** built and tested; nothing more to do before launch.
- **TODO:** the work is clear and needs no decision.
- **NEEDS DECISION:** someone must choose first. The question is in the item.

Owners: **User** (project owner), **Mentor**, **Developer** (whoever writes the code, a person or an AI session).

## 1. Hosting and HTTPS

| Item | Status | Owner | Notes |
|---|---|---|---|
| Choose where it runs | NEEDS DECISION | User, Mentor | Which provider, and is a GPU rented or does a smaller or hosted model replace it? Today the answer model needs about 3.2 GB of GPU memory. |
| Expected load | NEEDS DECISION | User, Mentor | How many customers and questions at launch? The server answers one question at a time, with 2 waiting; more get "busy". |
| Domain for the chatbot server | NEEDS DECISION | User | The address customers paste in their snippet. Changing it later means every customer changes their snippet, so choose one that will last. |
| HTTPS in front of the server | TODO | Developer | Required: a website on HTTPS cannot load the widget over HTTP. Use a reverse proxy with an automatic certificate. |
| `TRUST_PROXY` | TODO | Developer | Set to the number of proxies. Without it, HTTPS is not detected and all visitors can look like one address to the rate limits. Exists in the code. |
| `COOKIE_SECURE` | TODO | Developer | The `Secure` cookie flag is on when the request is HTTPS. Set `COOKIE_SECURE=true` as a safeguard on the hosted server. Exists in the code. |
| `APP_BASE_URL` | TODO | Developer | **Does not exist yet.** It is only planned, for the links in confirmation emails (Part 2 below). Set it when that is built. |
| Run as a service that restarts itself | TODO | Developer | Today a person starts it in a terminal. Docker Desktop must also be started by hand after a reboot. |
| `DOCUMENT_LINK_SECRET` set to a fixed value | TODO | User | Without it, visitors' document links break at every restart. |
| `OLLAMA_KEEP_ALIVE=30m` | TODO | User | Avoids an 8-10 s reload after 5 idle minutes. Measured in `HANDOFF.md`, "Answer quality". |
| Database role with limited rights | TODO | Developer | The app's database role is a superuser today. |
| Dashboard reachable only over HTTPS | TODO | Developer | Admin keys and passwords must never cross plain HTTP. |
| Move the code off the laptop | NEEDS DECISION | User, Mentor | See "Push to a remote repository" in section 7. |

## 2. Email

Plan: [PLAN-support-email-verification.md](PLAN-support-email-verification.md).

| Item | Status | Owner | Notes |
|---|---|---|---|
| One SMTP account sends for every chatbot; subject, sender name and body per chatbot | DONE | | Tested with a fake transport only. |
| Enquiry saved before any email is tried | DONE | | Nothing is lost if email fails. |
| Choose the email service | NEEDS DECISION | User, Mentor | The plan recommends starting on Brevo's free tier. Check prices on the official page: the plan's figures are mostly from third-party sites. |
| Choose the sending domain | NEEDS DECISION | User, Mentor | Needs access to its DNS settings. |
| SPF, DKIM and DMARC records | TODO | User | After the two choices above. Without them, mail is likely to land in spam. |
| Real SMTP settings in `.env` | NEEDS DECISION | User | Also listed in section 7. Set by the user, never by an AI session. |
| Support email verification (Part 2) | NEEDS DECISION | User, Mentor | Also listed in section 7. Until it exists, a typo sends a visitor's details to a stranger. Recommended before real email is turned on. |

## 3. Backups

| Item | Status | Owner | Notes |
|---|---|---|---|
| Restore has been proven once by hand | DONE | | 2026-10-28, on the laptop. The scripts were not kept in the project. |
| Automated PostgreSQL backup | TODO | Developer | Holds accounts, chatbots and enquiries. Never put the password on a command line. |
| Automated Qdrant backup | TODO | Developer | Snapshots of `website_content`. Can be rebuilt by re-crawling, but slowly, and uploaded documents need re-indexing. |
| Automated backup of `data/uploads` | TODO | Developer | Customers' uploaded files; these cannot be rebuilt. |
| Backups kept off the server, and encrypted | TODO | Developer | They contain personal data. |
| How often, and how long to keep them | NEEDS DECISION | User, Mentor | How much data could you afford to lose: an hour or a day? |
| Scheduled restore test | TODO | Developer | A backup that was never restored is not proven. |

## 4. Monitoring and logs

| Item | Status | Owner | Notes |
|---|---|---|---|
| Health check `/api/health` | DONE | | Reports Qdrant, Ollama and the database. |
| Questions are not written to the chat log, only their length | DONE | | Visitor details are not logged by the contact flow. |
| Logs saved to files, with rotation | TODO | Developer | Logs only go to the console today and are lost on a crash or restart. |
| Alert when the health check fails | TODO | Developer | Nobody is told today. |
| Alert on GPU or disk problems and failed backups | TODO | Developer | Also watch for "using Ollama's placement from now on": full speed returns only after a restart. |
| Who responds when it is down | NEEDS DECISION | User, Mentor | |

## 5. Rate limits and abuse

| Item | Status | Owner | Notes |
|---|---|---|---|
| Limits on chat, contact form, login, crawling, registration and documents | DONE | | For example chat 30 per minute and contact 5 per hour, per address. |
| Crawler safety: public addresses only, pinned IP, ports 80 and 443, size and request limits | DONE | | |
| Limits survive a restart and work on more than one server | TODO | Developer | They are in memory and reset on restart. Fine for one server. |
| One crawl at a time across all chatbots | TODO | Developer | Different chatbots can crawl together today, which is heavy on one machine. |
| Usage limits per customer | NEEDS DECISION | User, Mentor | Pages, questions per month, documents. Also decides pricing. |
| Signed "unanswered" token for the contact form | NEEDS DECISION | User, Mentor | Today anyone who knows a chatbot ID can submit enquiries, within the limits. |
| Website ownership check | NEEDS DECISION | User, Mentor | Any customer can register any public website today. The mentor said "later": is that before or after the first customers? |
| Allowed websites per chatbot | DONE | | Stops casual reuse in browsers. It is not authentication. |
| Public chatbot can quote uploaded documents | NEEDS DECISION | User, Mentor | Anyone with a chatbot ID can ask questions, so customers must be told not to upload confidential files, or private chatbots must be built. |

## 6. Privacy and retention

| Item | Status | Owner | Notes |
|---|---|---|---|
| Customers see only their own chatbots and enquiries | DONE | | Tested. Every admin key still sees everything. |
| Retention limit for enquiries | NEEDS DECISION | User, Mentor | Names, emails and questions are kept forever today. How long after being handled should they be deleted? Then a developer builds the automatic deletion. |
| Privacy policy, including what the widget collects | NEEDS DECISION | User, Mentor | Needs legal advice for the countries you serve, including India's data protection law if customers are there. |
| Terms for customers | NEEDS DECISION | User, Mentor | Crawling sites they do not own, uploaded content, wrong answers from the chatbot. |
| Delete a customer's data on request | TODO | Developer | Deleting a chatbot is built and tested. Deleting an account and all its data in one step is not. |
| Customers can change their own password | TODO | Developer | Only the platform admin can reset one today. |

## 7. Open decisions

| Decision | Status | Owner | What has to be decided |
|---|---|---|---|
| Button discovery | DONE (opt-in, platform admin only) | Next team | Built 2026-11-04. Open question: let customers turn it on? |
| GET-only crawler requests | NEEDS DECISION | User, Mentor | The crawler forwards all methods today. GET-only is safer, but a site whose content comes through POST loses that content. |
| Email verification (Part 2) | NEEDS DECISION | User, Mentor | Build it? It needs a database migration. The questions are in `HANDOFF.md`, open decision 9. |
| Real SMTP | NEEDS DECISION | User | When to turn on, after the service and domain above. |
| Password validation | NEEDS DECISION | User, Mentor | Only a length of 12-200 characters is checked today. Add character rules, a confirm field, or a common-password block? |
| The 13 deleted chatbots | NEEDS DECISION | User | Restore them from the Phase 0 backup, or leave them deleted? |
| `owner_account_id` NOT NULL | NEEDS DECISION | User, Mentor | Needs every chatbot to have an owner first, and a migration that is not additive. Do that now, or keep unassigned chatbots? |
| Push to a remote repository | NEEDS DECISION | User, Mentor | No remote exists: the code is on one laptop only, which is a real risk. Where, and private to whom? `ingest.js.before-http-fix.bak` went into an earlier commit, so check history before publishing. Run a secret scan over the full history first. |

## Suggested order

1. Push to a private remote: it costs little and protects all the work.
2. Choose hosting and domain, then HTTPS, service setup and `TRUST_PROXY`.
3. Automated backups, then logs and alerts.
4. Email service and domain, then verification (Part 2), then real SMTP.
5. Privacy policy, terms and retention.
6. Invite a first customer, and re-index with the current crawler.
