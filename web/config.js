// Public browser configuration. Never put private credentials here.
// A Google Maps browser key must be restricted by HTTP referrer and API.
window.CLUBBY_CONFIG = Object.freeze({
  // Use 'catalogue' only for an explicitly offline preview with browser storage.
  dataMode: 'api',
  // Empty means the same origin that serves this web app.
  apiBaseUrl: '',
  googleMapsApiKey: '',
  googleMapsMapId: 'DEMO_MAP_ID',
  cityId: 'milano',
  locale: 'en-GB',
  timezone: 'Europe/Rome'
});
