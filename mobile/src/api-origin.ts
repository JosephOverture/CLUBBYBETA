export function resolveApiOrigin(configured: string | undefined, webHostname?: string) {
  if (configured) return configured;
  // Local web cookies must stay on the same site as the frontend. Production always uses an explicit origin.
  if (webHostname === 'localhost' || webHostname === '127.0.0.1') return `http://${webHostname}:4100`;
  return 'http://127.0.0.1:4100';
}
