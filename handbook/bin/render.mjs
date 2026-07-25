#!/usr/bin/env node
/**
 * render — a fixed, small markdown subset → Confluence storage format (XML).
 *
 * Contract (see docs/design.md §7):
 *
 *   - FAIL CLOSED. Every construct outside the documented subset throws a
 *     RenderError naming the 1-based source line. Nothing is ever silently
 *     dropped: a construct is either mapped, or it stops the page.
 *   - The output is hashed by docs-sync, so it must be byte-stable for equal
 *     input: no dates, no shas, no macro ids, no random ordering.
 *   - Storage is XML, not HTML: every text node and attribute goes through
 *     escapeXml, only numeric character references are ever emitted beyond the
 *     XML predefined five, void elements are self-closed.
 *
 * Library first (docs-sync.mjs and lint.mjs import it); the CLI form
 * `node render.mjs <file.md>` is an eyeballing aid only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bump when the emitted storage changes for identical markdown (state logs it). */
export const RENDER_VERSION = 1;

/** Fallback for config.render.codeLanguages so the renderer stands alone. */
export const DEFAULT_CODE_LANGUAGES = [
  'bash', 'css', 'html', 'java', 'javascript', 'json', 'kotlin', 'python', 'ruby',
  'sql', 'typescript', 'xml', 'yaml', 'go', 'rust', 'php', 'c', 'cpp', 'csharp',
  'swift', 'text',
];

// GitHub alert keyword → Confluence macro name.
const CALLOUTS = {
  NOTE: 'info',
  INFO: 'info',
  TIP: 'tip',
  IMPORTANT: 'note',
  WARNING: 'warning',
  CAUTION: 'warning',
};

// Confluence status lozenge colours — exact, capitalized, no synonyms.
const STATUS_COLOURS = ['Grey', 'Red', 'Yellow', 'Green', 'Blue'];

// The XML predefined entities; every other named entity is refused on input.
const XML_ENTITIES = ['amp', 'lt', 'gt', 'quot', 'apos'];

const RETIRED_NOTICE = 'This page is no longer maintained and may be out of date.';

const TOC_MACRO =
  '<ac:structured-macro ac:name="toc" ac:schema-version="1">' +
  '<ac:parameter ac:name="type">list</ac:parameter>' +
  '<ac:parameter ac:name="minLevel">2</ac:parameter>' +
  '<ac:parameter ac:name="maxLevel">3</ac:parameter>' +
  '<ac:parameter ac:name="printable">true</ac:parameter>' +
  '</ac:structured-macro>';

export class RenderError extends Error {
  constructor(line, construct, detail) {
    super(line == null ? `${detail} (${construct})` : `line ${line}: ${detail} (${construct})`);
    this.name = 'RenderError';
    this.line = line ?? null;
    this.construct = construct;
  }
}

const fail = (line, construct, detail) => {
  throw new RenderError(line, construct, detail);
};

// ---------------------------------------------------------------------------
// escaping / low-level emitters
// ---------------------------------------------------------------------------

/**
 * The one escape for every text node and attribute value. C0 controls other
 * than tab/newline/return cannot be represented in XML 1.0 at all (not even as
 * numeric refs) and are removed; everything else is preserved verbatim as
 * UTF-8, so no named entity beyond the predefined five is ever emitted.
 */
export function escapeXml(text, { attr = false } = {}) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (attr && ch === '"') out += '&quot;';
    else if (attr && ch === "'") out += '&#39;';
    else if (attr && (ch === '\n' || ch === '\r' || ch === '\t')) out += `&#${code};`;
    else if (code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t') continue;
    else if (code === 0x7f) continue;
    else out += ch;
  }
  return out;
}

const attrEsc = (value) => escapeXml(value, { attr: true });

/** CDATA with the only sequence that can close it split across two sections. */
function cdata(text) {
  const clean = String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return `<![CDATA[${clean.split(']]>').join(']]]]><![CDATA[>')}]]>`;
}

const macroOpen = (name) => `<ac:structured-macro ac:name="${name}" ac:schema-version="1">`;

const param = (name, value) =>
  `<ac:parameter ac:name="${name}">${escapeXml(value)}</ac:parameter>`;

function richMacro(name, params, bodyXml) {
  const body = bodyXml ? `<ac:rich-text-body>\n${bodyXml}\n</ac:rich-text-body>` : '<ac:rich-text-body></ac:rich-text-body>';
  return `${macroOpen(name)}${params.join('')}${body}</ac:structured-macro>`;
}

const statusMacro = (colour, title) =>
  `${macroOpen('status')}${param('colour', colour)}${param('title', title)}</ac:structured-macro>`;

function codeMacro(language, text) {
  const params = language ? param('language', language) : '';
  return `${macroOpen('code')}${params}<ac:plain-text-body>${cdata(text)}</ac:plain-text-body></ac:structured-macro>`;
}

function pageLink(title, anchor, bodyText) {
  const open = anchor ? `<ac:link ac:anchor="${attrEsc(anchor)}">` : '<ac:link>';
  return `${open}<ri:page ri:content-title="${attrEsc(title)}" />` +
    `<ac:plain-text-link-body>${cdata(bodyText)}</ac:plain-text-link-body></ac:link>`;
}

// ---------------------------------------------------------------------------
// block parser — line based, no regex "engine" that can swallow input
// ---------------------------------------------------------------------------

const leadingSpaces = (text) => text.length - text.replace(/^[ ]+/, '').length;

const rtrim = (text) => text.replace(/\s+$/, '');

function toLines(body, offset) {
  return String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((text, i) => ({ text, n: i + 1 + offset }));
}

/** `- x` / `* x` / `+ x` / `1. x` — returns null for anything else. */
function matchItem(text) {
  const m = text.match(/^([-*+]|\d{1,9}\.)([ \t]+)(.*)$/);
  if (!m) return null;
  return { ordered: /\d/.test(m[1]), markerLen: m[1].length + m[2].length, text: m[3] };
}

/** Split one GFM table row on unescaped pipes, dropping the outer empties. */
function splitRow(text) {
  const trimmed = text.trim();
  const cells = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && i + 1 < trimmed.length) {
      cur += ch + trimmed[i + 1];
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && cells.length) cells.pop();
  return cells;
}

function isAlignRow(text) {
  if (!text.includes('|') && !text.includes('-')) return false;
  const cells = splitRow(text);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

const alignOf = (cell) => {
  const c = cell.trim();
  if (c.startsWith(':') && c.endsWith(':')) return 'center';
  if (c.endsWith(':')) return 'right';
  return null;
};

/** True when line j opens a new block (used to terminate paragraphs). */
function startsBlock(lines, j) {
  const text = lines[j].text;
  const body = rtrim(text.slice(leadingSpaces(text)));
  if (!body) return true;
  if (body.startsWith('```') || body.startsWith('~~~')) return true;
  if (body.startsWith('<!--') || /^<[/!]?[A-Za-z]/.test(body)) return true;
  if (/^#{1,6}\s/.test(body) || /^#{7,}/.test(body)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(body)) return true;
  if (body.startsWith('>') || body.startsWith(':::')) return true;
  if (matchItem(body)) return true;
  if (body.includes('|') && j + 1 < lines.length && isAlignRow(lines[j + 1].text)) return true;
  return false;
}

/**
 * lines → block nodes. Recurses for every container (list item, blockquote,
 * callout, expand) after dedenting/unprefixing its content, so nesting costs
 * nothing extra and line numbers survive.
 */
function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.text.trim()) {
      i += 1;
      continue;
    }
    const indent = leadingSpaces(line.text);
    const raw = line.text.slice(indent);
    const body = rtrim(raw);
    const n = line.n;

    if (body.startsWith('~~~')) {
      fail(n, 'code-fence', 'only ``` code fences are supported');
    }
    if (body.startsWith('```')) {
      const [node, next] = takeFence(lines, i, indent);
      blocks.push(node);
      i = next;
      continue;
    }
    if (/^<!--\s*children\s*-->$/.test(body)) {
      blocks.push({ type: 'children', line: n });
      i += 1;
      continue;
    }
    if (body.startsWith('<!--')) {
      fail(n, 'html-comment', 'HTML comments are not supported — only the "<!-- children -->" index marker');
    }
    if (/^<[/!]?[A-Za-z]/.test(body)) {
      fail(n, 'raw-html', 'raw HTML is not supported — use the documented markdown subset');
    }
    if (/^#{7,}/.test(body)) {
      fail(n, 'heading', 'headings deeper than ###### do not exist');
    }
    const heading = body.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      if (level === 1) {
        fail(n, 'h1', "markdown H1 is not allowed — the frontmatter title is the page heading, don't repeat the title");
      }
      const text = heading[2].replace(/\s+#+\s*$/, '').trim();
      blocks.push({ type: 'heading', level, text, line: n });
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(body)) {
      blocks.push({ type: 'hr', line: n });
      i += 1;
      continue;
    }
    if (body.startsWith('>')) {
      const [node, next] = takeQuote(lines, i);
      blocks.push(node);
      i = next;
      continue;
    }
    if (body.startsWith(':::')) {
      const [node, next] = takeExpand(lines, i, indent);
      blocks.push(node);
      i = next;
      continue;
    }
    if (matchItem(body)) {
      const [node, next] = takeList(lines, i);
      blocks.push(node);
      i = next;
      continue;
    }
    if (/^\[\^[^\]]*\]:/.test(body)) {
      fail(n, 'footnote', 'footnotes are not supported');
    }
    if (/^\[[^\]^]+\]:\s*\S/.test(body)) {
      fail(n, 'reference-link', 'reference-style link definitions are not supported — use [text](target)');
    }
    if (body.includes('|') && i + 1 < lines.length && isAlignRow(lines[i + 1].text)) {
      const [node, next] = takeTable(lines, i);
      blocks.push(node);
      i = next;
      continue;
    }
    if (indent >= 4) {
      fail(n, 'indented-code', 'indented code blocks are not supported — use a ``` fence');
    }
    const [node, next] = takeParagraph(lines, i);
    blocks.push(node);
    i = next;
  }
  return blocks;
}

function takeParagraph(lines, i) {
  const collected = [lines[i]];
  let j = i + 1;
  while (j < lines.length) {
    const text = lines[j].text;
    if (!text.trim()) break;
    const body = rtrim(text.slice(leadingSpaces(text)));
    // A rule directly under paragraph text is a setext heading, not an <hr>.
    if (/^={2,}$/.test(body) || /^-{2,}$/.test(body)) {
      fail(lines[j].n, 'setext-heading', 'setext headings are not supported — use "## Heading"');
    }
    if (/^:\s+\S/.test(body)) {
      fail(lines[j].n, 'definition-list', 'definition lists are not supported');
    }
    if (startsBlock(lines, j)) break;
    collected.push(lines[j]);
    j += 1;
  }
  return [{ type: 'para', line: lines[i].n, lines: collected }, j];
}

function takeFence(lines, i, indent) {
  const open = rtrim(lines[i].text.slice(indent));
  const info = open.slice(3).trim();
  const language = info ? info.split(/\s+/)[0] : '';
  const content = [];
  let j = i + 1;
  while (j < lines.length) {
    const body = rtrim(lines[j].text.slice(leadingSpaces(lines[j].text)));
    if (/^```+$/.test(body)) {
      return [{ type: 'code', language, content, line: lines[i].n }, j + 1];
    }
    const text = lines[j].text;
    content.push(text.slice(Math.min(indent, leadingSpaces(text))));
    j += 1;
  }
  return fail(lines[i].n, 'code-fence', 'unclosed ``` code fence');
}

function takeQuote(lines, i) {
  const inner = [];
  let j = i;
  while (j < lines.length) {
    const text = lines[j].text;
    const body = text.slice(leadingSpaces(text));
    if (!body.startsWith('>')) break;
    let rest = body.slice(1);
    if (rest.startsWith(' ')) rest = rest.slice(1);
    if (rest.trimStart().startsWith('>')) {
      fail(lines[j].n, 'nested-blockquote', 'nested blockquotes are not supported');
    }
    inner.push({ text: rest, n: lines[j].n });
    j += 1;
  }
  const alert = rtrim(inner[0].text).match(/^\[!([A-Za-z]+)\]\s*(.*)$/);
  if (alert) {
    const name = alert[1].toUpperCase();
    if (!CALLOUTS[name]) {
      fail(inner[0].n, 'callout', `unknown callout "[!${alert[1]}]" — one of ${Object.keys(CALLOUTS).join('|')}`);
    }
    return [
      {
        type: 'callout',
        macro: CALLOUTS[name],
        title: alert[2].trim(),
        blocks: parseBlocks(inner.slice(1)),
        line: inner[0].n,
      },
      j,
    ];
  }
  return [{ type: 'quote', blocks: parseBlocks(inner), line: lines[i].n }, j];
}

function takeExpand(lines, i, indent) {
  const open = rtrim(lines[i].text.slice(indent));
  const match = open.match(/^:::expand(?:\s+(.*))?$/);
  if (!match) {
    fail(lines[i].n, 'fenced-block', `"${open}" is not supported — only ":::expand [title]" ... ":::"`);
  }
  const inner = [];
  let depth = 1;
  let j = i + 1;
  while (j < lines.length) {
    const text = lines[j].text;
    const body = rtrim(text.slice(leadingSpaces(text)));
    if (/^:::expand(\s|$)/.test(body)) depth += 1;
    else if (body === ':::') {
      depth -= 1;
      if (depth === 0) {
        return [
          {
            type: 'expand',
            title: (match[1] ?? '').trim(),
            blocks: parseBlocks(inner),
            line: lines[i].n,
          },
          j + 1,
        ];
      }
    }
    inner.push({ text: text.slice(Math.min(indent, leadingSpaces(text))), n: lines[j].n });
    j += 1;
  }
  return fail(lines[i].n, 'expand', 'unclosed ":::expand" block');
}

function takeList(lines, i) {
  const startIndent = leadingSpaces(lines[i].text);
  const first = matchItem(lines[i].text.slice(startIndent));
  const ordered = first.ordered;
  const items = [];
  let j = i;
  while (j < lines.length) {
    const text = lines[j].text;
    if (!text.trim()) {
      // A blank line only continues the list when what follows still belongs
      // to it; the blank itself is kept so nested blocks stay separated.
      let k = j;
      while (k < lines.length && !lines[k].text.trim()) k += 1;
      if (k >= lines.length) break;
      const ind = leadingSpaces(lines[k].text);
      const item = matchItem(lines[k].text.slice(ind));
      const continues = ind > startIndent || (ind === startIndent && item && item.ordered === ordered);
      if (!continues) break;
      if (items.length) items[items.length - 1].lines.push({ text: '', n: lines[j].n });
      j = k;
      continue;
    }
    const ind = leadingSpaces(text);
    if (ind < startIndent) break;
    const item = ind === startIndent ? matchItem(text.slice(ind)) : null;
    if (ind === startIndent && !item) break;
    if (item) {
      if (item.ordered !== ordered) break;
      items.push({
        line: lines[j].n,
        contentCol: startIndent + item.markerLen,
        lines: [{ text: item.text, n: lines[j].n }],
      });
      j += 1;
      continue;
    }
    if (!items.length) break;
    const current = items[items.length - 1];
    current.lines.push({ text: text.slice(Math.min(ind, current.contentCol)), n: lines[j].n });
    j += 1;
  }
  return [{ type: 'list', ordered, items, line: lines[i].n }, j];
}

function takeTable(lines, i) {
  const header = splitRow(lines[i].text);
  const aligns = splitRow(lines[i + 1].text).map(alignOf);
  if (aligns.length !== header.length) {
    fail(lines[i + 1].n, 'table', `alignment row has ${aligns.length} cells, the header has ${header.length}`);
  }
  const rows = [];
  let j = i + 2;
  while (j < lines.length) {
    const text = lines[j].text;
    if (!text.trim() || !text.includes('|')) break;
    const cells = splitRow(text);
    if (cells.length > header.length) {
      fail(lines[j].n, 'table', `row has ${cells.length} cells, the header has ${header.length} — cells would be dropped`);
    }
    while (cells.length < header.length) cells.push('');
    rows.push({ cells, n: lines[j].n });
    j += 1;
  }
  return [{ type: 'table', header, aligns, rows, headerLine: lines[i].n, line: lines[i].n }, j];
}

// ---------------------------------------------------------------------------
// inline tokenizer
// ---------------------------------------------------------------------------

/** `` `code` `` — a run of N backticks closed by a run of exactly N. */
function readCode(text, i) {
  let run = 0;
  while (text[i + run] === '`') run += 1;
  let j = i + run;
  while (j < text.length) {
    if (text[j] !== '`') {
      j += 1;
      continue;
    }
    let close = 0;
    while (text[j + close] === '`') close += 1;
    if (close === run) {
      let content = text.slice(i + run, j);
      if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim()) {
        content = content.slice(1, -1);
      }
      return { xml: `<code>${escapeXml(content)}</code>`, end: j + run };
    }
    j += close;
  }
  return null;
}

/** `[text](target)` — returns the two halves, or null when it is not a link. */
function readLink(text, i, n) {
  let depth = 0;
  let j = i;
  let close = -1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '`') {
      const code = readCode(text, j);
      j = code ? code.end : j + 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        close = j;
        break;
      }
    }
    j += 1;
  }
  if (close === -1) return null;
  if (text[close + 1] === '[') {
    fail(n, 'reference-link', 'reference-style links are not supported — use [text](target)');
  }
  if (text[close + 1] !== '(') return null;
  let paren = 0;
  let k = close + 1;
  let end = -1;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '\\') {
      k += 2;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')') {
      paren -= 1;
      if (paren === 0) {
        end = k;
        break;
      }
    }
    k += 1;
  }
  if (end === -1) return null;
  return { text: text.slice(i + 1, close), target: text.slice(close + 2, end), end: end + 1 };
}

function readEmphasis(text, i, n, rc) {
  const ch = text[i];
  let run = 0;
  while (text[i + run] === ch) run += 1;
  const len = ch === '~' ? 2 : Math.min(run, 2);
  if (ch === '~' && run < 2) return null;
  // `_` never opens inside a word (identifiers survive as plain text).
  if (ch === '_' && i > 0 && /\w/.test(text[i - 1])) return null;
  const openEnd = i + len;
  if (openEnd >= text.length || /\s/.test(text[openEnd])) return null;
  const marker = ch.repeat(len);
  let j = openEnd;
  while (j < text.length) {
    if (text[j] === '\\') {
      j += 2;
      continue;
    }
    if (text[j] === '`') {
      const code = readCode(text, j);
      j = code ? code.end : j + 1;
      continue;
    }
    if (text.startsWith(marker, j) && !/\s/.test(text[j - 1])) {
      if (ch === '_' && /\w/.test(text[j + len] ?? ' ')) {
        j += 1;
        continue;
      }
      const inner = renderInline(text.slice(openEnd, j), n, rc);
      const xml =
        ch === '~'
          ? `<span style="text-decoration: line-through;">${inner}</span>`
          : len === 2
            ? `<strong>${inner}</strong>`
            : `<em>${inner}</em>`;
      return { xml, end: j + len };
    }
    j += 1;
  }
  return null;
}

function renderTarget(link, n, rc) {
  const target = link.target.trim();
  if (/^(https?:\/\/|mailto:)/i.test(target)) {
    return `<a href="${attrEsc(target)}">${renderInline(link.text, n, rc)}</a>`;
  }
  const cross = target.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\.md(?:#(.*))?$/);
  if (cross) {
    const slug = cross[1];
    const title = rc.resolveTitle(slug);
    if (!title) {
      fail(n, 'cross-link', `no page file for cross-link target "${slug}.md"`);
    }
    return pageLink(title, cross[2] ? cross[2].trim() : null, link.text);
  }
  if (!target) {
    fail(n, 'link', 'empty link target');
  }
  return fail(
    n,
    'link',
    `unsupported link target "${target}" — use https://…, http://…, mailto:… or <slug>.md[#Anchor]`
  );
}

function renderImage(link, n) {
  const target = link.target.trim();
  if (!/^https?:\/\//i.test(target)) {
    fail(n, 'image', `local image "${target}" — attachments are not supported in 0.1.0, use an https:// URL`);
  }
  return `<ac:image ac:alt="${attrEsc(link.text)}"><ri:url ri:value="${attrEsc(target)}" /></ac:image>`;
}

/** One physical line of markdown → storage inline XML. */
function renderInline(text, n, rc) {
  let out = '';
  let buf = '';
  const flush = () => {
    if (buf) {
      out += escapeXml(buf);
      buf = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\' && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const code = readCode(text, i);
      if (code) {
        flush();
        out += code.xml;
        i = code.end;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === '&') {
      const entity = text.slice(i).match(/^&(#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/);
      if (entity) {
        const name = entity[1];
        if (!name.startsWith('#') && !XML_ENTITIES.includes(name)) {
          fail(n, 'entity', `HTML entity "&${name};" is not supported — write the character itself or a numeric reference`);
        }
        flush();
        out += entity[0];
        i += entity[0].length;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === '<') {
      const rest = text.slice(i);
      if (/^<[A-Za-z][A-Za-z0-9+.-]*:[^>\s]*>/.test(rest) || /^<[^\s@<>]+@[^\s@<>]+>/.test(rest)) {
        fail(n, 'autolink', 'autolinks are not supported — use [text](https://…)');
      }
      if (/^<!--/.test(rest)) {
        fail(n, 'html-comment', 'HTML comments are not supported — the "<!-- children -->" marker must be alone on its line');
      }
      if (/^<\/?[A-Za-z][A-Za-z0-9-]*(\s[^>]*)?\/?>/.test(rest)) {
        fail(n, 'raw-html', 'raw HTML is not supported — use the documented markdown subset');
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === '!' && text[i + 1] === '[') {
      const link = readLink(text, i + 1, n);
      if (link) {
        flush();
        out += renderImage(link, n);
        i = link.end;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === '[') {
      if (text.startsWith('[[status:', i)) {
        const status = text.slice(i).match(/^\[\[status:([^|\]]*)\|([^\]]*)\]\]/);
        if (!status) {
          fail(n, 'status', 'malformed status lozenge — write [[status:Colour|Text]]');
        }
        if (!STATUS_COLOURS.includes(status[1])) {
          fail(n, 'status', `unknown status colour "${status[1]}" — one of ${STATUS_COLOURS.join('|')} (exact capitalization)`);
        }
        flush();
        out += statusMacro(status[1], status[2].trim());
        i += status[0].length;
        continue;
      }
      if (text[i + 1] === '^') {
        fail(n, 'footnote', 'footnotes are not supported');
      }
      const link = readLink(text, i, n);
      if (link) {
        flush();
        out += renderTarget(link, n, rc);
        i = link.end;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === '*' || ch === '_' || (ch === '~' && text[i + 1] === '~')) {
      const emphasis = readEmphasis(text, i, n, rc);
      if (emphasis) {
        flush();
        out += emphasis.xml;
        i = emphasis.end;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Paragraph-ish run of lines; two trailing spaces are the hard line break. */
function inlineLines(lines, rc) {
  let out = '';
  lines.forEach((line, k) => {
    out += renderInline(rtrim(line.text), line.n, rc);
    if (k < lines.length - 1) out += / {2,}$/.test(line.text) ? '<br />\n' : '\n';
  });
  return out;
}

// ---------------------------------------------------------------------------
// block renderer
// ---------------------------------------------------------------------------

function renderBlocks(blocks, rc) {
  return blocks.map((block) => renderBlock(block, rc)).filter(Boolean).join('\n');
}

function renderBlock(block, rc) {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${renderInline(block.text, block.line, rc)}</h${block.level}>`;
    case 'para':
      return `<p>${inlineLines(block.lines, rc)}</p>`;
    case 'hr':
      return '<hr />';
    case 'code': {
      const language = block.language.toLowerCase();
      return codeMacro(rc.codeLanguages.has(language) ? language : '', block.content.join('\n'));
    }
    case 'quote':
      return `<blockquote>${renderBlocks(block.blocks, rc)}</blockquote>`;
    case 'callout':
      return richMacro(
        block.macro,
        block.title ? [param('title', block.title)] : [],
        renderBlocks(block.blocks, rc)
      );
    case 'expand':
      return richMacro(
        'expand',
        block.title ? [param('title', block.title)] : [],
        renderBlocks(block.blocks, rc)
      );
    case 'list':
      return renderList(block, rc);
    case 'table':
      return renderTable(block, rc);
    case 'children':
      return fail(block.line, 'children-marker', 'the "<!-- children -->" marker must be a top-level block');
    default:
      return fail(block.line, 'internal', `unhandled block type "${block.type}"`);
  }
}

const TASK_MARK = /^\[([ xX])\]\s+(.*)$/;

function renderList(block, rc) {
  const tasks = block.items.map((item) => rtrim(item.lines[0].text).match(TASK_MARK));
  const taskCount = tasks.filter(Boolean).length;
  if (taskCount && taskCount !== block.items.length) {
    const offender = block.items[tasks.findIndex((t) => !t)];
    fail(offender.line, 'task-list', 'a task list cannot mix "- [ ]" items with plain list items');
  }
  if (taskCount) {
    const items = block.items.map((item, k) => {
      const inner = { ...item, lines: [{ text: tasks[k][2], n: item.lines[0].n }, ...item.lines.slice(1)] };
      return `<ac:task><ac:task-status>${tasks[k][1] === ' ' ? 'incomplete' : 'complete'}</ac:task-status>` +
        `<ac:task-body>${renderItemBody(inner, rc)}</ac:task-body></ac:task>`;
    });
    return `<ac:task-list>\n${items.join('\n')}\n</ac:task-list>`;
  }
  const tag = block.ordered ? 'ol' : 'ul';
  const items = block.items.map((item) => `<li>${renderItemBody(item, rc)}</li>`);
  return `<${tag}>\n${items.join('\n')}\n</${tag}>`;
}

/** An item's own text stays unwrapped; nested blocks (incl. child lists) follow it. */
function renderItemBody(item, rc) {
  const blocks = parseBlocks(item.lines);
  if (!blocks.length) return '';
  if (blocks[0].type === 'para') {
    const lead = inlineLines(blocks[0].lines, rc);
    const rest = renderBlocks(blocks.slice(1), rc);
    return rest ? `${lead}\n${rest}` : lead;
  }
  return renderBlocks(blocks, rc);
}

function renderTable(block, rc) {
  const head = block.header
    .map((cell) => `<th>${renderInline(cell.trim(), block.headerLine, rc)}</th>`)
    .join('');
  const rows = block.rows.map((row) => {
    const cells = row.cells.map((cell, k) => {
      const align = block.aligns[k];
      const open = align ? `<td style="text-align: ${align};">` : '<td>';
      return `${open}${renderInline(cell.trim(), row.n, rc)}</td>`;
    });
    return `<tr>${cells.join('')}</tr>`;
  });
  return `<table><tbody>\n<tr>${head}</tr>${rows.length ? `\n${rows.join('\n')}` : ''}\n</tbody></table>`;
}

// ---------------------------------------------------------------------------
// furniture
// ---------------------------------------------------------------------------

function bannerMacro(slug, fields, config) {
  let xml = escapeXml(
    `Maintained from code — edits made here are overwritten by the next sync. Source: confluence/pages/${slug}.md`
  );
  const owner = typeof fields.owner === 'string' ? fields.owner.trim() : '';
  if (owner) xml += ` · Owner: ${escapeXml(owner)}`;
  const repoUrl = typeof config.repoUrl === 'string' ? config.repoUrl.trim() : '';
  if (/^https?:\/\//i.test(repoUrl)) xml += ` · <a href="${attrEsc(repoUrl)}">Repository</a>`;
  else if (repoUrl) xml += ` · Repository: ${escapeXml(repoUrl)}`;
  return richMacro('info', [], `<p>${xml}</p>`);
}

function tocWanted(mode, h2Count) {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return h2Count >= 3;
}

function childTable(children) {
  if (!children.length) return '';
  const rows = children.map((child) => {
    const title = String(child.title || child.slug || '');
    const summary = child.firstParagraph ? escapeXml(String(child.firstParagraph)) : '';
    const kind = child.kindLabel ? statusMacro('Blue', String(child.kindLabel)) : '';
    return `<tr><td>${pageLink(title, null, title)}</td><td>${summary}</td><td>${kind}</td></tr>`;
  });
  return `<table><tbody>\n<tr><th>Page</th><th>Summary</th><th>Kind</th></tr>\n${rows.join('\n')}\n</tbody></table>`;
}

/**
 * Push/pop over every emitted tag. This is a self-check on the renderer, not on
 * the input: unbalanced output means a bug here, and Confluence would reject
 * (or silently mangle) the page — so we refuse to hand it back.
 */
function checkBalance(xml) {
  const stack = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      if (end === -1) fail(null, 'tag-balance', 'internal renderer error: unterminated CDATA section');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      if (end === -1) fail(null, 'tag-balance', 'internal renderer error: unterminated comment');
      i = end + 3;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt === -1) fail(null, 'tag-balance', 'internal renderer error: unterminated tag');
    const tag = xml.slice(lt + 1, gt);
    const name = tag.replace(/^\//, '').split(/[\s/]/)[0];
    if (tag.startsWith('/')) {
      const open = stack.pop();
      if (open !== name) {
        fail(null, 'tag-balance', `internal renderer error: </${name}> closes <${open ?? 'nothing'}>`);
      }
    } else if (!tag.endsWith('/')) {
      stack.push(name);
    }
    i = gt + 1;
  }
  if (stack.length) {
    fail(null, 'tag-balance', `internal renderer error: unclosed <${stack[stack.length - 1]}>`);
  }
}

// ---------------------------------------------------------------------------
// public entry points
// ---------------------------------------------------------------------------

/**
 * page = { slug, fields, publishBody[, bodyLineOffset] }
 * ctx  = { config, kind, resolveTitle(slug) → title|null, children[, retired] }
 *
 * `children` is supplied for index kinds only and decides both the trailing
 * index table and whether "<!-- children -->" is legal. `bodyLineOffset` (when
 * the caller knows where publishBody starts in the file) shifts RenderError
 * lines into whole-file coordinates; without it they are relative to
 * publishBody. `ctx.retired` prepends the retirement warning panel.
 */
export function renderStorage(page, ctx = {}) {
  const fields = page?.fields ?? {};
  const config = ctx.config ?? {};
  const renderCfg = config.render ?? {};
  const kindKey = typeof fields.kind === 'string' ? fields.kind : '';
  const rc = {
    resolveTitle: typeof ctx.resolveTitle === 'function' ? ctx.resolveTitle : () => null,
    codeLanguages: new Set(
      (Array.isArray(renderCfg.codeLanguages) ? renderCfg.codeLanguages : DEFAULT_CODE_LANGUAGES)
        .map((l) => String(l).toLowerCase())
    ),
  };
  const isIndex = Array.isArray(ctx.children) || kindKey === 'index' || ctx.kind?.label === 'index';

  const blocks = parseBlocks(toLines(page?.publishBody, Number(page?.bodyLineOffset) || 0));

  let markerAt = -1;
  blocks.forEach((block, k) => {
    if (block.type !== 'children') return;
    if (!isIndex) {
      fail(block.line, 'children-marker', 'the "<!-- children -->" marker only belongs on an index page');
    }
    if (markerAt !== -1) {
      fail(block.line, 'children-marker', 'only one "<!-- children -->" marker per page');
    }
    markerAt = k;
  });

  const parts = [];
  if (renderCfg.banner !== false) parts.push(bannerMacro(page?.slug ?? '', fields, config));
  const h2Count = blocks.filter((b) => b.type === 'heading' && b.level === 2).length;
  if (tocWanted(renderCfg.toc ?? 'auto', h2Count)) parts.push(TOC_MACRO);
  if (ctx.retired === true) {
    parts.push(richMacro('warning', [], `<p>${escapeXml(RETIRED_NOTICE)}</p>`));
  }

  const table = isIndex ? childTable(Array.isArray(ctx.children) ? ctx.children : []) : '';
  if (markerAt === -1) {
    parts.push(renderBlocks(blocks, rc));
    if (table) parts.push(table);
  } else {
    parts.push(renderBlocks(blocks.slice(0, markerAt), rc));
    if (table) parts.push(table);
    parts.push(renderBlocks(blocks.slice(markerAt + 1), rc));
  }

  const xml = parts.filter(Boolean).join('\n');
  checkBalance(xml);
  return xml;
}

const PLAIN_TEXT_STRIPPERS = [
  [/!\[[^\]]*\]\([^)]*\)/g, ''],
  [/\[\[status:[^|\]]*\|([^\]]*)\]\]/g, '$1'],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/`+/g, ''],
  [/\*\*|~~|\*/g, ''],
  [/(^|\W)_([^_]+)_(?=\W|$)/g, '$1$2'],
  [/\s+/g, ' '],
];

/**
 * The page's summary sentence: the first block, but only when that block is a
 * plain paragraph. Plain text (inline markup stripped) — it feeds an index
 * table cell and lint's 20–60-word warning. Never throws.
 */
export function firstParagraph(publishBody) {
  const lines = toLines(publishBody, 0);
  let i = 0;
  while (i < lines.length && !lines[i].text.trim()) i += 1;
  if (i >= lines.length) return null;
  if (startsBlock(lines, i)) return null;
  const collected = [];
  for (let j = i; j < lines.length; j += 1) {
    if (!lines[j].text.trim()) break;
    if (j > i && startsBlock(lines, j)) break;
    collected.push(lines[j].text.trim());
  }
  let text = collected.join(' ');
  for (const [pattern, replacement] of PLAIN_TEXT_STRIPPERS) text = text.replace(pattern, replacement);
  text = text.trim();
  return text || null;
}

// ---------------------------------------------------------------------------
// CLI — eyeballing aid only (`node render.mjs <file.md>`)
// ---------------------------------------------------------------------------

const warn = (msg) => process.stderr.write(`${new Date().toISOString()} [handbook] WARN ${msg}\n`);

/** Minimal frontmatter split (on the second `---`) — docs-sync owns the real parser. */
function splitFrontmatter(raw) {
  const fields = {};
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return { fields, body: raw, offset: 0 };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { fields, body: raw, offset: 0 };
  for (const line of lines.slice(1, end)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }
  return { fields, body: lines.slice(end + 1).join('\n'), offset: end + 1 };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    warn('usage: render.mjs <file.md>');
    process.exit(2);
  }
  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  const { fields, body, offset } = splitFrontmatter(raw);
  const publishBody = rtrim(body.split(/^## (?:Editorial|Rework)\s*$/m)[0]);
  const slug = path.basename(file).replace(/\.md$/, '');
  const kind = fields.kind || 'feature';
  try {
    const xml = renderStorage(
      { slug, fields, publishBody, bodyLineOffset: offset },
      {
        config: {},
        kind: { label: kind },
        // Standalone stub: every slug "resolves" to itself so a page with
        // cross-links can still be eyeballed. docs-sync passes the real map.
        resolveTitle: (target) => target,
        children: kind === 'index' ? [] : undefined,
      }
    );
    process.stdout.write(`${xml}\n`);
  } catch (error) {
    warn(error.message);
    process.exit(1);
  }
}

// Run only as a CLI (the render helpers are imported by docs-sync/lint/tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
