const express = require('express');
const { Pool } = require('pg');
const { ensureSchema } = require('./migrate');

const app = express();
// Portal metadata can include base64 logo/icon bytes (up to 2 MB each).
// Express defaults to 100kb, which rejects those saves with "Payload Too Large".
app.use(express.json({ limit: '15mb' }));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DATABASE_URL     = process.env.DATABASE_URL;
const API_KEY          = process.env.API_KEY || '';
const ALLOWED_ORIGINS  = process.env.ALLOWED_ORIGINS || '*';
const APP_NAME         = process.env.APP_NAME || 'contact-api';
const FUZZY_EXACT      = parseFloat(process.env.FUZZY_EXACT_THRESHOLD || '0.7');
const FUZZY_POSSIBLE   = parseFloat(process.env.FUZZY_POSSIBLE_THRESHOLD || '0.3');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 10,
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    const allowed = ALLOWED_ORIGINS.split(',').map(s => s.trim());
    if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Optional API-key gate
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.path === '/health' || req.method === 'OPTIONS') return next();
  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided !== API_KEY) return res.status(401).json({ error: 'Invalid or missing API key' });
  next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function splitName(fullName) {
  if (!fullName) return { first: null, last: null };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function normalizePhone(phone) {
  if (!phone) return null;
  return phone.replace(/\D/g, '');
}

function contactRow(c) {
  return {
    uid: c.uid,
    name: c.name,
    firstName: c.first_name,
    lastName: c.last_name,
    email: c.email,
    phone: c.phone,
    company: c.company,
    notes: c.notes,
    archived: c.archived,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

async function getContactFull(uid) {
  const cRes = await pool.query('SELECT * FROM contacts WHERE uid = $1', [uid]);
  if (cRes.rows.length === 0) return null;
  const contact = contactRow(cRes.rows[0]);
  const aRes = await pool.query(
    'SELECT field, value FROM contact_aliases WHERE contact_id = $1 ORDER BY field, value',
    [cRes.rows[0].id]
  );
  const lRes = await pool.query(
    'SELECT system, external_id, metadata FROM contact_links WHERE contact_id = $1 ORDER BY system',
    [cRes.rows[0].id]
  );
  contact.aliases = aRes.rows;
  contact.links = lRes.rows.map(l => ({ system: l.system, externalId: l.external_id, metadata: l.metadata }));
  return contact;
}

async function addAlias(contactId, field, value) {
  if (!value) return;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return;
  try {
    await pool.query(
      `INSERT INTO contact_aliases (contact_id, field, value)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [contactId, field, value.trim()]
    );
  } catch { /* ignore dupe */ }
}

// ============================== ROUTES ======================================

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: APP_NAME, db: 'connected' });
  } catch (e) {
    res.status(503).json({ status: 'error', db: 'disconnected', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/contacts/resolve — the core fuzzy matching endpoint
// ---------------------------------------------------------------------------
app.post('/api/contacts/resolve', async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    if (!name && !email && !phone) {
      return res.status(400).json({ error: 'Provide at least one of: name, email, phone' });
    }

    // Step 1: Exact email match
    if (email) {
      const r = await pool.query(
        `SELECT c.* FROM contacts c
         WHERE lower(c.email) = lower($1) AND c.archived = false
         UNION
         SELECT c.* FROM contacts c
         JOIN contact_aliases a ON a.contact_id = c.id
         WHERE a.field = 'email' AND lower(a.value) = lower($1) AND c.archived = false
         LIMIT 1`,
        [email.trim()]
      );
      if (r.rows.length > 0) {
        const contact = contactRow(r.rows[0]);
        if (name && name.trim().toLowerCase() !== r.rows[0].name.toLowerCase()) {
          await addAlias(r.rows[0].id, 'name', name);
        }
        await pool.query('UPDATE contacts SET updated_at = NOW() WHERE id = $1', [r.rows[0].id]);
        return res.json({ match: 'exact', field: 'email', contact });
      }
    }

    // Step 2: Exact phone match (digits only)
    if (phone) {
      const digits = normalizePhone(phone);
      if (digits && digits.length >= 7) {
        const r = await pool.query(
          `SELECT c.* FROM contacts c
           WHERE regexp_replace(c.phone, '\\D', '', 'g') = $1 AND c.archived = false
           UNION
           SELECT c.* FROM contacts c
           JOIN contact_aliases a ON a.contact_id = c.id
           WHERE a.field = 'phone' AND regexp_replace(a.value, '\\D', '', 'g') = $1 AND c.archived = false
           LIMIT 1`,
          [digits]
        );
        if (r.rows.length > 0) {
          const contact = contactRow(r.rows[0]);
          if (name && name.trim().toLowerCase() !== r.rows[0].name.toLowerCase()) {
            await addAlias(r.rows[0].id, 'name', name);
          }
          await pool.query('UPDATE contacts SET updated_at = NOW() WHERE id = $1', [r.rows[0].id]);
          return res.json({ match: 'exact', field: 'phone', contact });
        }
      }
    }

    // Step 3: Fuzzy name match
    if (name) {
      const input = name.trim();
      const { first, last } = splitName(input);

      // Score against contacts table + aliases
      const r = await pool.query(
        `WITH name_scores AS (
           SELECT c.*,
             GREATEST(
               similarity(c.name, $1),
               COALESCE(similarity(c.first_name, $2), 0) * 0.4 +
               COALESCE(similarity(c.last_name, $3), 0) * 0.6
             ) AS score
           FROM contacts c
           WHERE c.archived = false
             AND (
               similarity(c.name, $1) > $4
               OR similarity(c.last_name, $3) > $4
               OR similarity(c.first_name, $2) > $4
             )
         ),
         alias_scores AS (
           SELECT c.*,
             similarity(a.value, $1) AS score
           FROM contacts c
           JOIN contact_aliases a ON a.contact_id = c.id
           WHERE a.field = 'name'
             AND c.archived = false
             AND similarity(a.value, $1) > $4
         ),
         combined AS (
           SELECT * FROM name_scores
           UNION ALL
           SELECT * FROM alias_scores
         )
         SELECT DISTINCT ON (uid) *
         FROM combined
         ORDER BY uid, score DESC`,
        [input, first || '', last || input, FUZZY_POSSIBLE]
      );

      if (r.rows.length > 0) {
        const sorted = r.rows.sort((a, b) => b.score - a.score);
        const top = sorted[0];

        if (top.score >= FUZZY_EXACT) {
          return res.json({
            match: 'likely',
            score: Math.round(top.score * 100) / 100,
            contact: contactRow(top),
            candidates: sorted.slice(0, 5).map(c => ({
              ...contactRow(c),
              score: Math.round(c.score * 100) / 100,
            })),
          });
        }

        return res.json({
          match: 'possible',
          candidates: sorted.slice(0, 5).map(c => ({
            ...contactRow(c),
            score: Math.round(c.score * 100) / 100,
          })),
        });
      }
    }

    // Step 4: No match
    res.json({ match: 'none' });
  } catch (e) {
    console.error('[Resolve Error]', e);
    res.status(500).json({ error: 'Resolution failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/contacts — create
// ---------------------------------------------------------------------------
app.post('/api/contacts', async (req, res) => {
  try {
    const { name, email, phone, company, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { first, last } = splitName(name);
    const r = await pool.query(
      `INSERT INTO contacts (name, first_name, last_name, email, phone, company, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name.trim(), first, last, email?.trim() || null, normalizePhone(phone), company?.trim() || null, notes?.trim() || null]
    );
    const contact = contactRow(r.rows[0]);
    res.status(201).json({ success: true, contact });
  } catch (e) {
    console.error('[Create Error]', e);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/contacts — list / search
// ---------------------------------------------------------------------------
app.get('/api/contacts', async (req, res) => {
  try {
    const { q, email, phone, archived } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);

    let where;
    const params = [];
    let paramIdx = 1;

    if (archived === 'true') {
      where = 'archived = true';
    } else {
      where = '(archived IS NOT TRUE)';
    }

    if (q) {
      where += ` AND (similarity(name, $${paramIdx}) > 0.2 OR name ILIKE $${paramIdx + 2} OR lower(email) LIKE lower($${paramIdx + 1}))`;
      params.push(q, `%${q}%`, `%${q}%`);
      paramIdx += 3;
    }
    if (email) {
      where += ` AND lower(email) = lower($${paramIdx})`;
      params.push(email);
      paramIdx++;
    }
    if (phone) {
      const digits = normalizePhone(phone);
      where += ` AND regexp_replace(phone, '\\D', '', 'g') = $${paramIdx}`;
      params.push(digits);
      paramIdx++;
    }

    const countRes = await pool.query(`SELECT count(*) FROM contacts WHERE ${where}`, params);
    const r = await pool.query(
      `SELECT * FROM contacts WHERE ${where}
       ORDER BY ${q ? `similarity(name, '${q.replace(/'/g, "''")}') DESC,` : ''} updated_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({
      success: true,
      total: parseInt(countRes.rows[0].count, 10),
      contacts: r.rows.map(contactRow),
    });
  } catch (e) {
    console.error('[List Error]', e);
    res.status(500).json({ error: 'Failed to list contacts' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/contacts/:uid
// ---------------------------------------------------------------------------
app.get('/api/contacts/:uid', async (req, res) => {
  try {
    const contact = await getContactFull(req.params.uid);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true, contact });
  } catch (e) {
    console.error('[Get Error]', e);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/contacts/:uid
// ---------------------------------------------------------------------------
app.patch('/api/contacts/:uid', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM contacts WHERE uid = $1', [req.params.uid]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });

    const c = existing.rows[0];
    const name    = req.body.name    ?? c.name;
    const email   = req.body.email   ?? c.email;
    const phone   = req.body.phone !== undefined ? normalizePhone(req.body.phone) : c.phone;
    const company = req.body.company ?? c.company;
    const notes   = req.body.notes   ?? c.notes;
    const { first, last } = splitName(name);

    // Store old values as aliases before overwriting
    if (req.body.name && req.body.name.trim().toLowerCase() !== c.name.toLowerCase()) {
      await addAlias(c.id, 'name', c.name);
    }
    if (req.body.email && req.body.email.trim().toLowerCase() !== (c.email || '').toLowerCase() && c.email) {
      await addAlias(c.id, 'email', c.email);
    }
    if (req.body.phone && normalizePhone(req.body.phone) !== c.phone && c.phone) {
      await addAlias(c.id, 'phone', c.phone);
    }

    await pool.query(
      `UPDATE contacts SET name = $1, first_name = $2, last_name = $3, email = $4,
       phone = $5, company = $6, notes = $7, updated_at = NOW() WHERE uid = $8`,
      [name.trim(), first, last, email?.trim() || null, phone, company?.trim() || null, notes?.trim() || null, req.params.uid]
    );

    const contact = await getContactFull(req.params.uid);
    res.json({ success: true, contact });
  } catch (e) {
    console.error('[Update Error]', e);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/contacts/:uid/merge — merge source into this contact
// ---------------------------------------------------------------------------
app.post('/api/contacts/:uid/merge', async (req, res) => {
  try {
    const { sourceUid } = req.body;
    if (!sourceUid) return res.status(400).json({ error: 'sourceUid is required' });

    const target = await pool.query('SELECT * FROM contacts WHERE uid = $1', [req.params.uid]);
    const source = await pool.query('SELECT * FROM contacts WHERE uid = $1', [sourceUid]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'Target contact not found' });
    if (source.rows.length === 0) return res.status(404).json({ error: 'Source contact not found' });

    const t = target.rows[0];
    const s = source.rows[0];

    // Store source's canonical info as aliases on target
    await addAlias(t.id, 'name', s.name);
    if (s.email) await addAlias(t.id, 'email', s.email);
    if (s.phone) await addAlias(t.id, 'phone', s.phone);

    // Move all aliases from source to target
    await pool.query(
      `UPDATE contact_aliases SET contact_id = $1 WHERE contact_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM contact_aliases WHERE contact_id = $1 AND field = contact_aliases.field AND value = contact_aliases.value
       )`,
      [t.id, s.id]
    );

    // Move all links from source to target
    await pool.query(
      `UPDATE contact_links SET contact_id = $1 WHERE contact_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM contact_links WHERE contact_id = $1 AND system = contact_links.system AND external_id = contact_links.external_id
       )`,
      [t.id, s.id]
    );

    // Archive the source
    await pool.query('UPDATE contacts SET archived = true, updated_at = NOW() WHERE id = $1', [s.id]);
    await pool.query('UPDATE contacts SET updated_at = NOW() WHERE id = $1', [t.id]);

    const contact = await getContactFull(req.params.uid);
    res.json({ success: true, contact, mergedFrom: sourceUid });
  } catch (e) {
    console.error('[Merge Error]', e);
    res.status(500).json({ error: 'Merge failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/contacts/:uid/link — register external system link
// ---------------------------------------------------------------------------
app.post('/api/contacts/:uid/link', async (req, res) => {
  try {
    const { system, externalId, metadata } = req.body;
    if (!system || !externalId) return res.status(400).json({ error: 'system and externalId are required' });

    const c = await pool.query('SELECT id FROM contacts WHERE uid = $1', [req.params.uid]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });

    await pool.query(
      `INSERT INTO contact_links (contact_id, system, external_id, metadata)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (system, external_id)
       DO UPDATE SET contact_id = $1, metadata = COALESCE($4, contact_links.metadata)`,
      [c.rows[0].id, system, externalId, metadata ? JSON.stringify(metadata) : '{}']
    );

    res.json({ success: true });
  } catch (e) {
    console.error('[Link Error]', e);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/contacts/:uid/links
// ---------------------------------------------------------------------------
app.get('/api/contacts/:uid/links', async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM contacts WHERE uid = $1', [req.params.uid]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });

    const r = await pool.query(
      'SELECT system, external_id, metadata FROM contact_links WHERE contact_id = $1 ORDER BY system',
      [c.rows[0].id]
    );
    res.json({
      success: true,
      links: r.rows.map(l => ({ system: l.system, externalId: l.external_id, metadata: l.metadata })),
    });
  } catch (e) {
    console.error('[Links Error]', e);
    res.status(500).json({ error: 'Failed to fetch links' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/contacts/:uid — soft archive (default) or permanent delete (?permanent=true)
// ---------------------------------------------------------------------------
app.delete('/api/contacts/:uid', async (req, res) => {
  try {
    const uid = req.params.uid;
    const permanent = req.query.permanent === 'true';

    if (permanent) {
      const r = await pool.query('DELETE FROM contacts WHERE uid = $1 RETURNING uid', [uid]);
      if (r.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
      return res.json({ success: true, message: 'Contact permanently deleted' });
    }

    const r = await pool.query(
      'UPDATE contacts SET archived = true, updated_at = NOW() WHERE uid = $1 AND (archived IS NOT TRUE) RETURNING uid',
      [uid]
    );
    if (r.rows.length > 0) {
      return res.json({ success: true, message: 'Contact archived' });
    }

    const check = await pool.query('SELECT uid, archived FROM contacts WHERE uid = $1', [uid]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    if (check.rows[0].archived === true) {
      return res.json({ success: true, message: 'Contact already archived', already_archived: true });
    }

    return res.status(404).json({ error: 'Contact not found or already archived' });
  } catch (e) {
    console.error('[Delete Error]', e);
    res.status(500).json({ error: 'Failed to archive contact' });
  }
});

// ---------------------------------------------------------------------------
// Catch-all
// ---------------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const port = process.env.PORT || 3000;

async function start() {
  try {
    await ensureSchema(pool);
    console.log(`[${APP_NAME}] Schema ready`);
  } catch (e) {
    console.error(`[${APP_NAME}] Schema migration failed:`, e.message);
    process.exit(1);
  }

  app.listen(port, () => {
    console.log(`[${APP_NAME}] Running on port ${port}`);
    console.log(`[${APP_NAME}] Fuzzy thresholds: exact=${FUZZY_EXACT} possible=${FUZZY_POSSIBLE}`);
    if (API_KEY) console.log(`[${APP_NAME}] API key auth enabled`);
  });
}

start();
