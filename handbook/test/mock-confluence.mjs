#!/usr/bin/env node
/**
 * In-memory Confluence Cloud stand-in (v2 pages + v1 labels/archive) for testing
 * docs-sync without a real site. Implements exactly the surface the CLI uses and
 * keeps the sharp edges: substring title search, cursor pagination, duplicate-title
 * 400, PUT rejected unless version.number === current + 1, and a /title endpoint
 * that refuses any request carrying a version object.
 *
 * State inspectable at GET /__state (the ONLY auth-free route); every mutating call
 * is counted so tests can assert idempotency. POST /__chaos {status, times,
 * retryAfter} arms the next N responses with a failure — it needs Basic auth like
 * every other route.
 *
 * Usage: node mock-confluence.mjs <port>
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? 8299);
const PAGE_SIZE = 2; // deliberately small: >2 matches forces the client through _links.next

const spaces = new Map(); // key    → { id, key, homepageId }
const pages = new Map(); //  id     → { id, spaceId, status, title, parentId, body, version }
const labels = new Map(); // pageId → [{ prefix, name, id }]
const counters = {
  spaceLookup: 0,
  createPage: 0,
  updatePage: 0,
  titleUpdate: 0,
  deletePage: 0,
  getPage: 0,
  findPage: 0,
  labelAdd: 0,
  labelRemove: 0,
  archive: 0,
};

let pageSeq = 100; // "1" is the seeded space homepage
let chaos = null; // { status, times, retryAfter }

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(body === null ? '' : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });

const CODES = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'TOO_MANY_REQUESTS', 500: 'INTERNAL_SERVER_ERROR' };

// Confluence returns errors as {errors:[{status, code, title, detail}]} — the CLI
// only ever matches on the flattened text, so the envelope has to be there.
const errors = (status, title) => ({ errors: [{ status, code: CODES[status] ?? 'ERROR', title, detail: null }] });

const view = (page, bodyFormat) => {
  const out = {
    id: page.id,
    status: page.status,
    title: page.title,
    spaceId: page.spaceId,
    parentId: page.parentId || null,
    version: { number: page.version.number, message: page.version.message, createdAt: page.version.createdAt },
  };
  if (bodyFormat) out.body = { [bodyFormat]: { representation: bodyFormat, value: page.body } };
  return out;
};

const stamp = (number, message) => ({ number, message: message ?? null, createdAt: new Date().toISOString() });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/__state') {
      return json(res, 200, {
        spaces: [...spaces.values()],
        pages: [...pages.values()],
        labels: Object.fromEntries([...labels].map(([id, list]) => [id, list.map((l) => l.name)])),
        counters,
      });
    }

    if (!req.headers.authorization?.startsWith('Basic ')) return json(res, 401, errors(401, 'no auth'));

    if (req.method === 'POST' && url.pathname === '/__chaos') {
      const body = await readBody(req);
      chaos = {
        status: Number(body.status) || 500,
        times: Number(body.times ?? 1),
        retryAfter: Number(body.retryAfter ?? 0),
      };
      return json(res, 200, { armed: chaos });
    }

    // Chaos only fires on writes: the CLI GETs before every PUT, and an injected
    // failure consumed by that GET could never exercise the PUT retry path.
    if (chaos && chaos.times > 0 && req.method !== 'GET') {
      chaos.times -= 1;
      req.resume(); // the request body is never read on an injected failure
      const headers = chaos.status === 429 ? { 'Retry-After': String(chaos.retryAfter) } : {};
      return json(res, chaos.status, errors(chaos.status, `chaos: injected ${chaos.status}`), headers);
    }

    // GET /wiki/api/v2/spaces?keys=<KEY>&limit=1 — the space is seeded on first lookup.
    if (req.method === 'GET' && url.pathname === '/wiki/api/v2/spaces') {
      counters.spaceLookup += 1;
      const key = url.searchParams.get('keys') ?? '';
      if (!spaces.has(key)) spaces.set(key, { id: '65758', key, homepageId: '1' });
      return json(res, 200, { results: [spaces.get(key)], _links: {} });
    }

    // GET /wiki/api/v2/pages?space-id=&title=&status=&limit= — SUBSTRING title match,
    // so the client must verify exactness itself. `limit` is ignored; PAGE_SIZE rules.
    if (req.method === 'GET' && url.pathname === '/wiki/api/v2/pages') {
      counters.findPage += 1;
      const spaceId = url.searchParams.get('space-id');
      const title = url.searchParams.get('title');
      const status = url.searchParams.get('status') ?? 'current';
      const cursor = url.searchParams.get('cursor');
      const offset = cursor ? Number(Buffer.from(cursor, 'base64').toString('utf8')) || 0 : 0;
      const matched = [...pages.values()].filter(
        (p) => (!spaceId || p.spaceId === String(spaceId)) && p.status === status && (!title || p.title.includes(title)),
      );
      const body = { results: matched.slice(offset, offset + PAGE_SIZE).map((p) => view(p)), _links: {} };
      if (offset + PAGE_SIZE < matched.length) {
        const next = new URLSearchParams(url.searchParams);
        next.set('cursor', Buffer.from(String(offset + PAGE_SIZE)).toString('base64'));
        body._links.next = `/wiki/api/v2/pages?${next}`;
      }
      return json(res, 200, body);
    }

    // POST /wiki/api/v2/pages
    if (req.method === 'POST' && url.pathname === '/wiki/api/v2/pages') {
      const body = await readBody(req);
      const spaceId = String(body.spaceId ?? '');
      const clash = [...pages.values()].find(
        (p) => p.spaceId === spaceId && p.status === 'current' && p.title === body.title,
      );
      if (clash) {
        return json(res, 400, errors(400, `A page already exists with the title '${body.title}' in this space.`));
      }
      pageSeq += 1;
      const id = String(pageSeq);
      pages.set(id, {
        id,
        spaceId,
        status: body.status ?? 'current',
        title: body.title,
        parentId: body.parentId ? String(body.parentId) : '',
        body: body.body?.value ?? '',
        version: stamp(1, body.version?.message),
      });
      labels.set(id, []);
      counters.createPage += 1;
      return json(res, 200, view(pages.get(id)));
    }

    // /wiki/api/v2/pages/{id}[/title|/labels]
    if (parts[0] === 'wiki' && parts[1] === 'api' && parts[2] === 'v2' && parts[3] === 'pages' && parts[4]) {
      const id = parts[4];
      const page = pages.get(id);
      if (!page) return json(res, 404, errors(404, `No page with id ${id} exists, or you lack permission to see it.`));

      if (req.method === 'GET' && parts.length === 5) {
        counters.getPage += 1;
        return json(res, 200, view(page, url.searchParams.get('body-format')));
      }

      if (req.method === 'PUT' && parts.length === 5) {
        const body = await readBody(req);
        const expected = page.version.number + 1;
        if (Number(body.version?.number) !== expected) {
          return json(
            res,
            409,
            errors(409, `Version must be incremented by one — expected ${expected}, got ${body.version?.number ?? 'none'}.`),
          );
        }
        page.title = body.title ?? page.title;
        if (body.parentId !== undefined) page.parentId = body.parentId ? String(body.parentId) : '';
        if (body.body?.value !== undefined) page.body = body.body.value;
        if (body.status) page.status = body.status;
        page.version = stamp(expected, body.version.message);
        counters.updatePage += 1;
        return json(res, 200, view(page));
      }

      // The cheap rename path: carrying a version object here is a client bug.
      if (req.method === 'PUT' && parts[5] === 'title' && parts.length === 6) {
        const body = await readBody(req);
        if (body.version !== undefined) {
          return json(res, 400, errors(400, 'The title update endpoint does not accept a version object.'));
        }
        page.title = body.title ?? page.title;
        page.version = stamp(page.version.number + 1, page.version.message);
        counters.titleUpdate += 1;
        return json(res, 200, view(page));
      }

      if (req.method === 'DELETE' && parts.length === 5) {
        page.status = 'trashed';
        counters.deletePage += 1;
        return json(res, 204, null);
      }

      if (req.method === 'GET' && parts[5] === 'labels' && parts.length === 6) {
        return json(res, 200, { results: labels.get(id) ?? [], _links: {} });
      }
    }

    // POST /wiki/rest/api/content/archive
    if (req.method === 'POST' && url.pathname === '/wiki/rest/api/content/archive') {
      const body = await readBody(req);
      for (const entry of body.pages ?? []) {
        const page = pages.get(String(entry.id));
        if (page) page.status = 'archived';
      }
      counters.archive += 1;
      return json(res, 200, { id: 'archive-task-1', links: { status: '/wiki/rest/api/longtask/archive-task-1' } });
    }

    // /wiki/rest/api/content/{id}/label — v1, additive on POST, one DELETE per name.
    if (parts[0] === 'wiki' && parts[1] === 'rest' && parts[2] === 'api' && parts[3] === 'content' && parts[5] === 'label' && parts.length === 6) {
      const id = parts[4];
      if (!pages.get(id)) return json(res, 404, errors(404, `No content found with id ${id}.`));
      const current = labels.get(id) ?? [];

      if (req.method === 'POST') {
        const body = await readBody(req);
        for (const label of Array.isArray(body) ? body : [body]) {
          if (!label?.name || current.some((c) => c.name === label.name)) continue;
          current.push({ prefix: label.prefix ?? 'global', name: label.name, id: String(current.length + 1) });
        }
        labels.set(id, current);
        counters.labelAdd += 1;
        return json(res, 200, { results: current, size: current.length });
      }

      if (req.method === 'DELETE') {
        const name = url.searchParams.get('name');
        labels.set(
          id,
          current.filter((c) => c.name !== name),
        );
        counters.labelRemove += 1;
        return json(res, 204, null);
      }
    }

    json(res, 404, { err: `unhandled ${req.method} ${url.pathname}` });
  })
  .listen(port, '127.0.0.1', () => process.stdout.write(`mock-confluence on ${port}\n`));
