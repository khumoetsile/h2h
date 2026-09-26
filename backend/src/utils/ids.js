import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export const matchCode = () => `M-${randomCode(8)}`;
export const txReference = () => `TX-${randomCode(12)}`;
export const randomSeed = () => crypto.randomBytes(4).readUInt32BE(0);
