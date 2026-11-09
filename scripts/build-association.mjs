import { mkdir, writeFile } from 'node:fs/promises';
const team = process.env.APPLE_TEAM_ID;
if (team) {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error('Invalid Apple team ID.');
  const origin = new URL(process.env.EXPO_PUBLIC_WEB_URL);
  if (origin.protocol !== 'https:') throw new Error('Universal Links require HTTPS.');
  const directory = 'apps/mobile/dist/web/.well-known';
  await mkdir(directory, { recursive: true });
  await writeFile(
    directory + '/apple-app-site-association',
    JSON.stringify({
      applinks: {
        details: [
          {
            appIDs: [`${team}.com.clubby.app`],
            components: [
              { '/': '/bookings/*' },
              { '/': '/tickets/*' },
              { '/': '/groups/*' },
              { '/': '/support/*' },
            ],
          },
        ],
      },
    }),
  );
} else console.log('Apple association omitted: Apple Developer team is not configured.');
