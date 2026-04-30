type LocationState = { lat: number; lon: number } | null;

const userLocations = new Map<string, LocationState>();

export function setLocation(userId: string, lat: number, lon: number): void {
  userLocations.set(userId, { lat, lon });
}

export function getLocation(userId: string): LocationState {
  return userLocations.get(userId) ?? null;
}
