// Confirms the strength sweep really varied ConditioningSetMask.strength, and reports
// how different the resulting pictures actually are. A parameter that looks like it did
// nothing is either a no-op or a bug in the graph builder; this tells them apart.

import fs from 'node:fs';

const jobs = JSON.parse(fs.readFileSync('./pod-jobs-strength.json', 'utf8')).jobs;
const seen = new Map();
for (const job of jobs) {
    const group = job.name.split('/')[0];
    for (const node of Object.values(job.prompt)) {
        if (node.class_type !== 'ConditioningSetMask') continue;
        if (!seen.has(group)) seen.set(group, new Set());
        seen.get(group).add(node.inputs.strength);
    }
}
for (const [group, values] of seen) console.log(group, [...values].join(','));
