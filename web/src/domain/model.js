export function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
export function safeURL(value) { try {const u=new URL(value); return u.protocol==='https:'&&!u.username&&!u.password ? u.href : '#';} catch {return '#';} }
export function filterVenues(venues, {query='',category='All places',genre='All vibes',neighbourhood='All areas',saved=null}={}) {
  const words=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return venues.filter(v => (!saved || saved.includes(v.id)) && (category==='All places'||v.category===category) && (genre==='All vibes'||v.genres.includes(genre)) && (neighbourhood==='All areas'||v.neighbourhood===neighbourhood) && words.every(w=>`${v.name} ${v.neighbourhood} ${v.address} ${v.category} ${v.genres.join(' ')} ${v.description}`.toLowerCase().includes(w)));
}
export function directionsURL(v) { return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${v.name}, ${v.address}, Milano, Italy`)}&travelmode=transit`; }
export function normalizeVenue(v) {
  if(!v||typeof v.id!=='string'||!/^[-a-z0-9]+$/.test(v.id)||typeof v.name!=='string')throw new Error('Invalid venue response');
  if(safeURL(v.externalUrl)==='#')throw new Error('Every venue needs a valid official HTTPS link.');
  const image=typeof v.image==='string'&&(/^assets\/[a-z0-9-]+\.svg$/.test(v.image)||safeURL(v.image)!=='#')?v.image:'assets/nightlife.svg';
  return {...v,description:v.description||'',genres:Array.isArray(v.genres)?v.genres:[],category:v.category||'Clubs',neighbourhood:v.neighbourhood||'Milan',image,externalUrl:safeURL(v.externalUrl),sourceUrl:safeURL(v.sourceUrl||v.externalUrl),calendarUrl:v.calendarUrl?safeURL(v.calendarUrl):null};
}
