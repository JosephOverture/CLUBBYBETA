module.exports = ({ config }) => {
  const web = process.env.EXPO_PUBLIC_WEB_URL;
  const api = process.env.EXPO_PUBLIC_API_URL;
  const production =
    process.env.EAS_BUILD_PROFILE === 'production' || process.env.CLUBBY_BUILD_ENV === 'production';
  if (
    production &&
    (!web ||
      !process.env.EXPO_PUBLIC_API_URL ||
      (process.env.EAS_BUILD_PROFILE === 'production' && !process.env.EAS_PROJECT_ID))
  )
    throw new Error('Production builds require website/API origins and the configured EAS project ID.');
  if (web && (new URL(web).protocol !== 'https:' || new URL(web).origin !== web))
    throw new Error('The associated website must be an HTTPS origin.');
  if (api) {
    const url = new URL(api);
    const local =
      !production && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== api || (url.protocol !== 'https:' && !local))
      throw new Error('The API must be an HTTPS origin; only development permits loopback HTTP.');
  }
  const merchant = process.env.EXPO_PUBLIC_APPLE_MERCHANT_ID;
  if (merchant && !/^merchant\.[A-Za-z0-9.-]+$/.test(merchant)) throw new Error('Invalid Apple merchant ID.');
  return {
    ...config,
    name: production ? 'Clubby' : 'Clubby Development',
    ios: {
      ...config.ios,
      ...(web ? { associatedDomains: [`applinks:${new URL(web).hostname}`] } : {}),
      infoPlist: { ...config.ios?.infoPlist, ITSAppUsesNonExemptEncryption: false },
      ...(merchant
        ? { entitlements: { ...config.ios?.entitlements, 'com.apple.developer.in-app-payments': [merchant] } }
        : {}),
    },
    extra: {
      ...config.extra,
      ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
    },
    plugins: config.plugins.map((plugin) =>
      Array.isArray(plugin) && plugin[0] === '@stripe/stripe-react-native'
        ? [plugin[0], { ...plugin[1], ...(merchant ? { merchantIdentifier: merchant } : {}) }]
        : plugin,
    ),
  };
};
