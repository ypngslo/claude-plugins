#!/usr/bin/env node
/**
 * In-memory Jira REST v2 stand-in for testing jira-sync without a real site.
 * Implements exactly the surface the CLI uses. State inspectable at /__state;
 * every mutating call is counted so tests can assert idempotency.
 *
 * Usage: node mock-jira.mjs <port>
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? 8199);
const STATUSES = ['To Do', 'In Progress', 'Testing', 'Done'];

const issues = new Map(); // key → { key, fields: {summary, description, labels, status, parent}, comments: [] }
let sequence = 0;
const counters = { create: 0, update: 0, transition: 0, comment: 0 };

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body === null ? '' : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://x`);
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/__state') return json(res, 200, { issues: [...issues.values()], counters });

    if (!req.headers.authorization?.startsWith('Basic ')) return json(res, 401, { err: 'no auth' });

    // POST /rest/api/2/issue
    if (req.method === 'POST' && url.pathname === '/rest/api/2/issue') {
      const body = await readBody(req);
      sequence += 1;
      const key = `${body.fields.project.key}-${sequence}`;
      issues.set(key, {
        key,
        fields: { ...body.fields, status: 'To Do' },
        comments: [],
      });
      counters.create += 1;
      return json(res, 201, { id: String(sequence), key });
    }

    // /rest/api/2/issue/:key[...]
    if (parts[0] === 'rest' && parts[3] === 'issue' && parts[4]) {
      const key = parts[4];
      const issue = issues.get(key);
      if (!issue) return json(res, 404, { err: `no issue ${key}` });

      if (req.method === 'PUT' && parts.length === 5) {
        const body = await readBody(req);
        Object.assign(issue.fields, body.fields);
        // Additive label ops (update.labels: [{add}/{remove}]) — Jira semantics.
        issue.fields.labels ??= [];
        for (const op of body.update?.labels ?? []) {
          if (op.add && !issue.fields.labels.includes(op.add)) issue.fields.labels.push(op.add);
          if (op.remove) issue.fields.labels = issue.fields.labels.filter((l) => l !== op.remove);
        }
        counters.update += 1;
        return json(res, 204, null);
      }
      if (req.method === 'GET' && parts.length === 5) {
        return json(res, 200, {
          key,
          fields: { summary: issue.fields.summary, status: { name: issue.fields.status } },
        });
      }
      if (parts[5] === 'transitions') {
        if (req.method === 'GET') {
          return json(res, 200, {
            transitions: STATUSES.map((name, index) => ({ id: String(index + 1), to: { name } })),
          });
        }
        const body = await readBody(req);
        issue.fields.status = STATUSES[Number(body.transition.id) - 1];
        counters.transition += 1;
        return json(res, 204, null);
      }
      if (parts[5] === 'comment' && req.method === 'POST') {
        const body = await readBody(req);
        issue.comments.push(body.body);
        counters.comment += 1;
        return json(res, 201, { id: String(issue.comments.length) });
      }
    }

    json(res, 404, { err: `unhandled ${req.method} ${url.pathname}` });
  })
  .listen(port, '127.0.0.1', () => process.stdout.write(`mock-jira on ${port}\n`));
