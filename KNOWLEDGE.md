# Contact API — Unified Client Identity

Prevents duplicate clients across systems (Cal.com, Crater, Supabase).

## API Endpoints

```
POST /api/contacts/resolve    — fuzzy match by name/email/phone
POST /api/contacts           — create new contact
GET  /api/contacts          — list/search (?q=term)
GET  /api/contacts/:uid      — get by UID
POST /api/contacts/:uid/link — link to external system
POST /api/contacts/:uid/merge — merge duplicates
```

## Resolution Order

1. Exact email match → `exact`
2. Exact phone match → `exact`
3. Fuzzy name match → `likely` or `possible`
4. No match → `none`

## Environment Variables

| Var | Purpose |
|-----|---------|
| `CONTACT_API_URL` | Base URL |
| `CONTACT_API_KEY` | Auth key |

## Workflow

1. Always resolve before creating invoices/bookings
2. If `possible` match — ask human to confirm
3. If `none` — create new contact