import { z } from 'zod';

const name = (label) => z.string({ error: `${label} is required.` }).trim()
  .min(1, `${label} is required.`).max(60, `${label} must be at most 60 characters.`)
  .regex(/^[\p{L}][\p{L}' .-]*$/u, `${label} may only contain letters, spaces, apostrophes and hyphens.`);

export const username = z.string({ error: 'Username is required.' }).trim()
  .min(3, 'Username must be at least 3 characters.').max(20, 'Username must be at most 20 characters.')
  .regex(/^[A-Za-z0-9_]+$/, 'Username may only contain letters, numbers and underscores.');

export const phone = z.string({ error: 'Phone number is required.' }).trim()
  .regex(/^\+?[0-9][0-9\s-]{6,18}[0-9]$/, 'Enter a valid phone number, e.g. +267 71 234 567.');

export const password = z.string({ error: 'Password is required.' })
  .min(8, 'Password must be at least 8 characters.').max(72, 'Password must be at most 72 characters.')
  .regex(/[a-z]/, 'Password needs a lowercase letter.')
  .regex(/[A-Z]/, 'Password needs an uppercase letter.')
  .regex(/[0-9]/, 'Password needs a number.');

export const registerSchema = z.object({
  firstName: name('First name'),
  lastName: name('Last name'),
  username,
  email: z.string({ error: 'Email is required.' }).trim().toLowerCase().email('Enter a valid email address.').max(190),
  phone,
  password,
  confirmPassword: z.string({ error: 'Please confirm your password.' }),
  remember: z.boolean().optional(),
}).refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match.' });

export const loginSchema = z.object({
  identifier: z.string({ error: 'Email or username is required.' }).trim().min(1, 'Email or username is required.').max(190),
  password: z.string({ error: 'Password is required.' }).min(1, 'Password is required.').max(200),
  remember: z.boolean().optional(),
});

export const profileSchema = z.object({
  firstName: name('First name').optional(),
  lastName: name('Last name').optional(),
  phone: phone.optional(),
  bio: z.string().trim().max(160, 'Bio must be at most 160 characters.').optional().nullable(),
  avatarColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid colour.').optional(),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: password,
  confirmPassword: z.string(),
}).refine((d) => d.newPassword === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match.' });

const money = z.coerce.number({ error: 'Enter a valid amount.' }).finite('Enter a valid amount.').positive('Enter an amount greater than zero.');

export const amountSchema = z.object({ amount: money });

export const createMatchSchema = z.object({
  gameId: z.coerce.number().int().positive('Choose a game.'),
  stake: money,
});

export const resultSchema = z.object({
  actions: z.record(z.string(), z.unknown()),
  clientElapsedMs: z.number().nonnegative().optional(),
});

const opponentField = z.union([z.string().trim().min(1, 'Choose an opponent.').max(21), z.number().int().positive()]);

export const challengeSchema = z.object({
  opponent: opponentField,
  gameId: z.coerce.number().int().positive('Choose a game.'),
  stake: money,
  message: z.string().trim().max(140).optional().nullable(),
});

export const footballChallengeSchema = z.object({
  opponent: opponentField,
  fixtureId: z.coerce.number().int().positive('Choose a match.'),
  challengeTypeSlug: z.string().trim().min(1, 'Choose a challenge type.'),
  pick: z.enum(['HOME', 'AWAY', 'YES', 'NO'], { error: 'Choose your pick.' }),
  stake: money,
  message: z.string().trim().max(140).optional().nullable(),
});

export const footballFindSchema = z.object({
  fixtureId: z.coerce.number().int().positive('Choose a match.'),
  challengeTypeSlug: z.string().trim().min(1, 'Choose a challenge type.'),
  pick: z.enum(['HOME', 'AWAY', 'YES', 'NO'], { error: 'Choose your pick.' }),
  stake: money,
});

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
