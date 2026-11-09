const port =
  process.env.SERVICE_KIND === 'worker'
    ? (process.env.WORKER_HEALTH_PORT ?? '4101')
    : (process.env.PORT ?? '4100');
try {
  const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
