# contact-api

Standalone contact identity service with fuzzy matching. Deploy once on Railway (or anywhere Node runs), point any project at it, and stop creating duplicate clients.

## The Problem

When multiple systems create client records independently (CRM, booking, chatbot, invoicing), slight name variations ("Todd", "Todd Smith", "tod smith") create duplicates. This service sits in front of all of them as the single source of truth with fuzzy name matching, alias tracking, and external system linking.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check + DB status |
| `POST` | `/api/contacts/resolve` | Fuzzy match — find existing contact or return candidates |
| `POST` | `/api/contacts` | Create a new contact |
| `GET` | `/api/contacts` | Search/list (`?q=todd&email=...&phone=...&archived=false`) |
| `GET` | `/api/contacts/:uid` | Get contact with aliases + external links |
| `PATCH` | `/api/contacts/:uid` | Update (old values auto-saved as aliases) |
| `POST` | `/api/contacts/:uid/merge` | Merge source contact into target |
| `POST` | `/api/contacts/:uid/link` | Register external system link (Crater, Cal.com, Stripe, etc.) |
| `GET` | `/api/contacts/:uid/links` | List all external system links |
| `DELETE` | `/api/contacts/:uid` | Soft-archive |

## Resolution Algorithm

`POST /api/contacts/resolve` accepts `{ name, email, phone }` and returns:

| Result | Meaning |
|--------|---------|
| `{ match: "exact" }` | Email or phone matched an existing contact |
| `{ match: "likely", score }` | Name matched with high confidence (score >= 0.7) |
| `{ match: "possible", candidates }` | Fuzzy name matches found — caller should confirm |
| `{ match: "none" }` | No match — safe to create new contact |

Priority: **email** (exact) > **phone** (exact) > **name** (fuzzy via pg_trgm trigram similarity).

Name matching uses both full name and weighted first/last components (last name weighted 60%, first name 40%), plus any stored aliases.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | *(none)* | If set, all endpoints (except `/health`) require `X-API-Key` header |
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins for CORS |
| `APP_NAME` | `contact-api` | Service name in logs |
| `FUZZY_EXACT_THRESHOLD` | `0.7` | Trigram score above this = "likely" match |
| `FUZZY_POSSIBLE_THRESHOLD` | `0.3` | Trigram score above this = "possible" match |

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway service → connect the repo
3. Add a Postgres database to the project
4. Set `DATABASE_URL` to the Postgres connection string
5. Run the migration: `npm run migrate` (or set as a pre-deploy command)
6. Optionally generate a public domain or keep it internal-only

## Run Migration

```bash
DATABASE_URL=your_connection_string npm run migrate
```

This creates the `contacts`, `contact_aliases`, and `contact_links` tables with trigram indexes. Safe to run multiple times (uses `IF NOT EXISTS`).

## Usage Examples

### Resolve a contact (before booking or creating a CRM record)

```bash
curl -X POST https://your-domain/api/contacts/resolve \
  -H "Content-Type: application/json" \
  -d '{"name": "Todd Smith", "email": "todd@example.com"}'
```

### Create a contact

```bash
curl -X POST https://your-domain/api/contacts \
  -H "Content-Type: application/json" \
  -d '{"name": "Todd Smith", "email": "todd@example.com", "phone": "555-1234"}'
```

### Link to an external system

```bash
curl -X POST https://your-domain/api/contacts/CONTACT_UID/link \
  -H "Content-Type: application/json" \
  -d '{"system": "crater", "externalId": "42"}'
```

### Merge duplicates

```bash
curl -X POST https://your-domain/api/contacts/TARGET_UID/merge \
  -H "Content-Type: application/json" \
  -d '{"sourceUid": "DUPLICATE_UID"}'
```
