# ephdepmap

Fork of [depmap](../depmap) with no server-side database. Same flat 2D
dependency map, same green-screen aesthetic, but every node, dependency,
and annotation lives in the browser's own `localStorage` instead of a
MariaDB container - the app container just serves static files. Still
sits behind an NGINX reverse proxy that terminates TLS and enforces HTTP
Basic auth; the app container has no port published to the host.

**This means the data is ephemeral and per-browser**, not shared or backed
up anywhere by default - see [Storage model](#storage-model) below before
relying on this for anything you can't afford to lose.

## Deploy

1. Copy this directory to the target host.
2. (Optional) Create a `.env` file next to `docker-compose.yml` to override
   the defaults below:

       HTTP_PORT=8080
       HTTPS_PORT=8443

   Don't set these in a system-wide file like `/etc/environment` instead —
   compose reads `.env` from the project directory, and a shell environment
   variable of the same name takes priority over it anyway (and will affect
   every other compose project on the box).
3. Build and start everything:

       docker compose up -d --build

   If the build hangs at "resolving provenance for metadata file", your
   network doesn't have a path out for BuildKit's attestation step — build
   with `DOCKER_BUILDKIT=0 docker compose build` instead (classic builder,
   skips that step entirely), then `docker compose up -d`.
4. Browse to `https://<host>:8443` (or your `HTTPS_PORT`). The browser will
   warn about the self-signed placeholder cert — that's expected until you
   swap it for a real one (below). Plain HTTP on `HTTP_PORT` just redirects
   to HTTPS.
5. Log in with the default Basic auth credentials: `admin` / `depmap`.
6. **Change that default password now** — see below.
7. Swap in a real TLS cert when you have one — see below.

### Change the default password

A default `admin` / `depmap` user is generated on first start (only if
`./nginx/auth/htpasswd` doesn't already exist — see [Layout](#layout)).
Change it, or add/remove other users, with the `htpasswd` binary bundled in
the nginx image — no rebuild or restart needed, nginx re-reads the file on
every request:

    # change admin's password (prompts you for it)
    #exec into the nginx container and run:
    htpasswd /etc/nginx/auth/htpasswd admin

    # add another user
    #exec into the nginx container and run:
    htpasswd /etc/nginx/auth/htpasswd someuser

    # remove a user
    #exec into the nginx container and run:
    htpasswd -D /etc/nginx/auth/htpasswd someuser

### Replace the placeholder TLS cert

On first start, if `./nginx/certs` is empty, the nginx container generates a
self-signed cert (`depmap.crt` / `depmap.key`, CN=depmap.local, 825 days).
To use a real one (e.g. issued from Vault PKI), drop your own `depmap.crt` /
`depmap.key` into `./nginx/certs` (same filenames) and:

    docker compose restart nginx

The entrypoint only generates a cert when those files are missing, so it
won't overwrite what you put there.

## Layout

- `./app` — source, bind-mounted; edit and `docker compose restart app`.
  `server.js` is a plain static file server — no `/api` routes, no DB
  client. All graph logic (including the auto-placement algorithm ported
  from the original `server.js`) lives in `./app/public/app.js`.
- `./nginx` — reverse proxy: TLS termination, basic auth, `proxy_pass` to `app:3000`
  - `./nginx/certs` — TLS cert/key (gitignored; placeholder auto-generated if empty)
  - `./nginx/auth` — htpasswd file (gitignored; default user auto-generated if empty)

## Storage model

Everything the UI would normally `fetch()` from a server (`/api/graph`,
`/api/nodes`, `/api/edges`, `/api/annotations`, ...) is instead handled by
an in-page router in `app.js` that reads/writes a single JSON blob under
the `ephdepmap-data` key in `localStorage`, keyed to the app's origin
(scheme + host + port). The rest of the UI — `draw()`, drag handles, CSV
import/export — is unmodified from depmap and has no idea the "server" is
now a few hundred lines of local dispatch instead of a network call.

Practical consequences:

- **Per-browser, per-device.** Data doesn't follow you across browsers,
  profiles, or machines. Open the app in Firefox after using Chrome and
  you'll see an empty board.
- **No multi-user collaboration.** Two people (or two tabs) pointed at the
  same deployment don't see each other's changes — each browser has its
  own local copy.
- **Two tabs open at once will clobber each other.** Writes are
  last-write-wins with no cross-tab coordination; editing the same project
  in two tabs simultaneously will lose whichever tab saved first.
- **Clearing site data/cookies/history for this origin deletes the graph.**
  So does browsing in a private/incognito window and then closing it.
- **Storage ceiling.** `localStorage` is typically capped around 5–10MB per
  origin (browser-dependent) — comfortably enough for a large dependency
  map, but notes-heavy annotations could theoretically hit it. A save that
  fails this way surfaces as a normal error toast ("Could not save -
  browser storage is full or unavailable"), same as any other failed save.
- **Back up with `export project`.** The CSV round-trip export/import
  (nodes + edges + annotations) is the closest thing this fork has to a
  backup/restore or a way to move a project to a different browser — see
  [Project export / import (CSV)](#project-export--import-csv) below.

If you need shared, durable, multi-user storage, use the original
[depmap](../depmap) instead — this fork trades that for zero database
operational overhead.

## Using it

| action | how |
|---|---|
| pan | drag empty background |
| zoom | mouse wheel (cursor-anchored) |
| select node | click a node → right pane becomes an editor, bottom pane expands its deps |
| move node | shift + drag a node; position is written to local storage on release and survives reloads (see [Storage model](#storage-model) for what it doesn't survive) |
| multi-select nodes | ctrl+shift+click a node to add/remove it from the selection (dashed yellow ring around it); ctrl+shift+drag any selected node to move the whole group together |
| box-select nodes | ctrl+alt+drag over empty background — any node the box touches is added to the multi-select group |
| select dependency | click a line → dependency section of the right pane becomes an editor |
| reshape dependency | with a dependency selected, drag either of its two control-point handles; saved on release |
| move dependency endpoint | with a dependency selected, drag either dashed anchor handle to slide where the line touches that node's box around its perimeter; saved on release |
| bidirectional dependency | check "bidirectional" in the dependency editor — puts an arrowhead on both ends |
| clear selection | click empty background, or `new` in the relevant pane section |
| add dependency | pick from/to + a label + color, bottom-right of the right pane |
| export viewport | `export svg` downloads the current viewport as a standalone SVG; `export pdf` opens the browser print dialog on just the viewport — choose "Save as PDF"; `export png` downloads a print-ready 600 DPI, 17x11in (landscape tabloid) PNG — see below |
| export node list | `export csv` downloads a CSV of node names and dependencies — see below |
| import nodes | `import csv` bulk-adds nodes from a CSV file — see below |
| export project | `export project` downloads two round-trip CSVs (nodes + edges) — see below |
| import project | `import project` rebuilds nodes and dependencies from those two files — see below |
| delete all | `delete all` wipes every node and dependency in the project (confirmation prompt, cannot be undone) |
| annotate | `draw annotation` arms a crosshair tool — drag a rectangle anywhere on the canvas, then answer the color and note prompts — see below |

A hollow `○` in a node's corner means it's still at its auto-assigned spot. Shift+drag once and it's pinned.
Dependency lines bend procedurally (deterministic per-edge wobble) until you drag a control-point handle, at which point both handles freeze at absolute positions — same auto-vs-pinned split as nodes.
Each endpoint is independent of that: it stays aimed at the other node's center (sliding along the box as either node moves) until you drag its dashed anchor handle, at which point it freezes as an offset from its own node's center — so it keeps sliding correctly if you move that node afterward, just anchored to wherever you dropped it on the box instead of always facing the other node.

### Annotations

`draw annotation` (bottom of the right pane) arms the tool — cursor becomes
a crosshair, and the very next drag on the canvas (even over existing
nodes/edges) draws a chunky dashed rectangle. On release you're prompted
for a hex color and a note; answering both creates the annotation, and it
appears on the canvas immediately. The tool disarms itself after that one
rectangle, whether or not you go through with it — click `draw annotation`
again for the next one.

- Both prompts are plain `prompt()` dialogs, not the color-swatch picker
  used elsewhere in the app — there's no live preview and no format
  validation.
- Cancelling either prompt (or drawing a rectangle smaller than 20×20
  world units, which is treated as a misfire) discards the whole thing —
  nothing is saved.
- Annotations render behind nodes and edges, so they read as a background
  highlight rather than something that can occlude the diagram.
- Click an annotation's note text to delete it (confirmation prompt) —
  clicking the rectangle itself does nothing, only the text is a hit
  target, so a big annotation covering a lot of nodes doesn't get in the
  way of panning or clicking what's underneath it.
- `delete all` clears annotations too, alongside nodes and edges.

### Node/edge colors

Both the node and dependency editors offer one-click swatches for a fixed
palette; any hex value works, the swatches are just shortcuts:

| hex | swatch |
|---|---|
| `#33ff66` | phosphor green — default node color |
| `#8dff4d` | lime |
| `#ffd23f` | yellow |
| `#ff8a3d` | orange |
| `#ff5c4d` | red/coral |
| `#4dd6ff` | cyan |
| `#c78dff` | purple |
| `#9aa79f` | muted gray-green |

Dependency lines default to `#2fd85e` if left blank rather than falling back
to this palette.

### Export PNG (print-ready)

`export png` rasterizes the current viewport — same source as `export svg`
— onto a fixed 10200×6600px canvas (600 DPI at 17×11in, landscape tabloid)
and downloads it as `depmap-<timestamp>.png`. The viewport's own aspect
ratio is preserved: it's scaled to fit inside that page size and centered,
with any leftover margin filled in the canvas background color rather than
left transparent, so an unusually tall or wide viewport doesn't come out
stretched.

- This sets the *pixel dimensions* that correspond to 600 DPI at that page
  size — it doesn't embed a `pHYs` DPI chunk in the PNG file itself. Most
  print/image tools just need the right pixel count for a given output
  size, but if your workflow specifically reads embedded DPI metadata,
  say so and that chunk can be added.
- A canvas this large is memory-heavy (~270MB uncompressed) — reliable on
  a modern desktop browser, but don't expect it to work on constrained or
  mobile devices. If the browser refuses to produce the image at all, the
  toast will say so rather than downloading a blank/corrupt file.
- Frame the diagram the way you want it printed *before* exporting — pan
  and zoom set what "the current viewport" means, same as `export svg`/
  `export pdf`.

### Export node list (CSV)

`export csv` downloads `depmap-dependencies-<timestamp>.csv` — one row per
node, two columns:

    name,depends_on

`depends_on` packs that node's outgoing dependencies into one cell,
semicolon-separated (e.g. `mysql; auth-svc`), rather than one row per edge.
It's a reporting format, not a round-trip one — there's no `kind`/`color`/
`notes` column, and re-importing it won't recreate the dependency edges
(import only creates nodes, see below).

### Import nodes (CSV)

`import csv` opens a file picker for a CSV with a header row. `name` is the
only required column (case-insensitive); `kind`, `color`, `notes` are
optional and used if present — anything else is ignored.

Each row is placed exactly like a manually-added node: same auto-placement
(a column-major grid, 240 world units per cell, capped at 20 nodes per
column before wrapping to a new column, skipping any cell within 240 units
of an existing node). Rows are inserted one at a time rather than in
parallel, so each one sees the placements of the ones before it — avoids
two rows landing on the same spot.

Placement is also grouped by `color`: every distinct color currently in the
project gets an anchor point, evenly spaced around a circle sized so
neighboring colors are always far enough apart to avoid colliding, and each
color's grid block starts from its own anchor instead of the world origin.
So a CSV where every row of one group shares a hex value (e.g. all
`#33ff66`) and another group shares a different one (e.g. all `#4dd6ff`)
lands in two visually distinct sections of the canvas, each filling top to
bottom/left to right in CSV row order — no color column means everything
grids from the same origin, same as before.

- Blank names are skipped.
- Duplicate names are skipped, not merged — node names are unique (see
  [Notes / gotchas](#notes--gotchas)), so a row matching an existing node's
  name is rejected and the existing node is left untouched.
- Import only creates nodes — it doesn't read or create dependencies/edges.
- You get a single summary toast, `Imported N nodes, skipped M.` — it
  doesn't currently break out *why* each skipped row was skipped.

### Project export / import (CSV)

Unlike the plain export/import above, this is a full round trip: node
position and pin state survive, dependencies come along too, and so do
annotations. `export project` downloads three files at once:

    depmap-project-nodes-<timestamp>.csv         → name,kind,color,notes,x,y,pinned
    depmap-project-edges-<timestamp>.csv         → src_name,dst_name,label,color,bidirectional
    depmap-project-annotations-<timestamp>.csv   → x,y,width,height,color,note

Node IDs are deliberately left out — they won't be reused on import (a
re-imported project gets fresh IDs), so `name` is the stable key both the
node and edge files agree on. Edges reference nodes by name, not ID, for
the same reason. Annotations have no relationship to nodes at all, so their
file is just their raw columns.

`import project` opens a multi-file picker — select all three CSVs together
(or any subset). Each file is classified by its header rather than its
filename, so renaming them beforehand doesn't break anything:

- A row with a `name` column is treated as a node.
- A row with `src_name`/`dst_name` columns is treated as an edge.
- A row with `width`/`height` columns is treated as an annotation.
- Nodes are inserted first, one at a time (auto-placement reads existing
  positions per insert, and the name→id lookup edges depend on has to be
  fully populated before edges resolve). If a row has `x`/`y`, that exact
  position is restored instead of auto-placing — that's the whole point of
  a project restore. `pinned` isn't read back in as a flag; a restored
  position just is what it is.
- Edges resolve `src_name`/`dst_name` against nodes already in the project
  plus any just-created by the node file in the same import, so an
  edges-only re-import (no node file selected) still works as long as the
  nodes already exist.
- Edges whose src/dst name can't be resolved are skipped, same as
  duplicate edges (`src_id, dst_id, label` is a unique key).
- Annotation rows need valid numeric `x`/`y`/`width`/`height` or they're
  skipped; a blank `color` cell falls back to the default (`#ffd23f`)
  rather than importing as a literal empty color.
- One summary toast: `Imported N node(s), M dependency(ies), K
  annotation(s)`, plus a skipped count if anything was rejected.

**Given this fork's [storage model](#storage-model), `export project` is
also your backup/restore and cross-browser migration path** — there's no
database to fall back on.

### Delete all

`delete all` (bottom of the project export/import section) wipes every
node, edge, and annotation from `localStorage`. There's a confirmation
prompt first, and no undo.

## Notes / gotchas

- Node names are unique — a duplicate save returns a `Duplicate entry`
  error rather than silently making a second node (enforced client-side
  now, same rule the original MySQL unique key enforced server-side).
- Deleting a node cascades to its edges (ported from the original's FK
  `ON DELETE CASCADE` behavior).
- The app container has no host port published — it's only reachable from
  other containers on the compose network (nginx). Everything goes through
  the nginx proxy.
- Auto-placement uses a column-major grid (20 rows per column, 240 world
  units per cell), starting from a per-color anchor point (every distinct
  color currently in the project evenly spaced around a circle, sized so
  neighbors can't collide), and skips any cell within 240 world units of an
  existing node. It doesn't reflow when you drag things around — including
  if a new color's introduction later shifts where that color's anchor
  would be, already-placed nodes stay put. This logic is a straight port of
  the original server-side algorithm into `app.js`.
- See [Storage model](#storage-model) for what's different from depmap
  proper — this is the section that actually matters for this fork.
