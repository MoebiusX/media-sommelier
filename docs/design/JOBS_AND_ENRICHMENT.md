# Design Review — Background Jobs & Enrichment

Status: **active** · Scope: the `server2` background-job and online-enrichment subsystem · Audience: future maintainers.

This reviews how long-running operations (scan, organize, drive-sync, online refresh) are run and observed, identifies where the current pattern strains, and records the chosen direction. The **resumable-enrichment ledger** described in §5 is **implemented**; the **JobService** refactor in §4 is **proposed, not built**.

---

## 1. Requirements

**Functional** — run long operations triggered from the UI; report live progress; allow cancel; for enrichment, review-then-apply; survive a process restart without losing a 30-minute job or re-doing finished work.

**Non-functional (the assumptions that drive every decision):**
- **Single user, localhost.** The server binds `127.0.0.1` on purpose. No multi-tenant, no auth, no horizontal scale.
- Library scale **10K–100K tracks** (~1.6K–15K albums).
- External APIs are **hard rate-limited** — MusicBrainz is 1 req/s by ToS. We respect it; we don't engineer around it.
- **Zero extra infrastructure** — ships as a local tool / eventual Electron shell with a prebuilt `better-sqlite3`. No Redis, no broker.
- **Originals never mutated** (core invariant, already enforced).

**Constraints:** solo dev; synchronous SQLite; pure-TS engine; one large `server2/index.ts`.

## 2. Current state

```
browser ──/api──▶ vite proxy ──▶ server2 http(4178) ──▶ better-sqlite3 (WAL) + data/{covers,mb-cache,…}
   module-global singletons:
     scanJob   (inline IIFE)        organizeJob ── CHILD PROCESS (killable)   ← only this one isolated
     syncJob   (inline IIFE)        refreshJob  (inline IIFE)
   MusicBrainzClient (1.1s throttle, disk-cached HTTP)   fetchFrontCover (CAA)
```

Four jobs, four near-identical `{state,phase,done,total,result}` shapes, four `/status` endpoints, four "if running, reject" guards. Three run **inline on the event loop**; organize alone is a child process.

## 3. Pain points (ranked)

| # | Problem | Consequence |
|---|---|---|
| 1 | Job state is **ephemeral** (module globals) | A restart mid-job loses progress *and* the in-memory review queue. `tsx watch` reloads on every save in dev. |
| 2 | Enrichment sweep was **non-resumable** | Re-running re-walked all candidates; a crash at album 1,400 started over. **(fixed — §5)** |
| 3 | **No negative caching** for MusicBrainz no-match / CAA no-cover | Every sweep re-hit the network for hopeless albums. **(fixed — §5)** |
| 4 | CPU work (hashing in `executePlan`) on the main loop for sync | Competes with request serving; organize sidesteps this, sync doesn't. |
| 5 | Four copies of the job pattern | Every new long op re-implements singleton + poll + guard. |

Explicitly **not** problems: single-writer SQLite, lack of a queue broker, multi-node scale. Reaching for those would be wrong for a single-user local tool.

## 4. Proposed direction — durable in-process jobs on SQLite (NOT built yet)

A single `JobService`: one drain loop, a typed handler registry, and `jobs` / `job_items` tables so state and per-unit results survive a restart.

```
POST /api/jobs {type,params} ─▶ JobService ─┬─ enqueue → jobs table (state,cursor,result)
GET  /api/jobs/:id            ─▶            ├─ one drain loop, cancel flag, resume()
POST /api/jobs/:id/cancel     ─▶            └─ handler registry: scan · organize(child) · sync · refresh
```

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, type TEXT, params TEXT, state TEXT,
  phase TEXT, done INTEGER, total INTEGER, cursor TEXT, result TEXT, error TEXT,
  startedAt INTEGER, updatedAt INTEGER, finishedAt INTEGER
);
CREATE TABLE job_items (jobId TEXT, seq INTEGER, payload TEXT, PRIMARY KEY (jobId, seq));
```

Handler contract collapses the four copies into one shape:

```ts
interface JobHandler<P> {
  type: string;
  isolation?: 'inline' | 'child';   // hashing-heavy (sync/organize) → child; I/O-bound (scan/refresh) → inline
  run(ctx: { params: P; cursor?: string;
             progress(done, total, phase): void;
             emit(item): void;            // append to job_items (survives restart)
             checkpoint(cursor): void;
             cancelled(): boolean }): Promise<Result>;
}
```

On boot, orphaned `running` jobs → `paused`, offered for resume. `isolation:'child'` reuses the existing organize-worker pattern (spawn `tsx worker.ts`, stream JSON over stdout). **Recommended trigger to build this: the 5th long op (transcoding) — don't copy-paste a 5th singleton.**

## 5. Implemented — the enrichment ledger (resumable sweep)

The key realization: **the ledger IS the resume cursor.** A per-album record of "we tried this, here's the result" lets the sweep skip everything already attempted, with no separate cursor.

```sql
CREATE TABLE album_enrich (
  albumId TEXT PRIMARY KEY, attemptedAt INTEGER, matched INTEGER,
  mbid TEXT, rgMbid TEXT, matchArtist TEXT, matchAlbum TEXT, matchYear INTEGER, score REAL,
  coverState TEXT   -- 'found' | 'none' (Cover Art Archive negative cache) | NULL
);
```

- `cachedLookup()` returns the ledger decision unless `force`; only a miss hits MusicBrainz, then writes the row.
- `ensurePendingCover()` reuses the staged file, honours `coverState='none'`, else fetches CAA once and records the result.
- The sweep calls `enrichOne()` per candidate → cache hits are instant, no-match/no-cover albums never re-hit the network.

**Consequences (measured):**
- A cancelled or crashed sweep **resumes for free** — already-attempted albums are skipped on the next run.
- 2nd sweep over the same set: **3.1s → 0.5s**, `attemptedAt` unchanged (zero lookups), identical proposals.
- `force:true` (UI "Re-check all") ignores the ledger and re-attempts.
- `GET /api/refresh/candidates` exposes `{missing, attempted, total}` so the UI shows resume progress and the button reads "Resume".

Durability: `album_enrich` survives `clearAll` (re-ingest), keyed by the deterministic album slug, like `album_overrides`.

**Boundary — what the ledger does NOT fix:** the in-memory `refreshJob.proposals` review queue is still lost on a mid-review restart (pain #1). It's recoverable cheaply (re-running the sweep is now near-instant for attempted albums), but making the queue itself durable needs `job_items` from §4.

## 6. Scale & reliability (realistic)

- 100K tracks (~15K albums): ingest is the bound (cached tag reads). Ledger/jobs rows are negligible. SQLite single-writer is fine.
- **Sweep floor is MusicBrainz 1 req/s** — ~15K albums ≈ 4 hrs first pass. No architecture beats the rate limit, so the design optimizes for *never repeating it* (the ledger). Resumability makes the first pass survivable.
- Concurrency: one drain loop; at most one `child` (CPU) job + N I/O jobs. Don't run two hashing syncs at once.
- Recovery: orphaned-running → paused on boot; user resumes. That's the whole reliability story for a local app.

## 7. Trade-offs

| Option | Effort | Buys | Cost |
|---|---|---|---|
| Status quo + persist job state | S | "last run" after restart | sweep still non-resumable |
| **Ledger (done) + JobService (later)** ✅ | M | resume, history, one API, no re-sweeps | one new abstraction; ~a week for JobService |
| External queue (BullMQ/Redis) | L | "real" job infra | Redis dep + ops burden — **violates the zero-infra/local-first constraint** |

Chosen: the **ledger now** (highest value/effort, fixes the freshest pain), **JobService when the 5th job arrives**.

## 8. Revisit as it grows

- **Electron multi-window** → two renderers, one DB file; `better-sqlite3` is single-process, so centralize writes behind the main process (the server already is that). Flag before adding a second window.
- **Cloud / cross-device sync** → inverts the model (server2 becomes a sync client). Out of scope until a second device exists.
- **Pluggable enrichers** (Discogs, last.fm, default AcoustID) → slot behind an `EnrichmentService` boundary; design its interface when adding the second source.
- **Cover staleness policy** → with the ledger in place, "re-fetch covers older than N months" is a small addition.
