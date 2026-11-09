/** Presentation models. Map authoritative API DTOs at the repository boundary. */
export interface Venue {
  id: string; name: string; cityId: string; description: string;
  timezone: string; version: number; commercialMode: 'external';
  externalUrl: string; sourceUrl: string; verifiedAt: string; calendarUrl?: string;
  latitude?: number | null; longitude?: number | null; address: string;
  coordinateAccuracy: 'official-map' | 'approximate';
  category: 'Clubs' | 'Bars & rooftops' | 'Live music'; neighbourhood: string;
  genres: string[]; image: string; tagline: string;
}
export interface NightPlan {
  id: string; venueId: string; name: string; date: string; note: string;
  status: 'personal'; createdAt: string;
}
export interface ClubbyConfig {
  dataMode: 'catalogue' | 'api'; apiBaseUrl: string; cityId: string;
  googleMapsApiKey: string; googleMapsMapId: string;
  locale: string; timezone: string;
}
/** Server records are scoped to an anonymous HttpOnly browser session, not a registered account. */
export interface PersonalState {
  saved: string[]; plans: NightPlan[]; profile: { name: string; theme: 'dark' | 'light' };
}
/** Future integration must use authenticated, server-authoritative availability. */
export interface TableAvailabilityDTO {
 data: {
  layoutId: string; currency: string; timezone: string;
  content: {name: string; zones: {id: string; label: string}[];
    tables: {id: string; label: string; zoneId: string; seats: number; x: number; y: number; width: number; height: number; rotation: number; shape: 'circle'|'rectangle'}[]};
  offers: {id: string; tableId: string; version: number; available: boolean; minimumSpendMinor: number; fullPriceMinor: number; depositMinor: number|null; inclusions: string; minGuests: number; maxGuests: number; slotStartsAt: string; slotEndsAt: string; terms: string}[];
 };
}
