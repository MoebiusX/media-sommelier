import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { JobService } from '../src/server2/jobs.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until a job leaves the 'running' state (handlers run async). */
async function settle(jobs: JobService, id: string, ms = 2000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const j = jobs.get(id);
    if (j && j.state !== 'running') return;
    if (Date.now() - t0 > ms) throw new Error(`job ${id} did not settle`);
    await sleep(5);
  }
}

describe('JobService', () => {
  it('runs a handler: progress, emitted items and the result all persist', async () => {
    const db = new Database(':memory:');
    const jobs = new JobService(db);
    jobs.register('demo', async (ctx) => {
      ctx.progress(0, 3, 'working');
      for (let i = 1; i <= 3; i++) {
        ctx.emit({ n: i });
        ctx.progress(i, 3, 'working');
      }
      return { done: 3 };
    });

    const rec = jobs.enqueue('demo', { x: 1 });
    await settle(jobs, rec.id);

    const j = jobs.get(rec.id)!;
    expect(j.state).toBe('done');
    expect(j.done).toBe(3);
    expect(j.total).toBe(3);
    expect(j.result).toEqual({ done: 3 });
    expect(jobs.items(rec.id)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    // and it landed in the jobs table (survives a restart)
    const row = db.prepare('SELECT state, type FROM jobs WHERE id=?').get(rec.id) as { state: string; type: string };
    expect(row).toEqual({ state: 'done', type: 'demo' });
    db.close();
  });

  it('runs one job per type at a time — enqueue returns the running job', async () => {
    const db = new Database(':memory:');
    const jobs = new JobService(db);
    let release!: () => void;
    jobs.register('slow', () => new Promise<void>((r) => (release = r)));

    const a = jobs.enqueue('slow', {});
    const b = jobs.enqueue('slow', {});
    expect(b.id).toBe(a.id); // no second job started
    expect(jobs.active().length).toBe(1);

    release();
    await settle(jobs, a.id);
    expect(jobs.active().length).toBe(0);
    db.close();
  });

  it('cancel stops a polling handler and marks it cancelled', async () => {
    const db = new Database(':memory:');
    const jobs = new JobService(db);
    jobs.register('loop', async (ctx) => {
      for (let i = 0; i < 1000; i++) {
        if (ctx.cancelled()) break;
        await sleep(5);
      }
      return { stopped: true };
    });

    const rec = jobs.enqueue('loop', {});
    await sleep(25);
    expect(jobs.cancel(rec.id)).toBe(true);
    await settle(jobs, rec.id);
    expect(jobs.get(rec.id)!.state).toBe('cancelled');
    db.close();
  });

  it('cancel runs the onCancel hook (for child-process jobs)', async () => {
    const db = new Database(':memory:');
    const jobs = new JobService(db);
    let killed = false;
    jobs.register('child', (ctx) =>
      new Promise<void>((resolve) => {
        ctx.onCancel(() => {
          killed = true;
          resolve();
        });
      }),
    );
    const rec = jobs.enqueue('child', {});
    await sleep(10);
    jobs.cancel(rec.id);
    await settle(jobs, rec.id);
    expect(killed).toBe(true);
    db.close();
  });

  it('a thrown handler → state error with the message', async () => {
    const db = new Database(':memory:');
    const jobs = new JobService(db);
    jobs.register('boom', async () => {
      throw new Error('kaboom');
    });
    const rec = jobs.enqueue('boom', {});
    await settle(jobs, rec.id);
    const j = jobs.get(rec.id)!;
    expect(j.state).toBe('error');
    expect(j.error).toContain('kaboom');
    db.close();
  });

  it('boot recovery marks orphaned running jobs paused, keeping their items', async () => {
    const db = new Database(':memory:');
    new JobService(db); // creates the schema
    // simulate a job left 'running' by a process that died mid-run
    db.prepare(
      "INSERT INTO jobs(id,type,params,state,phase,done,total,startedAt,updatedAt) VALUES('orphan','demo','{}','running','x',2,5,0,0)",
    ).run();
    db.prepare("INSERT INTO job_items(jobId,seq,payload) VALUES('orphan',0,'{\"k\":1}')").run();

    const restarted = new JobService(db); // a "restart" over the same db
    const j = restarted.get('orphan')!;
    expect(j.state).toBe('paused'); // no phantom-running job
    expect(restarted.items('orphan')).toEqual([{ k: 1 }]); // review queue survives
    db.close();
  });
});
