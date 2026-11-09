import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const required = [
  'ECS_CLUSTER',
  'ECS_SUBNETS',
  'ECS_SECURITY_GROUP',
  'BACKEND_IMAGE',
  'WEB_IMAGE',
  'RELEASE_REVISION',
  'API_SERVICE',
  'WORKER_SERVICE',
  'WEB_SERVICE',
  'MIGRATION_TASK',
  'PUBLIC_API_URL',
  'PUBLIC_WEB_URL',
  'SERVICE_DESIRED_COUNT',
];
for (const key of required) if (!process.env[key]) throw new Error(`Missing deployment setting: ${key}`);
if (!/^[a-f0-9]{40}$/.test(process.env.RELEASE_REVISION)) throw new Error('Invalid release revision.');
for (const key of ['BACKEND_IMAGE', 'WEB_IMAGE'])
  if (!/@sha256:[a-f0-9]{64}$/.test(process.env[key])) throw new Error('Image digests required.');
if (!['1', '2'].includes(process.env.SERVICE_DESIRED_COUNT))
  throw new Error('Use one staging or two production replicas.');
const directory = await mkdtemp(join(tmpdir(), 'clubby-deploy-'));
let fileNumber = 0;
async function aws(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', [...args, '--output', 'json', '--no-cli-pager'], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('AWS CLI unavailable.')));
    child.on('exit', (code) =>
      code === 0
        ? resolve(output.trim() ? JSON.parse(output) : {})
        : reject(new Error(`AWS operation failed: ${args.slice(0, 2).join(' ')}`)),
    );
  });
}
async function jsonFile(value) {
  const path = join(directory, `${fileNumber++}.json`);
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return `file://${path}`;
}
async function register(source, image) {
  const { taskDefinition } = await aws(['ecs', 'describe-task-definition', '--task-definition', source]);
  const allowed = [
    'family',
    'taskRoleArn',
    'executionRoleArn',
    'networkMode',
    'containerDefinitions',
    'volumes',
    'placementConstraints',
    'requiresCompatibilities',
    'cpu',
    'memory',
    'pidMode',
    'ipcMode',
    'proxyConfiguration',
    'inferenceAccelerators',
    'ephemeralStorage',
    'runtimePlatform',
  ];
  const input = Object.fromEntries(
    allowed.filter((k) => taskDefinition[k] !== undefined).map((k) => [k, taskDefinition[k]]),
  );
  if (input.containerDefinitions.length !== 1) throw new Error('Expected a single Clubby container.');
  const container = input.containerDefinitions[0];
  container.image = image;
  const revision = container.environment.find((v) => v.name === 'RELEASE_REVISION');
  if (revision) revision.value = process.env.RELEASE_REVISION;
  return (await aws(['ecs', 'register-task-definition', '--cli-input-json', await jsonFile(input)]))
    .taskDefinition.taskDefinitionArn;
}
const names = [process.env.API_SERVICE, process.env.WORKER_SERVICE, process.env.WEB_SERVICE];
let previous = [],
  changed = false;
try {
  const response = await aws([
    'ecs',
    'describe-services',
    '--cluster',
    process.env.ECS_CLUSTER,
    '--services',
    ...names,
  ]);
  if (response.failures?.length || response.services.length !== 3)
    throw new Error('Environment services are not provisioned.');
  previous = names.map((name) => {
    const service = response.services.find((s) => s.serviceName === name);
    if (!service) throw new Error('Unexpected service');
    return service;
  });
  const revisions = [];
  for (let i = 0; i < 3; i++)
    revisions.push(
      await register(previous[i].taskDefinition, i === 2 ? process.env.WEB_IMAGE : process.env.BACKEND_IMAGE),
    );
  const migration = await register(process.env.MIGRATION_TASK, process.env.BACKEND_IMAGE);
  const run = await aws([
    'ecs',
    'run-task',
    '--cluster',
    process.env.ECS_CLUSTER,
    '--task-definition',
    migration,
    '--launch-type',
    'FARGATE',
    '--network-configuration',
    JSON.stringify({
      awsvpcConfiguration: {
        subnets: process.env.ECS_SUBNETS.split(','),
        securityGroups: [process.env.ECS_SECURITY_GROUP],
        assignPublicIp: 'DISABLED',
      },
    }),
  ]);
  if (run.failures?.length || run.tasks?.length !== 1) throw new Error('Migration task could not start.');
  const task = run.tasks[0].taskArn;
  await aws(['ecs', 'wait', 'tasks-stopped', '--cluster', process.env.ECS_CLUSTER, '--tasks', task]);
  const stopped = (
    await aws(['ecs', 'describe-tasks', '--cluster', process.env.ECS_CLUSTER, '--tasks', task])
  ).tasks[0];
  if (stopped.containers?.length !== 1 || stopped.containers[0].exitCode !== 0)
    throw new Error('Migration failed; services were not updated.');
  changed = true;
  for (let i = 0; i < 3; i++)
    await aws([
      'ecs',
      'update-service',
      '--cluster',
      process.env.ECS_CLUSTER,
      '--service',
      names[i],
      '--task-definition',
      revisions[i],
      '--desired-count',
      process.env.SERVICE_DESIRED_COUNT,
    ]);
  await aws(['ecs', 'wait', 'services-stable', '--cluster', process.env.ECS_CLUSTER, '--services', ...names]);
  const live = (
    await aws(['ecs', 'describe-services', '--cluster', process.env.ECS_CLUSTER, '--services', ...names])
  ).services;
  for (let i = 0; i < 3; i++)
    if (live.find((s) => s.serviceName === names[i])?.taskDefinition !== revisions[i])
      throw new Error('A service rolled back or did not adopt the candidate artifact.');
  for (const origin of [process.env.PUBLIC_API_URL, process.env.PUBLIC_WEB_URL]) {
    if (new URL(origin).protocol !== 'https:') throw new Error('Public smoke tests require HTTPS.');
    const health = await fetch(origin + '/health/ready', {
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!health.ok || (await health.json()).status !== 'ready')
      throw new Error('Public readiness smoke failed.');
  }
  console.log(
    JSON.stringify({
      event: 'deployment.verified',
      revision: process.env.RELEASE_REVISION,
      taskDefinitions: revisions,
    }),
  );
} catch (error) {
  if (changed) {
    let rollbackFailed = false;
    for (const service of previous)
      try {
        await aws([
          'ecs',
          'update-service',
          '--cluster',
          process.env.ECS_CLUSTER,
          '--service',
          service.serviceName,
          '--task-definition',
          service.taskDefinition,
          '--desired-count',
          String(service.desiredCount),
        ]);
      } catch {
        rollbackFailed = true;
      }
    console.error(
      rollbackFailed
        ? 'Rollback needs operator intervention.'
        : 'Previous task definitions restored; monitor service stability. No database downgrade was attempted.',
    );
  }
  throw error;
} finally {
  await rm(directory, { recursive: true, force: true });
}
