// WGS84 conversions in double precision, independent of the renderer so they
// can be unit-tested and reused by the server.

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_B = WGS84_A * (1 - WGS84_F);
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Latitude and longitude in degrees, height in metres above the ellipsoid. */
export interface Geodetic {
  lat: number;
  lon: number;
  height: number;
}

const DEG = Math.PI / 180;

export function geodeticToEcef({ lat, lon, height }: Geodetic): Vec3 {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  return {
    x: (n + height) * cosPhi * Math.cos(lambda),
    y: (n + height) * cosPhi * Math.sin(lambda),
    z: (n * (1 - WGS84_E2) + height) * sinPhi,
  };
}

/** ECEF to geodetic. Iterative; converges to sub-millimetre in a few steps. */
export function ecefToGeodetic({ x, y, z }: Vec3): Geodetic {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  // Polar case.
  if (p < 1e-9) {
    const lat = z >= 0 ? 90 : -90;
    return { lat, lon: lon / DEG, height: Math.abs(z) - WGS84_B };
  }
  let phi = Math.atan2(z, p * (1 - WGS84_E2));
  let height = 0;
  for (let i = 0; i < 10; i++) {
    const sinPhi = Math.sin(phi);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
    height = p / Math.cos(phi) - n;
    const next = Math.atan2(z, p * (1 - (WGS84_E2 * n) / (n + height)));
    if (Math.abs(next - phi) < 1e-14) {
      phi = next;
      break;
    }
    phi = next;
  }
  return { lat: phi / DEG, lon: lon / DEG, height };
}

/** Unit normal of the ellipsoid (local "up") at a geodetic position. */
export function ellipsoidNormal(lat: number, lon: number): Vec3 {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  return {
    x: Math.cos(phi) * Math.cos(lambda),
    y: Math.cos(phi) * Math.sin(lambda),
    z: Math.sin(phi),
  };
}

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
