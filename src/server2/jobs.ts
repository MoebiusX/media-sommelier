/**
 * JobService — durable, restart-survivable background jobs on SQLite.
 *
 * Replaces the ad-hoc module-global singletons (scanJob/syncJob/refreshJob) with one runtime:
 *   - every job is a row in `jobs`; per-unit results (e.g. refresh proposals) are rows in `job_items`.
 *   - a typed handler registry; one job per type may run at a time (matches the old single-in-flight guard).
 *   - live progress is held in memory and persisted (throttled) so reads are cheap and current.
 *   - boot recovery: any job left `running` by a previous process is marked `paused` on startup, so a
 *     restart never shows a phantom-running job and the gathered `job_items` (the review queue) survive.
 *
 * See docs/design/JOBS_AND_ENRICHMENT.md.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type JobState = 'running' | 'paused' | 'done' | 'error' | 'cancelled';

export interface JobRecord {
  id: string;
  type: string;
  params: unknown;
  state: JobState;
  phase: string;
  done: number;
  total: number;
  cursor: string | null;
  result: unknown;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface JobCtx<P = unknown> {
  params: P;
  /** Resume point persisted by a previous run of this job id (unused by current handlers; reserved). */
  cursor?: string;
  progress(done: number, total: number, phase?: string): void;
  /** Append a durable per-unit result (survives a restart). */
  emit(item: unknown): void;
  checkpoint(cursor: string): void;
  cancelled(): boolean;
  /** Register cleanup to run the moment the job is cancelled (e.g. kill a child process). */
  onCancel(cb: () => void): void;
}

type Handler = (ctx: JobCtx) => Promise<unknown>;

export class JobService {
  private handlers = new Map<string, Handler>();
  private live = new Map<string, JobRecord>(); // running + just-finished, for live reads
  private cancelled = new Set<string>();
  private cancelCbs = new Map<string, () => void>();
  private lastPersist = new Map<string, number>();

  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id        TEXT PRIMARY KEY,
        type      TEXT    NOT NULL,
        params    TEXT    NOT NULL,
        state     TEXT    NOT NULL,
        phase     TEXT    NOT NULL DEFAULT '',
        done      INTEGER NOT NULL DEFAULT 0,
        total     INTEGER NOT NULL DEFAULT 0,
        cursor    TEXT,
        result    TEXT,
        error     TEXT,
        startedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        finishedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS job_items (
        jobId   TEXT    NOT NULL,
        seq     INTEGER NOT NULL,
        payload TEXT    NOT NULL,
        PRIMARY KEY (jobId, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_type_updated ON jobs(type, updatedAt DESC);
    `);
    // boot recovery: a job still 'running' belongs to a dead process — it's orphaned, not active.
    db.prepare(`UPDATE jobs SET state='paused', updatedAt=@now, finishedAt=@now WHERE state='running'`).run({ now: Date.now() });
  }

  register(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  private runningOf(type: string): JobRecord | undefined {
    for (const r of this.live.values()) if (r.type === type && r.state === 'running') return r;
    return undefined;
  }

  /** Start a job. If one of this type is already running, returns it instead of starting a second. */
  enqueue(type: string, params: unknown): JobRecord {
    const existing = this.runningOf(type);
    if (existing) return existing;
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`no handler registered for job type "${type}"`);
    const now = Date.now();
    const rec: JobRecord = {
      id: randomUUID(),
      type,
      params,
      state: 'running',
      phase: '',
      done: 0,
      total: 0,
      cursor: null,
      result: null,
      error: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.live.set(rec.id, rec);
    this.persist(rec);
    void this.run(rec, handler);
    return rec;
  }

  private async run(rec: JobRecord, handler: Handler): Promise<void> {
    let seq = 0;
    const ctx: JobCtx = {
      params: rec.params,
      ...(rec.cursor != null ? { cursor: rec.cursor } : {}),
      progress: (done, total, phase) => {
        rec.done = done;
        rec.total = total;
        if (phase != null) rec.phase = phase;
        rec.updatedAt = Date.now();
        this.maybePersist(rec);
      },
      emit: (item) => {
        this.db.prepare('INSERT INTO job_items(jobId,seq,payload) VALUES(?,?,?)').run(rec.id, seq++, JSON.stringify(item));
      },
      checkpoint: (cursor) => {
        rec.cursor = cursor;
        this.persist(rec);
      },
      cancelled: () => this.cancelled.has(rec.id),
      onCancel: (cb) => this.cancelCbs.set(rec.id, cb),
    };
    try {
      const result = await handler(ctx);
      rec.state = this.cancelled.has(rec.id) ? 'cancelled' : 'done';
      rec.phase = rec.state === 'cancelled' ? 'cancelled' : 'done';
      rec.result = result ?? null;
    } catch (e) {
      rec.state = 'error';
      rec.error = e instanceof Error ? e.message : String(e);
    } finally {
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      this.persist(rec);
      this.cancelled.delete(rec.id);
      this.cancelCbs.delete(rec.id);
    }
  }

  /** Signal a job to stop; runs its onCancel hook immediately (poll-based handlers see cancelled()). */
  cancel(id: string): boolean {
    const rec = this.live.get(id);
    if (!rec || rec.state !== 'running') return false;
    this.cancelled.add(id);
    const cb = this.cancelCbs.get(id);
    if (cb) {
      try {
        cb();
      } catch {
        /* best-effort */
      }
    }
    return true;
  }

  /** Cancel the running job of a type (back-compat for endpoints that cancel without an id). */
  cancelType(type: string): boolean {
    const r = this.runningOf(type);
    return r ? this.cancel(r.id) : false;
  }

  get(id: string): JobRecord | undefined {
    return this.live.get(id) ?? this.fromDb(id);
  }

  /** Most-recent job of a type (running wins), for the back-compat `/status` endpoints. */
  latest(type: string): JobRecord | undefined {
    return this.runningOf(type) ?? this.fromDbLatest(type);
  }

  items(id: string, since = 0): unknown[] {
    const rows = this.db.prepare('SELECT payload FROM job_items WHERE jobId=? AND seq>=? ORDER BY seq').all(id, since) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload));
  }

  /** All currently-running jobs (in-memory truth). */
  active(): JobRecord[] {
    return [...this.live.values()].filter((r) => r.state === 'running');
  }

  /* ---- persistence ---- */
  private persist(rec: JobRecord): void {
    this.db
      .prepare(
        `INSERT INTO jobs(id,type,params,state,phase,done,total,cursor,result,error,startedAt,updatedAt,finishedAt)
         VALUES(@id,@type,@params,@state,@phase,@done,@total,@cursor,@result,@error,@startedAt,@updatedAt,@finishedAt)
         ON CONFLICT(id) DO UPDATE SET
           state=@state, phase=@phase, done=@done, total=@total, cursor=@cursor,
           result=@result, error=@error, updatedAt=@updatedAt, finishedAt=@finishedAt`,
      )
      .run({
        ...rec,
        params: JSON.stringify(rec.params),
        result: rec.result == null ? null : JSON.stringify(rec.result),
      });
    this.lastPersist.set(rec.id, rec.updatedAt);
  }
  private maybePersist(rec: JobRecord): void {
    if (rec.updatedAt - (this.lastPersist.get(rec.id) ?? 0) >= 500) this.persist(rec);
  }
  private deser(row: Record<string, unknown>): JobRecord {
    return {
      ...(row as unknown as JobRecord),
      params: JSON.parse(String(row.params)),
      result: row.result != null ? JSON.parse(String(row.result)) : null,
    };
  }
  private fromDb(id: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.deser(row) : undefined;
  }
  private fromDbLatest(type: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE type=? ORDER BY updatedAt DESC LIMIT 1').get(type) as Record<string, unknown> | undefined;
    return row ? this.deser(row) : undefined;
  }
}
