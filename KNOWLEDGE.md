# Contact API — Unified Client Identity

OpenClaw-facing knowledge for the contact-api service.

The **contact-api** is the single source of truth for client identity across
all systems an OpenClaw deployment talks to (Cal.com bookings, Crater
invoicing, Supabase CMS, etc.). It prevents duplicate client records caused by
slight name/email/phone variations across systems.

## When to Use

**Always resolve a contact before:**

- Creating a Crater invoice or customer
- Creating a Cal.com booking (the `calcom-booking-api` does this for you)
- Referencing a client in any external system

**Use resolution to answer:**

- "Is this a new client or an existing one?"
- "Do we already have a Todd Smith?" (fuzzy match handles `Tod Smith`, `T. Smith`)

## Resolution Algorithm

When you call `resolve`, the API checks in this order:

1. **Exact email match** → `match: "exact"`
2. **Exact phone match** → `match: "exact"`
3. **Fuzzy name match** (Postgres `pg_trgm` trigram similarity) → `match: "likely"` or `"possible"`
4. **No match** → `match: "none"`

| Match | Meaning | What the agent should do |
|---|---|---|
| `exact` | Confidence is high | Use the returned `.contact` directly |
| `likely` | Strong fuzzy hit | Use the returned `.contact` directly |
| `possible` | Ambiguous match | Ask the human to confirm; candidates are in `.candidates[]` |
| `none` | No match found | Create a new contact |

## API Endpoints

```
POST   /api/contacts/resolve     — fuzzy resolve by name/email/phone
POST   /api/contacts             — create
GET    /api/contacts             — list/search (?q=term)
GET    /api/contacts/:uid        — get by uid
PATCH  /api/contacts/:uid        — update
POST   /api/contacts/:uid/link   — add an external system link
POST   /api/contacts/:uid/merge  — merge duplicates
GET    /health                   — health check
```

### Cross-System Links

Each contact can be linked to IDs in other systems:

| System key | What it points at |
|---|---|
| `crater` | Crater customer ID |
| `calcom_booking` | Cal.com booking UID |
| `supabase` | Supabase profile UUID |

These links let the agent trace one human across every connected platform.

## Environment Variables

| Var | Purpose |
|---|---|
| `CONTACT_API_URL` | Base URL (e.g. `http://contact-api.railway.internal:8080`) |
| `CONTACT_API_KEY` | API key for authentication |

## Shell Helpers (OpenClaw runtime convention)

The OpenClaw runtime template (`clawdbot-railway-template`) ships shell
wrappers for the most common contact-api operations under
`{WORKSPACE_DIR}/scripts/`. They make the agent's life easier than building
curl invocations from scratch.

```bash
# Resolve — check if someone exists (fuzzy name/email/phone)
scripts/contact-api.sh resolve "Todd Smith" "todd@example.com" "555-1234"

# Create — add a new contact
scripts/contact-api.sh create "Todd Smith" "todd@example.com" "555-1234" "Acme Corp"

# Search — find contacts by name/email
scripts/contact-api.sh search "Todd"

# Get — fetch by UID
scripts/contact-api.sh get <uid>

# Link — connect to an external system (crater, calcom, supabase)
scripts/contact-api.sh link <uid> crater 42

# Merge — combine duplicates
scripts/contact-api.sh merge <keep-uid> <discard-uid>

# List all contacts
scripts/contact-api.sh list
```

## Workflows

### Creating an Invoice (with contact resolution)

```bash
# 1. Resolve the client
RESULT=$(scripts/contact-api.sh resolve "DPM Design" "dpm@example.com")

# 2. Check the match type
MATCH=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('match','none'))")

# 3. Branch on match
#    exact / likely  → use returned contact
#    possible        → ask human to confirm
#    none            → create new contact, then proceed

# 4. Create the invoice (crater-invoice.sh handles resolution + creation)
scripts/crater-invoice.sh "DPM Design" "Web maintenance" "Monthly retainer" 450 "dpm@example.com"
```

### Booking an Appointment

The `calcom-booking-api` calls `contact-api/resolve` automatically inside
`POST /api/booking/create`. If a `possible` match comes back, the booking API
returns `needsConfirmation: true` with candidates — present these to the human
before booking.

```bash
# Check availability
scripts/booking-api.sh availability

# Create booking (contact resolution happens server-side)
scripts/booking-api.sh create "Todd Smith" "todd@example.com" "2026-04-20T10:00:00"
```

### Checking the Calendar / Upcoming Meetings

When the user asks "what meetings do I have?", "who's on my calendar tomorrow?",
"any appointments this week?", etc:

```bash
# All future bookings, sorted by time
scripts/booking-api.sh list upcoming

# Past 30 days + future
scripts/booking-api.sh list

# A specific booking
scripts/booking-api.sh get <uid>
```

The response includes attendee name, email, start/end time, title, and status.
**Always filter out `status=cancelled` before presenting.**

### Cancelling / Rescheduling

```bash
scripts/booking-api.sh cancel <uid> "optional reason"
scripts/booking-api.sh reschedule <uid> "2026-04-25T14:00:00"
scripts/booking-api.sh event-types  # what's available
```

## Design Notes

- `pg_trgm` trigram similarity drives the fuzzy match. It's tolerant of
  typos and common abbreviations but it is **not** semantic — "Bob" will not
  match "Robert".
- The `merge` endpoint is **not idempotent** and **not reversible** at the API
  layer. Confirm both UIDs before calling it.
- Health endpoint is `GET /health` (no `/api` prefix).
