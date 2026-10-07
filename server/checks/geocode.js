// Turns the address the customer typed into a map location, so nobody ever has to enter lat/lng.
// Returns { lat, lng, label, precision: 'exact' | 'area' } or null if it can't be found.
import { config } from '../config.js';

export async function geocode({ full, area, city, pincode }) {
  try {
    if (config.geocoder === 'none') return null;
    if (config.geocoder === 'google') return await google(full, pincode);
    return await nominatim(full, [area, city, pincode].filter(Boolean).join(', '));
  } catch (err) {
    console.error('[geocode]', err.message);
    return null; // never block the customer; scoring routes it to review instead
  }
}

async function google(address, pincode) {
  const params = new URLSearchParams({ address, region: 'in', key: config.googleMapsApiKey });
  params.set('components', pincode ? `country:IN|postal_code:${pincode}` : 'country:IN');
  const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, { signal: AbortSignal.timeout(8000) });
  const json = await res.json();
  const r = json.results?.[0];
  if (!r) return null;
  return {
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    label: r.formatted_address,
    precision: ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(r.geometry.location_type) ? 'exact' : 'area',
  };
}

// OpenStreetMap Nominatim: free, no key, max ~1 request/second. Fine for a pilot; use Google/MapmyIndia at scale.
async function nominatim(fullAddress, areaQuery) {
  const search = async (q) => {
    const params = new URLSearchParams({ q, format: 'jsonv2', countrycodes: 'in', limit: '1', addressdetails: '0' });
    if (config.nominatimEmail) params.set('email', config.nominatimEmail);
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'user-agent': `Loans24AddressVerification/1.0 (${config.publicBaseUrl})` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    return (await res.json())[0];
  };
  let hit = await search(fullAddress);
  let precise = Boolean(hit);
  if (!hit && areaQuery) { hit = await search(areaQuery); precise = false; }
  if (!hit) return null;
  const exactTypes = ['house', 'building', 'apartments', 'residential', 'commercial', 'shop', 'office'];
  return {
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    label: hit.display_name,
    precision: precise && exactTypes.includes(hit.addresstype || hit.type) ? 'exact' : 'area',
  };
}
