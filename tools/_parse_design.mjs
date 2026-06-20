import { readFileSync } from 'node:fs';
const f = process.argv[2];
const wrapper = JSON.parse(readFileSync(f, 'utf8'));
const data = wrapper.result || wrapper;
const out = [];
const L = (s='') => out.push(s);

L('# ============ FACETS (condensed) ============');
for (const { key, design: d } of data.facets) {
  if (!d) { L(`\n## [${key}] (no design)`); continue; }
  L(`\n## [${key}] ${d.facet}`);
  L(`SUMMARY: ${d.summary}`);
  L(`RECO: ${d.recommendation}`);
  if (d.decisions?.length) { L('DECISIONS:'); d.decisions.forEach(x => L(`  - ${x.decision} => ${x.choice}`)); }
  if (d.algorithms?.length) { L('ALGORITHMS:'); d.algorithms.forEach(x => L(`  - ${x.name}: ${x.approach}`)); }
  if (d.libraries?.length) L('LIBS: ' + d.libraries.map(x => x.name).join(', '));
  if (d.risks?.length) { L('RISKS:'); d.risks.forEach(x => L(`  - [${x.severity}] ${x.risk} -> ${x.mitigation}`)); }
  if (d.milestones?.length) { L('MILESTONES:'); d.milestones.forEach(x => L(`  - ${x.phase}: ${x.deliverables}`)); }
}

L('\n\n# ============ SYNTHESIS ============');
const s = data.synthesis || {};
for (const [k, v] of Object.entries(s)) {
  L(`\n## ${k}`);
  L(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}

L('\n\n# ============ REVIEWS ============');
for (const r of (data.reviews || [])) {
  if (!r) continue;
  L(`\n## LENS: ${r.lens}`);
  L(`VERDICT: ${r.verdict}`);
  if (r.findings?.length) { L('FINDINGS:'); r.findings.forEach(x => L(`  - [${x.severity}] ${x.issue}\n      FIX: ${x.recommendation}`)); }
  if (r.missing?.length) { L('MISSING:'); r.missing.forEach(x => L(`  - ${x}`)); }
}

console.log(out.join('\n'));
