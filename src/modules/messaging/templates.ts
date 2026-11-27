export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

export function bookingConfirmation(ref: string): string {
  return `CoastRide: booked! Ref ${ref}. SMS sent.`
}

export function driverOffer(
  ref: string,
  driverName: string,
  pickupPoint: string,
  pickupAt: string,
  timeZone: string,
): string {
  const time = formatTime(pickupAt, timeZone)
  return `CoastRide trip ${ref}: ${driverName} offers pickup at ${pickupPoint} ${time}. Reply 1 accept / 2 decline.`
}

export function driverConfirmed(
  ref: string,
  driverName: string,
  plate: string,
  phone: string,
): string {
  return `CoastRide ${ref} confirmed. Driver: ${driverName}, plate ${plate}, phone ${phone}.`
}

export function delayNotice(
  ref: string,
  newPickupAt: string,
  minutes: number,
  role: 'passenger' | 'driver',
  timeZone: string,
): string {
  const time = formatTime(newPickupAt, timeZone)
  const who = role === 'passenger' ? 'Your pickup' : 'This trip'
  return `CoastRide ${ref}: ${who} delayed ${minutes} min, new time ${time}.`
}

export function cancelled(ref: string): string {
  return `CoastRide trip ${ref} cancelled.`
}

export function arrived(ref: string, driverName: string): string {
  return `CoastRide ${ref}: ${driverName} has arrived.`
}

export function completed(ref: string): string {
  return `CoastRide trip ${ref} completed. Thank you!`
}

export function helpText(): string {
  return `CoastRide: reply 1 accept / 2 decline / ARRIVED / DONE / CANCEL / DELAY <min>.`
}

export function noDriverAvailable(ref: string): string {
  return `CoastRide ${ref}: no driver is available right now. Please try again shortly or contact support.`
}
