import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { run } from '@openai/agents';
import { createClubbyAgents } from './agents.js';
import { Workspace } from './workspace.js';

interface CliOptions {
  task: string;
  repo: string;
  write: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let repo = process.env.INIT_CWD ?? process.cwd();
  let write = false;
  const taskParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (arg === '--repo') {
      const value = argv[index + 1];
      if (!value) throw new Error('--repo requires a path.');
      repo = value;
      index += 1;
      continue;
    }
    taskParts.push(arg ?? '');
  }

  const task = taskParts.join(' ').trim();
  if (!task) {
    throw new Error('Provide a task, e.g. npm run agent -- --write "Polish the event details empty state"');
  }

  return { task, repo: path.resolve(repo), write };
}

async function saveRun(repo: string, payload: unknown): Promise<string> {
  const directory = path.join(repo, '.clubby-agents', 'runs');
  await fs.mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const file = path.join(directory, `${stamp}.json`);
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required. Keep it in your environment; do not commit it to the repository.');
  }

  const options = parseArgs(process.argv.slice(2));
  const workspace = new Workspace({ root: options.repo, writeEnabled: options.write });
  const { managerAgent } = createClubbyAgents(workspace);

  const startedAt = new Date().toISOString();
  const result = await run(managerAgent, options.task, { maxTurns: 30 });
  const finishedAt = new Date().toISOString();

  const output = result.finalOutput ?? {
    status: 'blocked',
    summary: 'The manager agent returned no final output.',
    filesChanged: [],
    qa: 'No QA result available.',
    followUps: [],
  };

  const logFile = await saveRun(options.repo, {
    startedAt,
    finishedAt,
    writeEnabled: options.write,
    task: options.task,
    output,
  });

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.stderr.write(`Run log: ${path.relative(options.repo, logFile)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
