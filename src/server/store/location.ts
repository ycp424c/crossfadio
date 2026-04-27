type LocationState = { lat: number; lon: number } | null;

let currentLocation: LocationState = null;

export function setLocation(lat: number, lon: number): void {
  currentLocation = { lat, lon };
}

export function getLocation(): LocationState {
  return currentLocation;
}
