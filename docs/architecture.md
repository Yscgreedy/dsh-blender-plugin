# Architecture

This is the single architecture guide for the DSH x Blender plugin. It explains the current system
shape, the boundaries that must stay stable, and the constraints that determine how changes are made.
Git history and the local refactor workspace keep older rationale outside the published repository.

## 1. System shape

The plugin is a DeepSeek Harness host plugin, not a standalone Blender add-on.

    DSH host
      -> src/ tools
      -> Gateway HTTP (127.0.0.1:39877)
      -> engine dispatch
      ^ WebSocket /addon (the addon dials out)
      -> Blender addon
      -> bpy

There are three logical processes and one inbound endpoint:

- the DSH host and the Gateway run in Node (the Gateway may be embedded in the host);
- the Blender addon runs inside Blender and dials the Gateway; it has no inbound listener;
- the addon is the only process that calls bpy;
- the Gateway owns jobs, leases, sessions, receipts, and routing;
- the host owns the model-facing tools and the headless/fallback policy.

The public model surface is 6 tools (blender_session, blender_op, blender_py, blender_see,
blender_run, blender_inspect), 38 planning families, 270 operations, 25 addon commands
(25 registered commands; the transport-only ping makes 26 wire commands), 29 HTTP routes, and
protocol 12. These counts are facts, not goals; changing one requires updating the catalog, lock,
tests, and migration notes in the same change.

## 2. Host plugin (src/)

src/index.ts is entry-only. It exports the plugin API (from src/plugin.ts) and the frame cache
helpers, and wires the host modules; it must not grow feature logic. Its export set is registered in
`config/facades.json` and enforced by `npm run check:no-shims` (see
[Public facades and the dual entry](#public-facades-and-the-dual-entry)). The rest of the tree is
split by responsibility:

- src/tools/: one model-facing tool per directory (registration, execution, presenter/receipt
  pieces) plus a shared session helper;
- src/host/: backend lifecycle and HTTP client;
- src/contracts/: typed contracts and schema helpers;
- src/ui/ and src/tui/: DSH UI cards and terminal behavior;
- src/plugin*.ts: plugin lifecycle and surfaces.

Host code uses strict TypeScript. Any value from the backend, addon, model, or user file system is
parsed at one boundary before it enters typed logic. Explicit any is not accepted in foundation files;
the remaining type-debt ledger must have an owner, reason, and expiry.

## 3. Backend runtime (runtime/, built to lib/)

The backend is strict TypeScript under runtime/. It is compiled with tsconfig.runtime.json into
lib/runtime/**/*.js. Published packages contain built JavaScript, not backend TypeScript sources.

Layout:

- runtime/foundation/: the leaf helpers both other runtime layers share — `json.ts`,
  `errors.ts`, `progress.ts`, `scripts.ts`, `layers.ts`, `evidence*.ts`, and the `output/`
  (parse/render) and `kernel/` (bootstrap/api) subtrees. A foundation module imports only the runtime
  roots (`config.ts`, `paths.ts`, `catalog/`, `contracts/`, `classes.ts`, `transport/`) — never
  `runtime/core/**` or `runtime/execution/**`, so the execution layer reaches these helpers without a
  reverse edge into core;
- runtime/core/: dispatch, engine, engine-api, sessions, queue and plan; queue argument construction
  lives in `queue/job-args.ts` and the process lifecycle in `queue/spawn-executor.ts`;
- runtime/embedded/: the Python preludes and templates embedded into Blender command lines (GPU
  setup, kernel path helpers, the `blender_py` act wrapper), kept as data modules so `paths.ts`
  stays inside its line budget;
- runtime/execution/: headless, jobs, workers (the hot headless kernel), recovery, and
  `input-paths.ts` (the submit-time input preflight shared by headless and jobs);
- runtime/http/: routes, lease, host views;
- runtime/gateway/: the Gateway process, addon WebSocket channel, ownership, and lifecycle;
- runtime/transport/: frames, sockets, protocol helpers;
- runtime/contracts/: the code-shared contract tables — the generated GUI routing table
  (`runtime/contracts/routes.generated.ts`, described in section 8), the route matching predicate
  (`runtime/contracts/route-match.ts`), and the headless local-lane name whitelist
  (`runtime/contracts/local-lane.ts`). `runtime/foundation/**`, `runtime/core/**` and
  `runtime/execution/**` all import from here, so no layer has to reach sideways into another for a
  shared table;
- contract data: `config/contracts.json` is the catalog <-> Python link layer (described in section 8);
- runtime/py/: the Blender-side Python library described below.

The runtime build precedes the host build because host modules import boundary helpers from the built
runtime. The Gateway entry used by GATEWAY_PATH is lib/runtime/gateway.js. Source maps are emitted so a
crash still points at a TypeScript line.

### Headless jobs and the kernel

`blender_run(kind="headless")` never runs a bare Python file. `runtime/core/queue/job-args.ts`
composes the same `KERNEL_BOOTSTRAP` the GUI path injects, then every `preload` module in its own
namespace, then the caller's script; `spawn-executor.ts` owns the child process, log capture,
timeout and cancellation. An inline script is appended to `job.py`; a `script_file` is
exec'd from that same script with `__file__` set back to the user's path (Blender gives every
`--python` file its own namespace, so two `--python` arguments would hide `K` from the second one).
`bootstrap:false` is the only opt-out. An unknown `preload` name fails at prepare time with
`job_prepare_failed` and the available module list, instead of raising `NameError` halfway through the
script. `args` accepts a string (POSIX-style split) or `string[]` and always appends the `--` separator;
`env` is merged into the child environment. Both are echoed in `result.provenance`
(`{args, env, env_keys, preloads, bootstrap}`), so "the parameter never arrived" is diagnosable from the
receipt alone.

Input paths are resolved and validated before anything is spawned. `runtime/execution/input-paths.ts`
tries every base in order (explicit `workdir`, then the caller's session workspace passed down as
`workspace`, then `DSH_BLENDER_WORKSPACE` / `DSH_WORKSPACE` / `DSH_PROJECT_DIR`, then the Gateway cwd)
and throws `input_missing` with the full `tried` list plus the labelled `bases` when the file is not
there. `script_file`, `file` (.blend) and the queue prelude all go through it, so a wrong relative path
costs no Blender start.

The session root itself comes from the calling execution, not from the environment:
`src/host/workspace.ts` reads the `workingDirectory` service (it follows a `cd`), then the Session
header cwd, then the workspace env vars, then `process.cwd()`. The host process cwd is the DSH profile
directory on a default install, and none of the three env vars is set there, so a relative path that
reaches only that last tier is reported as a fallback (`path_base: … （回落…）`) instead of silently
landing in the profile. The same root travels to the backend as `workspace`, so its own resolution
does not depend on the env tier either.

One host-side exception bypasses the GUI session gate: `blender_op(action="plan")` with an op from
the local whitelist (`audit_mesh`, `img_*`, `visualreport_report`, `qc_render_views`, `montage`) **and**
an explicit `args.file` **and** no ready GUI session submits a `kind="headless"` job through `POST /job`
(`catalog_op` / `op_args`) instead of failing with `session_required`. `headless=true` makes that same
submission even when a GUI session **is** ready, so concurrent agents do not have to share the single GUI
instance; `op="catalog", args={format:"json"}` exposes `needs_gui` / `headless` per op so an agent can
decide before calling. `src/tools/op/local.ts` resolves
the file, `runtime/execution/local-op/` turns the op name into a kernel call using the same generated
routing table, and the receipt is always `verdict=degraded` with a `job_id` until the result is collected.
Every other combination keeps the old rule: no session and no file is still a decision request, and no
Blender process is started.

Render jobs accept `channels:["render","alpha","mask","ink"]`. `runtime/execution/render-channels.ts`
appends one `--python-expr` postlude after `-a`; `runtime/py/render/channels_impl/metrics.py` (numpy, no
cv2) reports `foreground_px / coverage / n_components / bbox` per channel, and the job folds a single
`CHANNELS {json}` marker into the three-state verdict. A missing ink object is `skipped` and downgrades the
job to `degraded`, never `fail`; the command line is byte-identical when `channels` is absent.
`runtime/execution/render-device.ts` prepends the Cycles device/sample setup and prints one
`DSH_RENDER {json}` marker: `device=auto` tries OPTIX→CUDA→HIP→ONEAPI→METAL, enables only the chosen
backend's devices, and reports `applied{compute_device_type,devices_used,samples,fell_back_to_cpu,warnings}`.
A `//` output is resolved against the .blend directory before any directory is created; without a `file`
the tool rejects it in argument validation instead of letting `mkdir '//'` fail as EPERM.

### The hot headless kernel

`/worker` owns one long-lived `blender -b` process per name (`runtime/execution/workers/`, server in
`runtime/py/core/worker.py`). `exec` reuses it for Python, `see`/`watch` render offscreen frames in the
same process, and `checkpoint` / `revert` / `checkpoints` keep a file-level stack (`<dir>/NN_label.blend`
plus `index.json`) so "change one thing, look once" costs a file write instead of a ~2 s cold start.
`blender_run(action="worker")` is the model-facing surface; `blender_op(action="loop",
 target="session")` still uses the same pool for its inner loop.

Start and stop report terminal state, not a guess. A start registers its promise on the worker record,
so a concurrent or retried start joins that promise (`joined:true`) instead of killing a booting child
and racing for the same port; the route adds an explicit `ok:true` to the start/restart result because
a worker snapshot has no `ok` field of its own. Stop sends `shutdown`, waits for the real exit (polling
`exitCode`/`signalCode`, plus `exit`/`close`), escalates to SIGKILL only after the grace window, and
reports `stopped`/`alive`/`signaled` — so "still stopping" and "was not running" are distinct from
"failed". The tool layer's verdict comes from the response envelope, never from the snapshot.

### Session liveness and consent

`runtime/core/sessions/` keeps ownership, grants and presence. Two facts are deliberately separated:
a session record and a live addon. `attach` checks the live instance list and, on the HTTP path, pings
the addon (`attachChecked`), so a record whose Blender went away answers `addon_disconnected` /
`addon_unresponsive` instead of `ok`/`ready`; `status` reports `live:{instanceReady, readyInstances}` and
the registry remembers the last instance per caller (30 min) so a released record can still explain
itself. virtual-gui consent lives in `runtime/core/sessions/consent.ts` (one-time caller-bound tokens),
`consent-requests.ts` (persisted, human-approvable requests with a panel handle and in-process waiters)
and `consent-policy.ts` (auto / manual / deny, read per call from env, the profile key
`virtualGuiConsent`, then the config file, so an edit lands in ≤250 ms without a restart). Since
3.3.1 `start` files a request and **waits** (`wait_ms`, default 20 s) for the human: the Blender session
panel — a right-Sidebar tab type (`sidebar.right.pane.tab` + its own `…pane.tab.title`) opened from the
session header entry, with a one-line `Blender · N 待批准` chip left in `conversation.input.dock`
(`src/client/index.js`) — shows the card and `GET /lease?action=consent_approve&handle=…` releases that
same call (`consent_source=approved_request`). The panel also switches the policy through
`POST /lease {"action":"consent_policy_set"}`, which writes only `virtualGuiConsent` (with a `.bak`),
refuses DSH-attributed calls with 403 `consent_human_only`, and answers 409 `policy_locked` while the
env var pins the mode.
The terminal command (`requestId=`) stays as an equivalent channel; `/lease` accepts GET only for the
`consent_*` actions. Requests persist under `<workDir>/consent/`, so a Gateway restart (HMR) restores
the panel's cards instead of losing them. The panel is read-only plus approve/deny: it never spawns
anything, and the decision only releases a request the agent itself filed.
Since 3.5 the same tab also carries a read-only ops surface: one shared poll of `GET /host/state` +
`GET /health` + `GET /host/jobs` (idle 2.5 s, 1 s while a job or render is live), an on-demand
`GET /status` + `GET /doctor` (verdict, readiness, `next_actions`, `config` summary) and a per-job
`GET /host/jobs/log` tail. Those routes are memory-only on the Gateway; the panel adds no session
write path. Its two settings — backend override and poll interval — live in browser localStorage and
never touch ownership, grants or `virtualGuiConsent`.

Write authorization has one entry since the P0 decoupling. `runtime/http/session-gate.ts` exposes
`sessionWriteGate(payload, registry)`, and `gateway/app.ts` binds the session registry into
`leaseGate`. A host-attributed write with no registry fails closed (`session_unavailable`) instead of
falling through to the legacy lease; requests without caller headers keep the legacy path. Each write
route still declares its own skip predicate (read-only ops, `isolated`, `py` + caller), so changing a
skip rule still touches every write route — tracked as the remaining P1 item.

### Subagents, read-only borrowing, and stale owners

DSH gives a subagent its own `dshSessionId`, so strict `(hostId, dshSessionId)` ownership used to lock
every subagent out of the GUI (`session_in_use` on attach, `session_required` on py/see). The session
model now separates three rights:

- **family**: same host and either the same DSH session or a subagent whose `parentAgentId` is the
  owner's agent. The host does not always send `x-dsh-parent-agent-id`, so a same-host caller with
  same-host caller is viewer-eligible: it attaches as a **viewer** (presence only; ownership never
  moves; `is_mine` stays false)
  and may receive grants. A grant issued with only `target_agent_id` records the granting agent as
  the holder's parent and is matched by `hostId + agentId`; the write gate checks a covering grant
  **before** rejecting the owner mismatch, so `collection:_probe_x` really is enough to run
  `blender_py` there. A subagent never claims an unowned session (only a main agent does).
- **read-only borrow**: any caller on the same host sees the session in `list` with
  `owner` / `is_mine=false` / `borrowed=true`; `blender_see` and read-only ops work and every op
  receipt carries `source.owner` + `source.is_mine`. Writes still fail (`session_in_use`) unless the
  owner issues a grant.
- **owner reclaim**: owner records carry `role` and heartbeat age. A subagent owner is stale after 30 s;
  a main owner after **30 min** (it may wait a whole subagent round), and any authenticated call
  refreshes the heartbeat. `prune` clears a stale owner unless a live `blender_py` holds the session,
  and `release` accepts `force=true` from a same-host main agent. Status/list show
  `heartbeat_age_ms` + `stale_after_ms` and the exact reclaim command instead of an opaque wait.
  Owner expiry clears the claim but **keeps grants** (they have their own TTL): grants default to
  10 min, accept `ttl_ms` up to 1 h, renew on use, and `grants` no longer answers `session_in_use`
  for an owner=null session.

`blender_py` takes a declared `write_scope`; after execution the addon reports the objects it actually
changed (with collections) and the Gateway flags any object outside the grant as `scope_violation`.

### Public facades and the dual entry

The build has exactly two public facades, one per entry:

- `src/index.ts` is the host entry consumed by the DSH host: `name`, `inject`, `Config`, `apply`,
  `__internals`, `frameDedupe`, `resetFrameCache`;
- `runtime/engine.ts` is the backend runtime entry, compiled to `lib/runtime/engine.js`. It exposes
  only the consumed surface: `createEngine` plus the catalog tables and helpers, the class-guide
  helpers, flags, `PATH_GUARD`, `PLUGIN_VERSION`, and `engineProvenance`. Internal runtime, src, and
  test code imports implementation modules directly (`runtime/paths.ts`,
  `runtime/foundation/evidence.ts`, `runtime/transport/probes.ts`, ...); a facade copy that insulates nobody
  is dead code and is removed in the same change.

`config/facades.json` is the checked-in machine-readable inventory: each facade file, its exports, and
for each export the consumer files that use it. `npm run check:no-shims` enforces the registry: the
facade set is exactly the two files, every export is registered with at least one consumer file that
mentions it, an unregistered export fails the gate, a stale registration fails, wildcard exports are
rejected, and the retired list cannot come back. Curation is a review step, not script-generated:
grep the consumers, update the registry and the facade together.

Two entry paths share the same engine core. External scripts, tools, and tests import
`lib/runtime/engine.js` (check-parity, install-smoke, sync_counts, GUI probes, unit and integration
tests); `runtime/gateway/app.ts` imports the created engine and `engineProvenance` from source;
`runtime/catalog/logic.ts` runs the built facade in a child process to fingerprint it.
`engineProvenance` hashes the facade file on disk, so facade edits are observable, and `check:build` /
`ensure-build` keep `lib/runtime/engine.js` as a required artifact. check-parity declares public
surface removals in `DECLARED_ENGINE_REMOVALS`: a declared name that is still present in the current
facade fails, which is what makes the shrink auditable against the base commit.

Catalog *additions* are declared the same way: `DECLARED_CATALOG_ADDITION_3_1` takes the 3.1 `geo`
family from the built current catalog and splices it into the extracted base catalog source at the
index the current catalog uses, after asserting its op count. The fingerprint, the payload family
list, `ops_count` and `planOpNames()` therefore keep being compared strictly — a count delta is
never tolerated at a compare site, the addition itself is what gets reviewed.

### GUI sessions and presence

The Gateway keeps an in-memory session per attached GUI Blender instance: owner, caller agents,
scope grants, human pause, human edits, and presence. A session is best-effort state, not scene
data: it disappears on release or Gateway restart and is rebuilt from addon handshakes.

Presence rows hold each caller's display name, colour, view pose, selected `session_uid`s, activity,
and held scopes. On every view/selection update the Gateway pushes the current snapshot to the add-on
over the existing internal `execute_code` transport. `extension/dsh_blender_bridge/presence_draw.py`
installs `SpaceView3D` POST_VIEW/POST_PIXEL draw handlers that draw frusta, labels, and selection
boxes; it never writes scene data, selection, the camera, or the frame, and it does not move the
user's view. Session presence queries read the same rows from the Gateway, so a read-only query
and the viewport overlay cannot disagree.

## 4. Python domain library (runtime/py/)

Python code is grouped by domain, not by a flat file list:

- core: audit, contract, gate, motion, planner, txn, presets, runner, pipeline;
- geometry: geo, blockout, sculpt, mesh fix, surface, shapesolve, generator, UV tools;
- assembly: assembly, vehicle, human, clearance, mate;
- render: qc, qc_render, imgtools, material, visualreport, montage, calib;
- export: deliver, printcheck, open3d check.

runtime/py/modules.json is the only module registry. It maps public module names to domain and
implementation paths. runtime/paths.ts, offline_bootstrap.py, and the layout tests read that registry;
there is no second hand-written table and no flat runtime/<name>.py fallback.

Public facade modules keep the stable name at runtime/py/<domain>/<name>.py. They are small: they use
the shared runtime/py/_facade.py helper and re-export the implementation package. The implementation
lives in the sibling <name>_impl/ package. The public path, preload name, and K.dsh_<name>_api entry are
the contract; the facade is the stable entry, not a temporary shim.

Cross-domain capabilities go through kernel ports, not another domain's API object. `core/kit.py`
owns `K.dsh_ports` with `register_port` / `port_available` / `call_port` / `port_names`.
`render` registers `view_capture`, `export` registers `deliver_export` and `deliver_verify`, and
`core` registers `gate_run`; the consumers call the port, so the source-level domain graph stays
acyclic. Imports remain zero-cross-domain (enforced by the layout test), and `modules.json` is still
the only module registry.

## 5. Blender addon (extension/dsh_blender_bridge/)

The addon is a package, not a single file. Its modules cover protocol, command registration, selection,
recorders, assets, integrations, and UI. The release artifact is a deterministic zip built from that
package.

The addon version is 2.0.0 and protocol is 12; it installs only as a Blender extension. A
register/unregister round trip is part of the tests.
`extension/dsh_blender_bridge/command_registry.py` is the only command truth: 25 registered commands
plus the transport-only `ping` (26 wire commands). `get_addon_info` derives its handshake
capabilities from `command_registry.COMMAND_NAMES`, and the host catalog
(`runtime/catalog/commands.ts`) is parity-checked in both directions against it.
The launcher and plugin refuse an incompatible protocol and name the expected addon version. Existing
users migrate by removing the old single-file addon and installing the release zip; the backend and
protocol do not change during that migration.

Credentials have one owner: the add-on preferences. `config.get_credential` reads a process-local
session override (the Hyper3D free-trial button), then the preferences, then the `DSHBB_*` environment
variable with the legacy `BLENDERMCP_*` name as fallback. There is no Scene-property mirror: a saved
.blend cannot silently override the stored key, and the panels point at preferences instead of
rendering a second editor.

## 6. Build, package, and release

- npm run build regenerates the route tables from config/routing.json, then compiles runtime, host,
  and client.
- lib/ is generated and is not committed.
- prepack builds lib/; CI's check:build verifies the artifact.
- npm pack produces the published tarball: lib/, runtime Python, addon package, skills, docs, and tests.
- The extension zip is built from extension/dsh_blender_bridge/ and attached to the release.
- npm run smoke:install installs the tarball into a clean directory and checks that the entry loads,
  the Gateway starts from lib/runtime/gateway.js, and doctor returns kind=ok.
- Release is a separate, human-owned gate: the foundation can be complete before release is approved.

The package must never ship backend TypeScript sources, a committed lib/, a legacy single-file addon,
or a venv/node_modules tree.

## 7. Test layers

Three layers, with a different job each:

- Unit: Vitest and pytest, no Blender, no network, no real display. Host uses fake DSH/addon; Python
  uses fake bpy stubs for type checking and pure logic only.
- Integration: real backend HTTP and in-memory or fake addon; route, lease, job, and contract behavior.
- End-to-end: real Blender 4.2 LTS headless and GUI. The native runner loads modules inside Blender,
  resets the scene per test, writes JSON, and the host pytest launcher asserts the report.

Python static checks are part of the same quality surface: ruff over runtime/py, tests, and the addon,
plus a narrow pyright scope over pure-logic runtime modules. The pyright scope is explicit; it is not a
claim that all runtime Python is typed. There is no checked-in ruff baseline: every violation fails the
gate.

## 8. Quality gates and invariants

These are the rules that protect the architecture:

- 6 tools / 7 capabilities / 38 families / 270 ops / 25 addon commands / 29 routes / protocol 12 stay stable unless a
  declared migration changes them. The 25 addon commands are the registered dispatch surface; the
  transport-only ping is the 26th wire command.
- src/index.ts stays entry-only; production files stay under the line budgets enforced by
  check:structure.
- The public surface is two registered facades (`src/index.ts`, `runtime/engine.ts`) whose exports and
  consumers are inventoried in `config/facades.json`. `npm run check:no-shims` fails on an
  unregistered facade export, a stale registration, a wildcard export, or a retired file that
  reappears; other multi-statement re-export barrels need a `kind=single-line-reexport` exception.
- Functions target <=80 lines and never exceed 120. The 80-120 soft band is a registered debt
  ledger, not a warning: every band function has an entry in config/function-budget-allowlist.json
  with a classification, a real reason, the class owner, and a future reviewBy. npm run
  check:function-budget fails on an unregistered, unclassified, expired, or stale entry, and cannot
  waive a function over 120 lines; the classes are dispatch-table, linear-pipeline, generated-catalog,
  orchestration, formatting, validation, parsing, and integration-io (see [Exceptions](#exceptions)).
- runtime/py implementation files stay <=1,000 lines; TS and addon files stay <=600 lines. Path-level
  size exceptions live in config/exceptions.json (kind=file-budget, with reason/owner/reviewBy), apply
  to both budgets, and are checked by npm run check:exceptions; the plan catalog data table runtime/catalog/data.ts is the
  single registered one.
- Every Python module is in modules.json; there are no flat shims and no second registry.
- No explicit any in foundation host/runtime files; type debt is a ledger, not a whole-file exemption.
- Coverage floors are enforced by check:coverage; E2E scenario coverage is separate from line coverage.
- Every behavioral change needs a failing test first and evidence in the pull request.

### Comment conventions

New and changed file and module headers describe what the file is responsible for now, not the
refactor step that created it. New and changed source comments never cite T*/F*/B*/C* step IDs or
"split from"/"behavior frozen" narratives; when the split history is genuinely useful it is at most
one `History: split from <file> (<version>)` line. Pre-existing headers outside the files a change
touches are cleaned opportunistically when those files are next edited; a one-off baseline sweep is
allowed only when a change declares it explicitly (the terminal-state closeout did, in a
comment-only diff).
Behavior history belongs in [tests/BEHAVIOR_MATRIX.md](../tests/BEHAVIOR_MATRIX.md) and
[CHANGELOG.md](../CHANGELOG.md), not in the implementation comments. Plan IDs are still allowed
where they identify an accepted item in the plan-ID baseline, but they are identifiers, not file
history.

### Contract and routing sources

The op surface has two derived data sources; neither is hand-maintained inside the dispatch code:

- `config/routing.json` is the single GUI routing table (op prefix or exact alias, strip length,
  python api, preload, timeout, ensure hook). `scripts/gen-routes.mjs` renders
  `runtime/contracts/routes.generated.ts`, which starts with an AUTO-GENERATED header plus the
  source sha256. The host-side worker table was removed with the 3.1 worker plan channel: headless
  work belongs to `blender_run(kind="headless")`. `npm run build` regenerates the table and
  `npm run check:routes` fails when a generated file is missing, stale, or hand-edited. Generated
  tables are excluded from the size scanners and validated by `check:routes`.
- `config/contracts.json` is the catalog <-> Python link layer: family -> python api -> declared
  extraction of the literal dispatch table. `scripts/catalog_dispatch_keys.py` parses those tables
  with the Python ast module (no import, no bpy), and
  `tests/unit/js/contract/catalog-dispatch-parity.test.ts` fails when a catalog op has no python
  dispatch key. Host-side families (`host`), host-side ops inside a Python family (`hostOps`, each
  with a reason, for example `shape_search` before the dispatcher), aliases, and python-only keys
  (`pythonExtras`) are declared explicitly; the retired `catalogExtras` field fails the parity test,
  so an advertised-but-undispatchable op cannot pass as known drift.

`config/local-ops.json` is the single source for the headless local lane. `scripts/gen-local-ops.mjs`
renders `runtime/contracts/local-lane.ts` and `src/contracts/local-lane.ts`, and
`node scripts/check-local-ops.mjs` (part of `npm run lint`) fails when either copy is stale or
hand-edited. Two contract tests keep the consumers honest: `op-read-only-parity.test.ts` compares the
host read-only list with the catalog, and `route-consumers.test.ts` keeps every tool/host/headless/
client route literal inside `CONTRACT_ROUTES`.

### Exceptions

Exceptions are owned at two levels; an unowned, expired, or stale entry fails a gate.

`config/exceptions.json` is the path-level registry behind every known file exception in this guide.
Each entry has `id`, `kind`, `path`, `reason`, `owner`, and `reviewBy`; `npm run
check:exceptions` (part of `npm run lint`) rejects an unknown kind, a missing path, a duplicate id,
a reason shorter than 16 characters, and an expired `reviewBy`. Kinds: `file-budget`,
`function-budget`, `python-static`, `single-line-reexport`, `facade-export`, `doc-path`,
`matrix-row`, `python-private-import`. Seventeen entries exist today: five `file-budget` entries
(`runtime/catalog/data.ts`, `runtime/core/sessions/registry.ts`, `runtime/core/local-evidence.ts`,
and the two single-file Blender scripts `runtime/py/core/worker.py` and `runtime/py/render/view.py`);
`single-line-reexport` for `runtime/catalog/index.ts`, `src/host/runtime-bridge.ts`,
`src/headless/receipts/index.ts`, and `runtime/execution/local-op/index.ts` (the documented
src-to-lib bridge and three barrels); and eight `python-private-import` entries for the addon
command modules that reuse private `_polyhaven_*` / `_polypizza_*` helpers from
`integrations/*_client.py`.
`tests/unit/python/test_private_import_contract.py` scans the addon with `ast` for every
`_`-prefixed name imported from `integrations/*_client.py`, derives the expected count from
`config/exceptions.json`, and fails on an unregistered pair or a stale entry, so the registry and
the source tree cannot drift apart.
`facade-export` is reserved for the facade registry; `python-static` exists for future owned
static-check waivers but currently has no entries because the static gate has no checked-in baseline.
No `function-budget` entries are used: function-level debt is registered at the second level instead.

`config/doc-links-baseline.json` is the document-side exception list: it freezes seven historical
missing path refs (v2.3 host-contract and MIGRATIONS targets). While it accepts missing refs it must
carry `review: {owner, reviewBy, reason}`; `npm run check:doc-paths -- --enforce` fails on a missing,
empty, or expired review, so the frozen links stay owned instead of becoming a silent allowlist.

`config/function-budget-allowlist.json` is the function-level registry for the 80-120 line soft band.
Every band function has one entry keyed `file::name` with a `classification`, `reason`, class
`owner`, and future `reviewBy` (current ledger: 2027-06-30). Classes and their owners:
`dispatch-table` (runtime), `linear-pipeline` (runtime), `generated-catalog` (catalog),
`orchestration` (runtime), `formatting` (host), `validation` (qa), `parsing` (host),
`integration-io` (addon). `npm run check:function-budget` (also run by `npm run test:unit` and
`npm run test:contract`) fails when a band function is unregistered, its classification is unknown,
its owner differs from the class owner, its `reviewBy` has expired, or its entry went stale
(registered but no longer in the band). Functions over 120 lines always fail and cannot be waived.
`node scripts/check-function-budget.mjs --refresh` rewrites the ledger for the current tree, preserving
classified entries and adding new ones as `unclassified`; unclassified entries fail until a real role
and reason are written, so a refresh cannot silently re-bless debt. Design D11 chose registration over
splitting: the band is catalogued by class and no function was split, because none had an
independently cohesive part worth the churn.

### Addon serial queue and startup probes

The addon bridge serializes requests: `AddonClient` sends one request at a time and the next one waits
behind it, so an unawaited background request at the queue head delays every foreground caller by up
to its full timeout. Two places used to pay that tax: the host startup probe (an unawaited
`get_addon_info` with a 3s timeout issued right after connect) and a failed-call diagnose in
`lifecycle.installAddonSend` (about 2.5s, reused by /doctor instead of diagnosing twice).

Current rules: startup only awaits the socket connect (`addon.ensure()`); no informational request is
queued before the first real call. A failed request may attach one diagnosis, and /doctor reuses the
attached diagnosis. The budgets are therefore honest: `ADDON_STATUS_TIMEOUT_MS = 5000` for /status
and `ADDON_DOCTOR_STATUS_TIMEOUT_MS = 4000` for /doctor in `runtime/core/engine-api/doctor.ts`, with
the 12s viewport start budget in `src/constants.ts`. `tests/integration/js/doctor-bounded.test.ts`
pins the behavior: against a half-open addon both endpoints answer with addon attribution, and the
cold call is less than 2s slower than the warm call (measured 2026-11-05: cold/warm /status
7531/7528ms and /doctor 6540/6521ms; before the fix the cold call paid about 3s more:
8983/6026ms and 8495/5526ms). A new background request at the queue head must be avoided or deduped
with diagnose.

### Coverage policy

Coverage is measured with Vitest's single-file mode plus pytest branch coverage, and the gate reads
only `config/coverage-thresholds.json`. The floors were re-baselined on 2026-11-01 when
`@vitest/coverage-v8` moved from 3 to 5: the provider switched to AST-aware remapping, which changed
the measurement scale on the same tree (branch points 3934 -> 6567, executable lines 17819 -> 6294),
so the previous 73.2/68.7/70.4 floors were no longer comparable. Canonical CI run
[41315467806](https://github.com/sixtysevenlf/dsh-blender-plugin/actions/runs/41315467806) at commit
`8299acf` measured JS 71.91% lines / 55.99% branches / 69.5% functions and 67.698 changed lines
against v2.6.2 (7724 changed / 2495 missing). Applying the unchanged rule (round down to 0.1pp,
subtract 1.5pp) gives the current floors: lines 70.4, branches 54.4, functions 68, changed lines 66.1.
This is a documented policy change required by the measurement-tool upgrade; no tests or modules were
removed, and the previous "never below the prior floor" rule does not apply across a provider change.
Critical contract modules stay >=90/75; execution-module floors are unchanged except
`runtime/execution/headless/process.ts` branches 60 -> 55.6 (re-measured 57.14). Python pure logic is
82.5/74.36 with floors 80/70. Future ratchets use the next canonical CI run and the manual +2/PR
policy; a floor must not be lowered without a documented policy change in this guide.

## 9. Key choices and consequences

| Choice | Consequence |
|---|---|
| Strict TypeScript runtime compiled to lib/ | Type errors fail before tests; package ships JS, not backend TS; build is required before backend/E2E |
| Vitest + pytest + real-Blender harness | Fast inner loop; E2E stays on-demand/release because it needs Blender |
| Addon is a package plus a deterministic zip | Reviewable modules and stable install artifact; users must remove the old single-file addon |
| lib/ is generated, not committed | Review diffs stay clean; check:build and install smoke must verify the artifact |
| Python domains plus one modules.json registry | One place to add a module; no flat shims or duplicate path maps |
| Two registered public facades plus implementation packages | Stable host and runtime entry imports; every export needs a registered consumer, and an unregistered export fails check:no-shims |
| File, function, and coverage budgets | Reviewable size and measured debt; exceptions need owner, reason, and expiry |
| One routing table plus codegen; one catalog <-> Python link table | GUI and worker routes cannot drift from config/routing.json; check:routes rejects stale generated tables, and the parity test rejects undeclared dispatch drift |
| Kernel ports for cross-domain Python calls | The core can call view/deliver/gate capabilities without naming another domain's private API; the port name is the contract, and the layout test still enforces zero cross-domain imports |
| One write authority with a fail-closed registry | A host-attributed write does not slip through when the Gateway has no session registry; legacy no-caller clients keep the lease path, and per-route skip rules remain the one local decision point |

## 10. How to change safely

1. Read AGENTS.md for commands and hard rules.
2. For a boundary or contract change, update the code, the catalog/lock, the contract tests, and the
   migration notes together. Routing changes start in config/routing.json and regenerate through
   node scripts/gen-routes.mjs; catalog op changes must also update config/contracts.json. A
   cross-domain Python capability is registered as a port in `core/kit.py` (provider side) and called
   through `call_port` (consumer side); it must not take another domain's `K.dsh_*_api`.
3. Add or update a failing test before the behavior change. Keep unit tests free of Blender, display,
   network, and user profile dependencies.
4. Run the layer gates for what changed, then the full test and static gates. Run real-Blender E2E for
   addon, protocol, native runner, or bpy behavior changes.
5. If a size, coverage, or type exception is unavoidable, add an owned, expiring entry rather than a
   blanket ignore.
6. Keep release steps out of the foundation plan; release has its own checklist and human sign-off.

## 11. Narrative history

The refactor plan, the working spec, and the debt ledger are historical evidence and live outside git;
this repository documents behavior and the terminal state only. Plan-shaped IDs (D1, F2.3, S3, ...) are
no longer a maintained narrative: config/plan-ids.json carries the remaining exemptions, and
scripts/check-plan-ids.mjs is the ratchet that keeps new ones out.

The 2026-11 P0/P1-1a refactor moved the shared runtime helpers into `runtime/foundation/`, the shared
tables into `runtime/contracts/`, removed the last module-global write registry, and replaced the
view/deliver/gate cross-domain API calls with kernel ports. Current metrics, the coupling inventory and
the remaining roadmap live in [ARCHITECTURE.md](../ARCHITECTURE.md).

Two historical analyses are kept for traceability, not as current guidance:
[Procedura fusion analysis](Procedura-融合分析.md) (2026-09-17) and
[flash capability analysis](flash建模上限-整合方案.md). The OpenSpec change archive is the story going
forward.