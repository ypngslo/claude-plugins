#!/usr/bin/env bash
# End-to-end test of docs-sync against the in-memory mock Confluence.
# Sections follow the scenario list in docs/design.md §12, in order: init,
# renderer goldens and refusals, lint and publish-gate refusals, the whole
# create/update/rename/move/label/retire/orphan lifecycle, the chaos and
# drift paths, the circuit breaker, git-derived staleness, and the lock and
# credential contracts.
#
# Secret fixtures are assembled at runtime from fragments: a literal in this
# file would trip the repo's gitleaks gate.
set -euo pipefail

cd "$(dirname "$0")/.."
PLUGIN="$(pwd)"
CLI="$PLUGIN/bin/docs-sync.mjs"
PORT=8299
BASE="http://127.0.0.1:$PORT"
REPO="$(mktemp -d)"
WORK="$(mktemp -d)"
PAGES="$REPO/confluence/pages"
CONFIG="$REPO/confluence/config.json"
SYNC_STATE="$REPO/confluence/.sync-state.json"

export CONFLUENCE_BASE_URL_OVERRIDE="$BASE"
export CONFLUENCE_EMAIL="t@e.st"
export CONFLUENCE_API_TOKEN="tok"

node "$PLUGIN/test/mock-confluence.mjs" "$PORT" & MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true; rm -rf "$REPO" "$WORK"' EXIT
sleep 0.4

# Staleness scenarios need real history, so the fixture repo is a real repo.
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email "t@e.st"
git -C "$REPO" config user.name "Handbook Tester"

fail() { echo "FAIL: $1" >&2; exit 1; }
state() { curl -s "$BASE/__state"; }

# --- mock introspection -------------------------------------------------------
counter() {
  state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const c=JSON.parse(d).counters||{};console.log(String(c[process.argv[1]]??"MISSING"))})' "$1"
}
# Every counter as "k=v k=v …" — equality across a pass proves a true no-op.
all_counters() {
  state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const c=JSON.parse(d).counters||{};console.log(Object.keys(c).sort().map(k=>`${k}=${c[k]}`).join(" "))})'
}
MUTATORS="createPage updatePage titleUpdate deletePage labelAdd labelRemove archive"
mutating_counters() {
  state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const c=JSON.parse(d).counters||{};console.log(process.argv[1].split(" ").map(k=>`${k}=${c[k]}`).join(" "))})' "$MUTATORS"
}
page_field() { # page_field <pageId> <field>
  state | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const s=JSON.parse(d);
  const list=Array.isArray(s.pages)?s.pages:Object.values(s.pages||{});
  const p=list.find((x)=>String(x.id)===process.argv[1]);
  if(!p)return console.log("MISSING");
  const v=process.argv[2]==="parentId"?(p.parentId??p.parent_id??""):p[process.argv[2]];
  console.log(String(v??""));
})' "$1" "$2"
}
labels_of() { # labels_of <pageId> — sorted, comma-joined
  state | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const s=JSON.parse(d), id=process.argv[1];
  const list=Array.isArray(s.pages)?s.pages:Object.values(s.pages||{});
  const p=list.find((x)=>String(x.id)===id)||{};
  const raw=(s.labels&&!Array.isArray(s.labels)?s.labels[id]:null)||p.labels||[];
  console.log(raw.map((x)=>typeof x==="string"?x:(x.name||"")).sort().join(","));
})' "$1"
}
mock_json() { # mock_json <METHOD> <path> <json body>
  curl -s -u "$CONFLUENCE_EMAIL:$CONFLUENCE_API_TOKEN" -X "$1" \
    -H 'Content-Type: application/json' -d "$3" "$BASE$2" >/dev/null
}

# --- local file / state introspection ----------------------------------------
page_id() { # page_id <slug> — pageId as written back into the frontmatter
  node -e 'const fs=require("fs");const m=fs.readFileSync(process.argv[1],"utf8").match(/^pageId:[ \t]*"?([^"\s]*)"?[ \t]*$/m);console.log(m?m[1]:"")' "$PAGES/$1.md"
}
sfield() { # sfield <slug> <field> — from .sync-state.json
  node -e 'const fs=require("fs");const p=process.argv[1];const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};const e=(s.pages||{})[process.argv[2]]||{};console.log(String(e[process.argv[3]]??""))' "$SYNC_STATE" "$1" "$2"
}
orphan_id() { # orphan_id <slug>
  node -e 'const fs=require("fs");const p=process.argv[1];const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};console.log(String(((s.orphans||{})[process.argv[2]]||{}).pageId??""))' "$SYNC_STATE" "$1"
}
setcfg() { # setcfg <dotted.key> <json value>
  node -e '
const fs=require("fs");const p=process.argv[1];
const c=JSON.parse(fs.readFileSync(p,"utf8"));
const keys=process.argv[2].split(".");let o=c;
while(keys.length>1){const k=keys.shift();if(typeof o[k]!=="object"||o[k]===null)o[k]={};o=o[k];}
o[keys[0]]=JSON.parse(process.argv[3]);
fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");' "$CONFIG" "$1" "$2"
}

# --- CLI wrappers -------------------------------------------------------------
hb() { node "$CLI" "$@" --repo "$REPO"; }
hb_out() { hb "$@" 2>&1 || true; }
hb_rc() { RC=0; hb "$@" >/dev/null || RC=$?; }
hb_sync() { hb_rc sync "$@"; [ "$RC" = "0" ] || fail "sync exited $RC unexpectedly"; }

# --- page fixtures ------------------------------------------------------------
# page <slug> <title> <kind> <parent> <sources> <status> <approved> [extra frontmatter…]
# Body arrives on stdin (heredoc). Bodies are deliberately plain, non-technical
# prose: anything else trips the audience lint and blocks the publish gate.
page() {
  local slug="$1" title="$2" kind="$3" parent="$4" sources="$5" status="$6" approved="$7" extra
  shift 7
  {
    printf -- '---\n'
    printf 'title: "%s"\n' "$title"
    printf 'kind: %s\n' "$kind"
    printf 'parent: %s\n' "$parent"
    printf 'sources: [%s]\n' "$sources"
    printf 'status: %s\n' "$status"
    printf 'approved: %s\n' "$approved"
    for extra in "$@"; do printf '%s\n' "$extra"; done
    printf -- '---\n'
    cat
  } >"$PAGES/$slug.md"
}
# simple_page <slug> <title> <status> <approved> [kind] [parent] — lint-clean and
# gate-clean; the workhorse fixture for lifecycle scenarios.
simple_page() {
  page "$1" "$2" "${5:-glossary}" "${6:-}" "" "$3" "$4" <<'EOF'
This page explains one small part of the product in plain words, written for anyone who wants to know what the product promises the people who use it.

## What it means

The team keeps this page short on purpose so that anyone can read it quickly and trust every word of it.

## Editorial

Audience-check: clean — 1 claim verified, reviewer clean
EOF
}

# --- renderer harness ---------------------------------------------------------
# Imports render.mjs directly (an ESM import needs a module file, so the "node -e
# import" of §12 is a tiny module here). Markdown on stdin → storage on stdout;
# a RenderError prints its 1-based line instead.
cat >"$WORK/render-harness.mjs" <<'EOF'
const [pluginDir] = process.argv.slice(2);
const { renderStorage } = await import(`${pluginDir}/bin/render.mjs`);
let md = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) md += chunk;
const ctx = {
  config: {
    repoUrl: process.env.HB_RENDER_REPO_URL ?? '',
    titlePrefix: '',
    render: { toc: 'never', banner: false, codeLanguages: ['bash', 'json', 'python'] },
  },
  kind: { label: 'reference', requireSources: false, allowCodeBlocks: true, requiredSections: [] },
  resolveTitle: (slug) => (slug === 'other-page' ? 'Other Page' : null),
  children: [],
};
const page = { slug: 'demo-page', fields: { title: 'Demo Page', kind: 'reference' }, publishBody: md };
try {
  process.stdout.write(renderStorage(page, ctx));
} catch (error) {
  process.stdout.write(`RENDER_ERROR line=${error.line} construct=${error.construct} message=${error.message}\n`);
  process.exitCode = 3;
}
EOF
rend() { node "$WORK/render-harness.mjs" "$PLUGIN"; }
# render_case → RENDERED (newlines flattened for matching). Markdown comes from
# stdin, or from one argument per line when lines must carry trailing spaces.
render_case() {
  if [ "$#" -gt 0 ]; then
    RENDERED="$({ printf '%s\n' "$@" | rend || echo 'RENDER_HARNESS_FAILED'; } | tr '\n' ' ')"
  else
    RENDERED="$({ rend || echo 'RENDER_HARNESS_FAILED'; } | tr '\n' ' ')"
  fi
  case "$RENDERED" in
    *RENDER_ERROR*|*RENDER_HARNESS_FAILED*) fail "renderer threw on a supported construct: $RENDERED" ;;
  esac
}
has() { case "$RENDERED" in *"$1"*) : ;; *) fail "storage missing: $1" ;; esac; }
hasnt() { case "$RENDERED" in *"$1"*) fail "storage unexpectedly contains: $1" ;; *) : ;; esac; }
hasre() { printf '%s\n' "$RENDERED" | grep -qE "$1" || fail "storage missing pattern: $1"; }
render_refuses() { # render_refuses <label> <expected 1-based line> [message needle]
  local label="$1" line="$2" needle="${3:-}" out
  out="$(rend || true)"
  case "$out" in *RENDER_ERROR*) : ;; *) fail "renderer accepted $label" ;; esac
  case "$out" in *"line=$line"*) : ;; *) fail "$label: RenderError did not name line $line ($out)" ;; esac
  [ -z "$needle" ] && return 0
  case "$out" in *"$needle"*) : ;; *) fail "$label: message missing \"$needle\" ($out)" ;; esac
}
lint_refuses() { # lint_refuses <slug> <what it should have caught>
  hb_rc lint "$1"
  [ "$RC" != "0" ] || fail "lint accepted $2"
}

# =============================================================================
# 1. init scaffolds, and never overwrites
# =============================================================================
hb init >/dev/null
[ -f "$CONFIG" ] || fail "init did not scaffold confluence/config.json"
[ -f "$REPO/confluence/.gitignore" ] || fail "init did not scaffold confluence/.gitignore"
[ -f "$PAGES/_example.md.txt" ] || fail "init did not scaffold the example page"
grep -q '.sync-state.json' "$REPO/confluence/.gitignore" || fail "gitignore does not cover the state file"
printf '{ "site": "mock.invalid", "spaceKey": "HB", "keepMe": true }\n' >"$CONFIG"
hb init >/dev/null
grep -q 'keepMe' "$CONFIG" || fail "init overwrote an existing config.json"

cat >"$CONFIG" <<'EOF'
{
  "site": "mock.invalid",
  "spaceKey": "HB",
  "labels": ["acme", "legacy"],
  "repoUrl": "https://example.invalid/handbook"
}
EOF

# =============================================================================
# 2. renderer goldens
# =============================================================================
render_case <<'EOF'
## Heading two

Plain words with **bold**, *italic*, _more italic_, `code` and ~~struck~~ text.

---

### Heading three

###### Heading six
EOF
has '<h2>Heading two</h2>'
has '<h3>Heading three</h3>'
has '<h6>Heading six</h6>'
has '<strong>bold</strong>'
has '<em>italic</em>'
has '<em>more italic</em>'
has '<code>code</code>'
has '<span style="text-decoration: line-through;">struck</span>'
has '<hr />'
has '<p>'

# Two trailing spaces are the whole point of this one, so it goes through printf.
render_case 'Line one ends with a break  ' 'and line two follows it.'
has '<br />'

render_case <<'EOF'
- Parent item
  1. First child
  2. Second child
- Second parent

1. Ordered top
2. Ordered next
  - Nested bullet
EOF
has '<ul>'
has '<ol>'
has '<li>'
hasre '</ol>[[:space:]]*</li>'
hasre '</ul>[[:space:]]*</li>'

render_case <<'EOF'
- [ ] Write the page in plain words
- [x] Read the part of the product it covers
EOF
has '<ac:task-list>'
has '<ac:task>'
has '<ac:task-status>incomplete</ac:task-status>'
has '<ac:task-status>complete</ac:task-status>'
has '<ac:task-body>'

render_case <<'EOF'
| Word | Meaning | Count |
| --- | :---: | ---: |
| Basket | What a shopper picked | 12 |
EOF
has '<table>'
has '<tbody>'
has '<th>'
has 'Word'
has 'text-align: center;'
has 'text-align: right;'

render_case <<'EOF'
```bash
plain words only
```
EOF
has 'ac:name="code"'
has 'ac:schema-version="1"'
has '<ac:parameter ac:name="language">bash</ac:parameter>'
has '<ac:plain-text-body>'
has '<![CDATA['

render_case <<'EOF'
```brainfuck
plain words only
```
EOF
has 'ac:name="code"'
hasnt 'ac:name="language"'

render_case <<'EOF'
```bash
before ]]> after
```
EOF
has ']]]]><![CDATA[>'

render_case <<'EOF'
> [!WARNING] Take care
> This part of the product is changing soon.
EOF
has 'ac:name="warning"'
has 'ac:name="title">Take care<'
has '<ac:rich-text-body>'

render_case <<'EOF'
> A short quote from someone who uses the product.
EOF
has '<blockquote>'
hasre '<blockquote>[[:space:]]*<p>'

render_case <<'EOF'
:::expand More detail
Here is the longer story for anyone who wants it.
:::
EOF
has 'ac:name="expand"'
has 'ac:name="title">More detail<'
has '<ac:rich-text-body>'

render_case <<'EOF'
[[status:Green|Ready]]
EOF
has 'ac:name="status"'
has 'ac:name="colour">Green<'
has 'ac:name="title">Ready<'
hasre '<p>[[:space:]]*<ac:structured-macro'

render_case <<'EOF'
See [the other page](other-page.md) and [that heading](other-page.md#Some Heading).

Visit [the site](https://example.com/thing) or write to [us](mailto:team@example.com).

![Say "hi"](https://example.com/logo.png)
EOF
has 'ri:content-title="Other Page"'
has 'ac:anchor="Some Heading"'
has '<![CDATA[the other page]]>'
has '<a href="https://example.com/thing">the site</a>'
has '<a href="mailto:team@example.com">'
has 'ac:alt="Say &quot;hi&quot;"'
has 'ri:value="https://example.com/logo.png"'

render_case <<'EOF'
Tom & Jerry ran 5 < 6 and 9 > 4 in the "big" race.
EOF
has '&amp;'
has '&lt;'
has '&gt;'

# =============================================================================
# 3. renderer refusals — every one names its source line
# =============================================================================
render_refuses "an H1 heading" 3 "don't repeat the title" <<'EOF'
The title of a page lives in its frontmatter.

# A second title
EOF

render_refuses "raw HTML" 3 <<'EOF'
The title of a page lives in its frontmatter.

<div>hand written markup</div>
EOF

render_refuses "a local image" 3 <<'EOF'
The title of a page lives in its frontmatter.

![A picture](pictures/basket.png)
EOF

render_refuses "a nested blockquote" 3 <<'EOF'
The title of a page lives in its frontmatter.

> > a quote inside a quote
EOF

render_refuses "an autolink" 3 <<'EOF'
The title of a page lives in its frontmatter.

<https://example.com/thing>
EOF

render_refuses "an unknown status colour" 3 <<'EOF'
The title of a page lives in its frontmatter.

[[status:Purple|Nope]]
EOF

# =============================================================================
# 4. lint refusals
# =============================================================================
page lint-camel "Camel Case" glossary "" "" draft false <<'EOF'
The checkoutFlow decides what a shopper sees after they pay for a basket.
EOF
lint_refuses lint-camel "a camelCase identifier"
rm "$PAGES/lint-camel.md"

page lint-path "File Path" glossary "" "" draft false <<'EOF'
The rules for this live in src/checkout/basket.ts and change often.
EOF
lint_refuses lint-path "a source file path"
rm "$PAGES/lint-path.md"

page lint-banned "Banned Term" glossary "" "" draft false <<'EOF'
The endpoint answers in well under a second for every shopper.
EOF
lint_refuses lint-banned "a banned jargon term"
rm "$PAGES/lint-banned.md"

setcfg audience.allow '["checkoutFlow"]'
page lint-allowed "Allowed Term" glossary "" "" draft false <<'EOF'
The checkoutFlow is a name the team agreed to keep in this handbook on purpose.
EOF
hb_rc lint lint-allowed
[ "$RC" = "0" ] || fail "audience.allow did not exempt an allowed term (exit $RC)"
rm "$PAGES/lint-allowed.md"
setcfg audience.allow '[]'

page lint-fence "Fenced Feature" feature "" "store/checkout" draft false <<'EOF'
This page explains what the checkout part of the product does for shoppers, in plain words for anyone who wants to know what it promises them.

## What it does

Shoppers can pay for the items in their basket and choose where the order should be sent.

## How it behaves

The product asks for payment details once and confirms the order on the screen right away.

## Limits & known gaps

Shoppers cannot yet split one order across two payment cards.

```bash
plain words only
```
EOF
lint_refuses lint-fence "a code fence on a kind that forbids them"
rm "$PAGES/lint-fence.md"

page lint-sections "Thin Feature" feature "" "store/checkout" draft false <<'EOF'
This page explains what the checkout part of the product does for shoppers, in plain words for anyone who wants to know what it promises them.

## What it does

Shoppers can pay for the items in their basket and choose where the order should be sent.

## How it behaves

The product asks for payment details once and confirms the order on the screen right away.
EOF
lint_refuses lint-sections "a missing required section"
rm "$PAGES/lint-sections.md"

page lint-dup-one "Same Title" glossary "" "" draft false <<'EOF'
One of two pages that claim the very same title in the same space.
EOF
page lint-dup-two "Same Title" glossary "" "" draft false <<'EOF'
The other of two pages that claim the very same title in the same space.
EOF
lint_refuses lint-dup-one "two pages with the same title"
rm "$PAGES/lint-dup-one.md" "$PAGES/lint-dup-two.md"

page lint-noparent "Lost Child" glossary ghost-page "" draft false <<'EOF'
This page names a parent that no page file in the suite provides.
EOF
lint_refuses lint-noparent "a parent slug that does not exist"
rm "$PAGES/lint-noparent.md"

page lint-cyc-a "Cycle One" glossary lint-cyc-b "" draft false <<'EOF'
The first page of a pair that name each other as parents.
EOF
page lint-cyc-b "Cycle Two" glossary lint-cyc-a "" draft false <<'EOF'
The second page of a pair that name each other as parents.
EOF
lint_refuses lint-cyc-a "a parent cycle"
rm "$PAGES/lint-cyc-a.md" "$PAGES/lint-cyc-b.md"

# Assembled at runtime from two halves: a whole literal in this file would trip
# the repo's own secret gate before the test ever ran.
LEAK_HEAD='AKIA'
LEAK_TAIL='AAAABBBBCCCCDDDD'
LEAKED="$LEAK_HEAD$LEAK_TAIL"
page lint-secret "Leaky Page" glossary "" "" draft false <<EOF
Someone pasted $LEAKED into the notes for this page by mistake.
EOF
RC=0; OUT="$(node "$CLI" lint lint-secret --repo "$REPO" 2>&1)" || RC=$?
[ "$RC" != "0" ] || fail "lint accepted a page carrying a secret"
echo "$OUT" | grep -q "$LEAKED" && fail "the secret finding echoed the secret back"
rm "$PAGES/lint-secret.md"

# =============================================================================
# 5. publish-gate refusals
# =============================================================================
page gate-noeditorial "Gate No Editorial" glossary "" "" published true <<'EOF'
This page is ready in every way except that nobody has left an audience trail on it yet.

## What it means

The team wrote it in plain words, but the gate still has nothing to stand on.
EOF
page gate-placeholder "Gate Placeholder" glossary "" "" published true <<'EOF'
This page still carries the editorial section exactly as the page template shipped it.

## What it means

The team wrote it in plain words, but the editorial section was never filled in.

## Editorial

(Optional — filled in by the audience gate when the page is reviewed.)
EOF
page gate-notrail "Gate No Trail" glossary "" "" published true <<'EOF'
This page carries editorial notes, but none of them record that the audience gate ran.

## What it means

The team wrote it in plain words and left a note, but not the one the gate needs.

## Editorial

A reviewer read this page and liked it.
EOF
OUT="$(hb_out sync)"
echo "$OUT" | grep -q 'NOT publishing' || fail "the publish gate did not refuse"
echo "$OUT" | grep -q 'no ## Editorial section' || fail "missing-editorial reason not named"
echo "$OUT" | grep -q 'still the template placeholder' || fail "placeholder-editorial reason not named"
echo "$OUT" | grep -q 'trail line' || fail "missing audience-check trail reason not named"
[ "$(counter createPage)" = "0" ] || fail "a gate-blocked page was published anyway"
[ "$(sfield gate-noeditorial pageId)" = "" ] || fail "a gate-blocked page mutated the state file"
rm "$PAGES/gate-noeditorial.md" "$PAGES/gate-placeholder.md" "$PAGES/gate-notrail.md"

# =============================================================================
# 6. create — a three-page tree in one pass, then the first-publish gate
# =============================================================================
page zz-root "Product Handbook" index "" "" published true <<'EOF'
This handbook explains what the product does for the people who use it, written in plain words for anyone who joins the team and needs to get up to speed.

## What you will find here

Every page below covers one part of the product and the promises it makes to the people who pay for it.

<!-- children -->

## Editorial

Audience-check: clean — 2 claims verified, reviewer clean
EOF
page mm-child "Words We Use" glossary zz-root "" published true <<'EOF'
This page lists the everyday words the team uses when talking about the product, so that everyone means the same thing when they talk to each other.

## Everyday words

A basket is the list of items a shopper has chosen but has not paid for yet.

A coupon is a code a shopper types in to lower the price of a basket.

See [More Words](aa-grand.md) for the rest of the list.

## Editorial

Audience-check: clean — 3 claims verified, reviewer clean
EOF
page aa-grand "More Words" glossary mm-child "" published true <<'EOF'
This page continues the list of everyday words the team uses when talking about the product and the promises it makes to shoppers.

## More everyday words

A refund is money returned to a shopper after they send an item back.

A saved basket is a basket a shopper keeps for later.

## Editorial

Audience-check: clean — 1 claim verified, reviewer clean
EOF
hb_sync
ROOT_ID="$(page_id zz-root)"
MID_ID="$(page_id mm-child)"
GRAND_ID="$(page_id aa-grand)"
[ -n "$ROOT_ID" ] || fail "no pageId written back for the index page"
[ -n "$MID_ID" ] || fail "no pageId written back for the child page"
[ -n "$GRAND_ID" ] || fail "no pageId written back for the grandchild page"
[ "$(counter createPage)" = "3" ] || fail "expected 3 creates, got $(counter createPage)"
[ "$(page_field "$MID_ID" parentId)" = "$ROOT_ID" ] || fail "child was not created under its parent"
[ "$(page_field "$GRAND_ID" parentId)" = "$MID_ID" ] || fail "grandchild was not created under its parent (topological order broken)"

simple_page nn-pending "Coming Soon Words" published false
OUT="$(hb_out sync)"
echo "$OUT" | grep -q 'first publish' || fail "an unapproved first publish was not refused"
[ "$(counter createPage)" = "3" ] || fail "an unapproved page was created"
sed -i 's/^approved: false/approved: true/' "$PAGES/nn-pending.md"
hb_sync
[ "$(counter createPage)" = "4" ] || fail "an approved page was not created"
[ -n "$(page_id nn-pending)" ] || fail "no pageId written back for the approved page"

# =============================================================================
# 7. idempotent re-run — every counter unchanged (not even a GET)
# =============================================================================
BEFORE="$(all_counters)"
hb_sync
[ "$(all_counters)" = "$BEFORE" ] || fail "re-run was not idempotent ($BEFORE → $(all_counters))"

# =============================================================================
# 8. content update
# =============================================================================
BEFORE_UPD="$(counter updatePage)"
sed -i 's/after they send an item back/once the returned item arrives/' "$PAGES/aa-grand.md"
hb_sync
[ "$(counter updatePage)" = "$((BEFORE_UPD + 1))" ] || fail "a content change did not fire exactly one update"
[ "$(sfield aa-grand version)" = "2" ] || fail "state version is not 2 after the first update"
state | grep -q 'handbook: confluence/pages/aa-grand.md' || fail "the version message does not carry the page path"
state | grep -q 'once the returned item arrives' || fail "the new content was not pushed"

# =============================================================================
# 9. rename-only — the cheap title endpoint, no content write
# =============================================================================
BEFORE_UPD="$(counter updatePage)"
BEFORE_TITLE="$(counter titleUpdate)"
sed -i 's/^title: "Product Handbook"/title: "Product Handbook Beta"/' "$PAGES/zz-root.md"
hb_sync
[ "$(counter titleUpdate)" = "$((BEFORE_TITLE + 1))" ] || fail "a rename did not use the title endpoint"
[ "$(counter updatePage)" = "$BEFORE_UPD" ] || fail "a rename-only page took the full content path"
[ "$(page_field "$ROOT_ID" title)" = "Product Handbook Beta" ] || fail "the rename never reached Confluence"

# =============================================================================
# 10. move-only
# =============================================================================
BEFORE_UPD="$(counter updatePage)"
sed -i 's/^parent: mm-child/parent: nn-pending/' "$PAGES/aa-grand.md"
hb_sync
[ "$(counter updatePage)" = "$((BEFORE_UPD + 1))" ] || fail "a move did not fire exactly one update"
[ "$(page_field "$GRAND_ID" parentId)" = "$(page_id nn-pending)" ] || fail "the move never reached Confluence"

# =============================================================================
# 11. duplicate title on create — named conflict, then --adopt
# =============================================================================
mock_json POST "/wiki/api/v2/pages" '{"spaceId":"65758","status":"current","title":"Coupons","body":{"representation":"storage","value":"<p>seeded by hand</p>"}}'
simple_page coupons "Coupons" published true
RC=0; OUT="$(node "$CLI" sync --repo "$REPO" 2>&1)" || RC=$?
echo "$OUT" | grep -q 'another page owns this title' || fail "a duplicate title was not reported with its remedies"
[ "$RC" = "1" ] || fail "a duplicate-title create should be a page failure (exit 1, got $RC)"
[ "$(page_id coupons)" = "" ] || fail "a pageId was written back for a failed create"
BEFORE_CREATE="$(counter createPage)"
hb_sync --adopt
[ "$(counter createPage)" = "$BEFORE_CREATE" ] || fail "--adopt created a second page instead of adopting"
COUPON_ID="$(page_id coupons)"
[ -n "$COUPON_ID" ] || fail "--adopt did not write back the adopted pageId"
[ "$(counter findPage)" -ge 1 ] || fail "--adopt never queried for an existing page"

# =============================================================================
# 12. chaos 409 on the write — re-GET and retry once
# =============================================================================
# The mock arms its next write response; the drift GET that precedes every
# update must not consume the arming.
sed -i 's/lower the price of a basket/take money off the price of a basket/' "$PAGES/mm-child.md"
mock_json POST "/__chaos" '{"status":409,"times":1,"retryAfter":0}'
hb_rc sync
[ "$RC" = "0" ] || fail "a 409 on the write was not recovered (exit $RC)"
state | grep -q 'take money off the price of a basket' || fail "the update was lost after the 409"

# =============================================================================
# 13. chaos 429 with Retry-After: 0
# =============================================================================
sed -i 's/take money off the price of a basket/reduce the price of a basket/' "$PAGES/mm-child.md"
mock_json POST "/__chaos" '{"status":429,"times":1,"retryAfter":0}'
hb_rc sync
[ "$RC" = "0" ] || fail "a 429 was not retried (exit $RC)"
state | grep -q 'reduce the price of a basket' || fail "the update was lost after the 429"

# =============================================================================
# 14. remote edit — block, then overwrite
# =============================================================================
MID_V="$(sfield mm-child version)"
mock_json PUT "/wiki/api/v2/pages/$MID_ID" "{\"id\":\"$MID_ID\",\"status\":\"current\",\"title\":\"Words We Use\",\"body\":{\"representation\":\"storage\",\"value\":\"<p>edited by a person in the browser</p>\"},\"version\":{\"number\":$((MID_V + 1)),\"message\":\"hand edit\"}}"
BEFORE_UPD="$(counter updatePage)"
sed -i 's/reduce the price of a basket/cut the price of a basket/' "$PAGES/mm-child.md"
OUT="$(hb_out sync)"
echo "$OUT" | grep -q 'mm-child' || fail "the blocked page was not named"
[ "$(counter updatePage)" = "$BEFORE_UPD" ] || fail "block mode wrote over a remote edit"
[ "$(sfield mm-child version)" = "$MID_V" ] || fail "a blocked page still mutated its state version"
state | grep -q 'edited by a person in the browser' || fail "the remote edit was clobbered"
setcfg sync.onRemoteEdit '"overwrite"'
hb_rc sync
[ "$RC" = "0" ] || fail "overwrite mode failed (exit $RC)"
state | grep -q 'cut the price of a basket' || fail "overwrite did not push the local content"
setcfg sync.onRemoteEdit '"block"'

# =============================================================================
# 15. labels — declarative over what we own
# =============================================================================
simple_page label-demo "Label Demo" published true
hb_sync
LABEL_ID="$(page_id label-demo)"
[ "$(labels_of "$LABEL_ID")" = "acme,glossary,hb-acme-label-demo,legacy" ] \
  || fail "create did not stamp config, kind and marker labels (got: $(labels_of "$LABEL_ID"))"
mock_json POST "/wiki/rest/api/content/$LABEL_ID/label" '[{"prefix":"global","name":"hand-added"}]'
BEFORE_REMOVE="$(counter labelRemove)"
setcfg labels '["acme"]'
hb_sync
[ "$(labels_of "$LABEL_ID")" = "acme,glossary,hand-added,hb-acme-label-demo" ] \
  || fail "dropping one config label did not remove exactly it (got: $(labels_of "$LABEL_ID"))"
[ "$(counter labelRemove)" -gt "$BEFORE_REMOVE" ] || fail "dropping a config label removed nothing"
BEFORE_LABELS="$(counter labelAdd),$(counter labelRemove)"
hb_sync
[ "$(counter labelAdd),$(counter labelRemove)" = "$BEFORE_LABELS" ] || fail "the label pass was not idempotent"

# =============================================================================
# 16. retire — approval gate, banner mode, trash mode, no repeats
# =============================================================================
simple_page retire-me "Retire Me" published true
simple_page trash-me "Trash Me" published true
hb_sync
BEFORE_UPD="$(counter updatePage)"
BEFORE_DEL="$(counter deletePage)"
sed -i 's/^status: published/status: retired/; s/^approved: true/approved: false/' "$PAGES/retire-me.md"
hb_sync
[ "$(counter updatePage)" = "$BEFORE_UPD" ] || fail "an unapproved retire still wrote"
[ "$(counter deletePage)" = "$BEFORE_DEL" ] || fail "an unapproved retire deleted a page"
sed -i 's/^approved: false/approved: true/' "$PAGES/retire-me.md"
hb_sync
[ "$(counter updatePage)" = "$((BEFORE_UPD + 1))" ] || fail "banner retire did not write exactly one update"
[ "$(counter deletePage)" = "$BEFORE_DEL" ] || fail "banner retire deleted the page"
state | grep -q 'no longer maintained' || fail "the retire banner never reached Confluence"
BEFORE_UPD="$(counter updatePage)"
hb_sync
[ "$(counter updatePage)" = "$BEFORE_UPD" ] || fail "the retire write repeated on the next pass"
setcfg sync.retireMode '"trash"'
sed -i 's/^status: published/status: retired/' "$PAGES/trash-me.md"
hb_sync
[ "$(counter deletePage)" = "$((BEFORE_DEL + 1))" ] || fail "trash mode did not delete the page"
BEFORE_DEL="$(counter deletePage)"
hb_sync
[ "$(counter deletePage)" = "$BEFORE_DEL" ] || fail "the trash delete repeated on the next pass"
setcfg sync.retireMode '"banner"'

# =============================================================================
# 17. orphan — a deleted file never deletes a live page
# =============================================================================
simple_page orphan-me "Orphan Me" published true
hb_sync
ORPHAN_PAGE_ID="$(page_id orphan-me)"
rm "$PAGES/orphan-me.md"
BEFORE_DEL="$(counter deletePage)"
OUT="$(hb_out sync)"
echo "$OUT" | grep -q 'still live in Confluence' || fail "a deleted page file did not warn about the live page"
[ "$(counter deletePage)" = "$BEFORE_DEL" ] || fail "an orphan was auto-deleted"
[ "$(orphan_id orphan-me)" = "$ORPHAN_PAGE_ID" ] || fail "the orphan was not recorded in the state file"
[ "$(sfield orphan-me pageId)" = "" ] || fail "the orphan is still tracked as a live page"
OUT="$(hb_out sync)"
echo "$OUT" | grep -q 'still live in Confluence' || fail "the orphan warning did not repeat"

# =============================================================================
# 18. draft — zero network
# =============================================================================
simple_page draft-page "Draft Page" draft false
BEFORE="$(all_counters)"
OUT="$(hb_out sync)"
[ "$(all_counters)" = "$BEFORE" ] || fail "a draft page caused network calls"
echo "$OUT" | grep -q 'not published' || fail "the draft page was not reported as unpublished"

# =============================================================================
# 19. --dry-run mutates nothing
# =============================================================================
sed -i 's/a shopper keeps for later/a shopper keeps for another day/' "$PAGES/aa-grand.md"
BEFORE="$(mutating_counters)"
hb_rc sync --dry-run
[ "$RC" = "0" ] || fail "--dry-run exited $RC"
[ "$(mutating_counters)" = "$BEFORE" ] || fail "--dry-run mutated Confluence"
hb_sync
state | grep -q 'keeps for another day' || fail "the pending change did not land after the dry run"

# =============================================================================
# 20. --force republishes, and the pass after it is idempotent again
# =============================================================================
FORCE_V="$(sfield aa-grand version)"
hb_sync --force
[ "$(sfield aa-grand version)" = "$((FORCE_V + 1))" ] || fail "--force did not republish an unchanged page"
BEFORE="$(all_counters)"
hb_sync
[ "$(all_counters)" = "$BEFORE" ] || fail "the pass after --force was not idempotent"

# =============================================================================
# 21. circuit breaker — 26 pending updates abort before any write
# =============================================================================
for i in {01..26}; do simple_page "cb-$i" "Circuit Breaker $i" published true; done
hb_sync
sed -i 's/so that anyone can read it quickly/so that everyone can read it quickly/' "$PAGES"/cb-*.md
BEFORE_UPD="$(counter updatePage)"
RC=0; OUT="$(node "$CLI" sync --repo "$REPO" 2>&1)" || RC=$?
echo "$OUT" | grep -q 'would update' || fail "the circuit breaker did not report the pending update count"
[ "$RC" = "1" ] || fail "the circuit breaker should abort the pass (exit 1, got $RC)"
[ "$(counter updatePage)" = "$BEFORE_UPD" ] || fail "the circuit breaker wrote before aborting"
hb_sync --force
[ "$(counter updatePage)" -gt "$BEFORE_UPD" ] || fail "--force did not bypass the circuit breaker"

# =============================================================================
# 22. pull — a read-only drift report
# =============================================================================
COUPON_V="$(sfield coupons version)"
mock_json PUT "/wiki/api/v2/pages/$COUPON_ID" "{\"id\":\"$COUPON_ID\",\"status\":\"current\",\"title\":\"Coupons\",\"body\":{\"representation\":\"storage\",\"value\":\"<p>edited in the browser</p>\"},\"version\":{\"number\":$((COUPON_V + 1)),\"message\":\"hand edit\"}}"
BEFORE="$(mutating_counters)"
RC=0; OUT="$(node "$CLI" pull --repo "$REPO" 2>&1)" || RC=$?
[ "$RC" = "0" ] || fail "pull exited $RC"
echo "$OUT" | grep -q 'edited in Confluence' || fail "pull did not report the remote edit"
echo "$OUT" | grep -q 'local files remain authoritative' || fail "pull is missing its terminal line"
[ "$(mutating_counters)" = "$BEFORE" ] || fail "pull mutated Confluence"

# =============================================================================
# 23. staleness — real commits, no network
# =============================================================================
mkdir -p "$REPO/store/checkout"
printf 'Shoppers pay for the items in their basket.\n' >"$REPO/store/checkout/rules.txt"
page checkout "Checkout" feature "" "store/checkout" draft false <<'EOF'
This page explains what the checkout part of the product does for shoppers, in plain words for anyone who wants to know what it promises them.

## What it does

Shoppers can pay for the items in their basket and choose where the order should be sent.

## How it behaves

The product asks for payment details once and confirms the order on the screen right away.

## Limits & known gaps

Shoppers cannot yet split one order across two payment cards.

## Editorial

Audience-check: clean — 3 claims verified, reviewer clean
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -qm "seed the handbook and the checkout rules"
hb_rc stale --exit-code
[ "$RC" = "0" ] || fail "a page committed alongside its sources should be fresh (exit $RC)"

printf 'Shoppers can also choose where the order should be sent.\n' >>"$REPO/store/checkout/rules.txt"
git -C "$REPO" commit -qam "tighten the checkout rules"
OUT="$(hb_out stale)"
echo "$OUT" | grep -q 'STALE' || fail "a source change after the page commit is not reported as stale"
echo "$OUT" | grep -q 'tighten the checkout rules' || fail "the stale report does not list the commits to review"
echo "$OUT" | grep -q 'git log' || fail "the stale report does not offer the review command"
hb_rc stale --exit-code
[ "$RC" = "1" ] || fail "--exit-code should be 1 while a page is stale (got $RC)"

printf 'Shoppers see the total before they pay.\n' >>"$REPO/store/checkout/rules.txt"
OUT="$(hb_out stale)"
echo "$OUT" | grep -q 'DIRTY' || fail "uncommitted source changes are not reported as dirty"

printf '\nThe team read this page against the rules again today.\n' >>"$PAGES/checkout.md"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "review the checkout page against the rules"
hb_rc stale --exit-code
[ "$RC" = "0" ] || fail "committing the page did not reset the staleness baseline (exit $RC)"

git -C "$REPO" rm -q -r store/checkout
git -C "$REPO" commit -qm "remove the checkout rules"
OUT="$(hb_out stale)"
echo "$OUT" | grep -q 'MISSING-SOURCE' || fail "a source that no longer exists is not reported"
hb_rc stale --exit-code
[ "$RC" = "1" ] || fail "--exit-code should be 1 when a source is missing (got $RC)"

setcfg staleness.watch '["lib"]'
mkdir -p "$REPO/lib/pricing"
printf 'Prices are rounded to the nearest penny.\n' >"$REPO/lib/pricing/notes.txt"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "add the pricing notes"
OUT="$(hb_out stale)"
echo "$OUT" | grep -q 'GAP' || fail "watched files claimed by no page are not reported as a gap"
echo "$OUT" | grep -q 'lib/pricing' || fail "the gap report does not name the unclaimed directory"

BRIEF="$(hb_out stale --brief)"
BRIEF_LINES="$(printf '%s\n' "$BRIEF" | wc -l)"
[ "$BRIEF_LINES" -le 5 ] || fail "--brief printed $BRIEF_LINES lines (max 5)"
echo "$BRIEF" | grep -q 'stale' || fail "--brief does not summarise the stale count"

# =============================================================================
# 24. one malformed page file fails alone
# =============================================================================
cat >"$PAGES/bad-front.md" <<'EOF'
---
title: "Broken Page"
kind: glossary
this line is not a key and a value
status: draft
---
Nothing below matters — the frontmatter above cannot be parsed.
EOF
sed -i 's/once the returned item arrives/as soon as the item is back with us/' "$PAGES/aa-grand.md"
BEFORE_UPD="$(counter updatePage)"
RC=0; OUT="$(node "$CLI" sync --repo "$REPO" 2>&1)" || RC=$?
[ "$RC" = "1" ] || fail "a malformed page file should make the pass exit 1 (got $RC)"
echo "$OUT" | grep -q 'bad-front' || fail "the malformed page was not named"
[ "$(counter updatePage)" = "$((BEFORE_UPD + 1))" ] || fail "one bad file stopped the good pages from syncing"
rm "$PAGES/bad-front.md"

# =============================================================================
# 25. a held lock queues a rerun and touches nothing
# =============================================================================
sed -i 's/as soon as the item is back with us/as soon as the item has been checked/' "$PAGES/aa-grand.md"
printf '999999' >"$REPO/confluence/.sync.lock"
BEFORE="$(all_counters)"
hb_rc sync
[ "$RC" = "0" ] || fail "a held lock must exit 0 (got $RC)"
[ -f "$REPO/confluence/.sync.rerun" ] || fail "a held lock did not queue a rerun"
[ "$(all_counters)" = "$BEFORE" ] || fail "a held lock still hit the network"
rm -f "$REPO/confluence/.sync.lock" "$REPO/confluence/.sync.rerun"
hb_sync
state | grep -q 'as soon as the item has been checked' || fail "the queued change never synced once the lock cleared"

# =============================================================================
# 26. credentials — missing, then supplied by envFile under custom var names
# =============================================================================
BEFORE="$(all_counters)"
RC=0; env -u CONFLUENCE_EMAIL -u CONFLUENCE_API_TOKEN node "$CLI" sync --repo "$REPO" >/dev/null 2>&1 || RC=$?
[ "$RC" = "3" ] || fail "missing credentials must exit 3 (got $RC)"
[ "$(all_counters)" = "$BEFORE" ] || fail "a run without credentials still called Confluence"

setcfg emailEnv '"HB_DOCS_MAIL"'
setcfg tokenEnv '"HB_DOCS_TOKEN"'
setcfg envFile '".env"'
printf 'export HB_DOCS_MAIL="t@e.st"\nHB_DOCS_TOKEN=tok\n' >"$REPO/.env"
simple_page env-file-check "Credentials From A File" published true
BEFORE_CREATE="$(counter createPage)"
RC=0; env -u CONFLUENCE_EMAIL -u CONFLUENCE_API_TOKEN node "$CLI" sync --repo "$REPO" >/dev/null || RC=$?
[ "$RC" = "0" ] || fail "envFile credentials did not work (exit $RC)"
[ "$(counter createPage)" = "$((BEFORE_CREATE + 1))" ] || fail "the envFile page was not created"
[ -n "$(page_id env-file-check)" ] || fail "no pageId written back for the envFile page"

# =============================================================================
# 27. claim citations — renderer goldens and refusals
# =============================================================================
# The harness renders with an empty repoUrl by default; the linked form needs one.
export HB_RENDER_REPO_URL="https://example.invalid/handbook"

render_case <<'EOF'
Shoppers can pay for everything in their basket in one go.[^1]

## Claims

[^1]: store/checkout/rules.txt:42 @ a1b2c3d4e5 — The checkout step charges the whole basket once.
EOF
has '<sup>1</sup>'
has 'ac:name="expand"'
has 'ac:name="title">Where these claims come from (technical)<'
has '<ol>'
has '/blob/a1b2c3d4e5/'
has '#L42'
has 'href="https://example.invalid/handbook/blob/a1b2c3d4e5/store/checkout/rules.txt#L42"'
has 'The checkout step charges the whole basket once.'
hasnt '<h2>Claims</h2>'

# No sha in the definition — the link falls back to HEAD, and no line means no #L.
render_case <<'EOF'
Shoppers see the total before they pay.[^2]

## Claims

[^2]: store/checkout/total.txt — The total is worked out before the payment step.
EOF
has 'href="https://example.invalid/handbook/blob/HEAD/store/checkout/total.txt"'
hasnt '#L'

unset HB_RENDER_REPO_URL
# Without repoUrl the citation still publishes, as plain text.
render_case <<'EOF'
Shoppers can pay for everything in their basket in one go.[^1]

## Claims

[^1]: store/checkout/rules.txt:42 @ a1b2c3d4e5 — The checkout step charges the whole basket once.
EOF
has 'ac:name="title">Where these claims come from (technical)<'
has 'store/checkout/rules.txt:42'
hasnt '<a href'

render_refuses "a malformed claims definition" 5 <<'EOF'
Shoppers can pay for everything in their basket in one go.[^1]

## Claims

this line is not a claim definition
EOF

render_refuses "an empty claims section" 3 <<'EOF'
Shoppers can pay for everything in their basket in one go.

## Claims
EOF

# =============================================================================
# 28. claim lint — undefined markers block, claim paths do not, walls warn
# =============================================================================
page claim-undefined "Missing Claim" glossary "" "" draft false <<'EOF'
The team promises to keep this page short and true for everyone who reads it.[^1]
EOF
lint_refuses claim-undefined "a claim marker with no definition"
rm "$PAGES/claim-undefined.md"

# The one deliberately-technical block: the path rule must not fire inside it.
page claim-paths "Claim Paths" glossary "" "" draft false <<'EOF'
Shoppers can pay for everything in their basket in one go.[^1]

## Claims

[^1]: src/checkout/basket.ts:42 @ a1b2c3d4e5 — The basket is charged once when the shopper pays.
EOF
hb_rc lint claim-paths
[ "$RC" = "0" ] || fail "a claims definition tripped the path rule (exit $RC)"
rm "$PAGES/claim-paths.md"

page wall-page "Wall Of Text" glossary "" "" draft false <<'EOF'
This page explains one small part of the product in plain words for anyone who wants to know what it promises the people who use it.

## How it behaves

The product asks a shopper for their payment details once and then confirms the order on the screen right away.

The product also sends a short note to the shopper by email so that they have a record of what they bought.

The product keeps the order open for a little while in case the shopper wants to change where it should be sent.
EOF
OUT="$(hb_out lint wall-page)"
echo "$OUT" | grep -q 'wall-of-text' || fail "three paragraphs in one section did not warn"
echo "$OUT" | grep -q 'consecutive paragraphs' || fail "the wall-of-text warning does not say what it counted"
echo "$OUT" | grep -q 'How it behaves' || fail "the wall-of-text warning does not name the section"
hb_rc lint wall-page
[ "$RC" = "0" ] || fail "a wall-of-text warning must not block (exit $RC)"
rm "$PAGES/wall-page.md"

# =============================================================================
# 29. claim citations end to end — markers and the expand macro reach Confluence
# =============================================================================
page claims-page "Where Claims Come From" glossary "" "" published true <<'EOF'
This page explains one small part of the product in plain words for anyone who wants to know what the product promises the people who use it.

## What it means

Shoppers can pay for everything in their basket in one go.[^1]

## Claims

[^1]: store/checkout/rules.txt:12 @ a1b2c3d4e5 — The checkout step charges the whole basket once.

## Editorial

Audience-check: clean — 1 claim verified, reviewer clean
EOF
hb_sync
[ -n "$(page_id claims-page)" ] || fail "no pageId written back for the claims page"
state | grep -q '<sup>1</sup>' || fail "the claim marker did not publish as a superscript"
state | grep -q 'Where these claims come from (technical)' || fail "the claims expand macro did not publish"
state | grep -q 'blob/a1b2c3d4e5/store/checkout/rules.txt#L12' || fail "the published citation is not sha-pinned"

# =============================================================================
# 30. general pages (0.4.0) — audienceLint off, parentId, and the rules that stay on
# =============================================================================
# The same technical prose, twice: a `general` page lints clean and publishes
# with its kind label; a `feature` page is refused. This is the whole contract
# of audienceLint: the vocabulary rules are per kind, the secret scan is not.
TECHNICAL_BODY=$(cat <<'EOF'
A one-off decision record the team asked to keep in Confluence, written for the engineers who will act on it rather than for a product reader.

## Decision

We keep the `useListUrlState` hook in src/shared/hooks/use-list-url-state.ts and call the endpoint from the schema migration. Run `pnpm test` before merging.

```bash
pnpm test
```

## Editorial

Audience-check: not applied — general page, published on the requester's word; secret scan + structure lint clean
EOF
)
printf '%s\n' "$TECHNICAL_BODY" | page gen-decision "Decision: List State Hook" general "" "" published true
hb_rc lint gen-decision
[ "$RC" = "0" ] || fail "a general page was refused for technical vocabulary (audienceLint should be off for it)"
hb_sync
[ -n "$(page_id gen-decision)" ] || fail "the general page did not publish"
GEN_ID="$(page_id gen-decision)"
case "$(labels_of "$GEN_ID")" in *general*) : ;; *) fail "the general page did not get its kind label" ;; esac

printf '%s\n' "$TECHNICAL_BODY" | page gen-feature "Decision As Feature" feature "" "store/checkout" draft false
lint_refuses gen-feature "the same technical prose on a feature page (audienceLint must stay on for it)"
rm "$PAGES/gen-feature.md"

# The secret scan never switches off — a local-port literal is one of its patterns.
page gen-secret "General With A Secret" general "" "" draft false <<'EOF'
A one-off note that happens to carry an address the secret scan refuses.

## Where it runs

The service answers on localhost:3050 during development.
EOF
lint_refuses gen-secret "a general page carrying a secret-scan pattern"
rm "$PAGES/gen-secret.md"

# Structure rules never switch off either — an H1 is still an H1.
page gen-h1 "General With H1" general "" "" draft false <<'EOF'
# A heading the frontmatter already provides

A one-off note that repeats its title as a level-one heading.
EOF
lint_refuses gen-h1 "an H1 on a general page"
rm "$PAGES/gen-h1.md"

# parentId: mount under a raw Confluence id (here: a page the suite happens to own,
# but the CLI treats it as an opaque id — no slug, no state lookup).
CLAIMS_ID="$(page_id claims-page)"
page gen-child "Under A Raw Page Id" general "" "" published true "parentId: $CLAIMS_ID" <<'EOF'
A one-off page filed under an existing Confluence page by its id rather than by a suite slug.

## Body

Nothing here depends on the page above it being managed by handbook.

## Editorial

Audience-check: not applied — general page, published on the requester's word; secret scan + structure lint clean
EOF
hb_rc lint gen-child
[ "$RC" = "0" ] || fail "lint refused a valid numeric parentId"
hb_sync
CHILD_ID="$(page_id gen-child)"
[ -n "$CHILD_ID" ] || fail "the parentId page did not publish"
[ "$(page_field "$CHILD_ID" parentId)" = "$CLAIMS_ID" ] || fail "parentId page was not created under the raw id (got '$(page_field "$CHILD_ID" parentId)', want '$CLAIMS_ID')"

page gen-both "Parent And ParentId" general claims-page "" draft false "parentId: $CLAIMS_ID" <<'EOF'
A page that names both a suite parent and a raw parent id, which lint must refuse.
EOF
lint_refuses gen-both "parent: and parentId: set together"
rm "$PAGES/gen-both.md"

page gen-badid "Bad Parent Id" general "" "" draft false "parentId: not-a-number" <<'EOF'
A page whose parent id is not a Confluence page id, which lint must refuse.
EOF
lint_refuses gen-badid "a non-numeric parentId"
rm "$PAGES/gen-badid.md"

echo "ALL PASS"
