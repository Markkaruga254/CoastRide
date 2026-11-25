import crypto from 'crypto';

export function verifySecret(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function maskPhone(phone: string): string {
  const normalized = phone.replace(/\D/g, '');
  if (normalized.startsWith('2547') && normalized.length === 12) {
    return `+2547****${normalized.slice(-4)}`;
  }
  if (normalized.startsWith('07') && normalized.length === 10) {
    return `+2547****${normalized.slice(-4)}`;
  }
  if (normalized.length >= 8) {
    return `****${normalized.slice(-4)}`;
  }
  return '****';
}