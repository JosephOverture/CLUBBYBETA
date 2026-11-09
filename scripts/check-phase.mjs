import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { milestones, releaseBlockers } = JSON.parse(await readFile(resolve(root, 'docs/acceptance/phases.json'), 'utf8'));
const requested = process.argv[2];
const release = process.argv.includes('--release');
if (process.argv.slice(3).some(arg => arg !== '--release') || (release && requested !== 'M8'))
  throw new Error('Use pnpm gate M0 through M8; --release is available only with M8.');
const index = milestones.findIndex(p => p.id === requested);
if (index < 0) throw new Error('Use pnpm gate M0 through M8.');
for (const phase of milestones.slice(0, index + 1)) {
  if (!['local-complete', 'complete'].includes(phase.status) || !phase.evidence.length || !phase.review) {
    throw new Error(`${phase.id} has not passed its implementation and review gate.`);
  }
  for (const path of phase.evidence) await access(resolve(root, path));
}
if (release && releaseBlockers.length)
  throw new Error(`Release blockers remain:\n${releaseBlockers.map(value => `- ${value}`).join('\n')}`);
console.log(`${requested}: recorded local evidence available. This checks the evidence register, not a deployment or a substitute for running tests.`);
if (requested === 'M8' && !release && releaseBlockers.length)
  console.log(`${releaseBlockers.length} external release gates remain; run pnpm gate M8 --release to inspect them.`);
