import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt from Node's standard library (no native add-on, no install script).
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum for scrypt: N = 2^17, r = 8, p = 1
 * (about 128 MiB of memory per hash). Argon2id would be the first choice, but every Node binding for it is a native
 * dependency; scrypt is the cheat sheet's next recommendation and ships with Node.
 *
 * Stored format (versioned, so parameters can be raised later and old hashes upgraded at the next login):
 *   $scrypt$ln=17,r=8,p=1$<base64 salt (16 bytes)>$<base64 hash (32 bytes)>
 * The database refuses to store anything that does not look like this (sdb_is_password_hash, migration 0014), so a bug
 * cannot write a plaintext password.
 */
export const SCRYPT = { ln: 17, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
export const PASSWORD_POLICY = { minLength: 12, maxLength: 128 } as const;

const FORMAT = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

function derive(password: string, salt: Buffer, ln: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  const N = 2 ** ln;
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFC"), salt, keyLen, { N, r, p, maxmem: 2 * 128 * N * r }, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  return hashPasswordWith(password, SCRYPT);
}

/** Explicit parameters: only for tests and for reasoning about upgrades. Application code uses hashPassword(). */
export async function hashPasswordWith(password: string, params: { ln: number; r: number; p: number; keyLen: number; saltLen: number }): Promise<string> {
  const salt = randomBytes(params.saltLen);
  const key = await derive(password, salt, params.ln, params.r, params.p, params.keyLen);
  return `$scrypt$ln=${params.ln},r=${params.r},p=${params.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// A fixed, valid hash of a random value: verifying against it when the account does not exist (or its stored hash is
// unusable) costs the same time as a real check, so response timing does not reveal which e-mails are registered.
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString("hex")));

export interface VerifyResult { ok: boolean; needsRehash: boolean }

export async function verifyPassword(stored: string | null | undefined, password: string): Promise<VerifyResult> {
  const m = FORMAT.exec(stored ?? "");
  const [ln, r, p] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  // Bound the work a stored hash may demand (a tampered row must not be able to request 2^30 iterations).
  const usable = m !== null && ln >= 14 && ln <= 20 && r >= 1 && r <= 16 && p >= 1 && p <= 4;
  if (!usable) {
    await verifyPassword(await dummyHash(), password); // same cost, always false
    return { ok: false, needsRehash: false };
  }
  const salt = Buffer.from(m![4]!, "base64");
  const expected = Buffer.from(m![5]!, "base64");
  const actual = await derive(password, salt, ln, r, p, expected.length);
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
  return { ok, needsRehash: ok && (ln !== SCRYPT.ln || r !== SCRYPT.r || p !== SCRYPT.p || expected.length !== SCRYPT.keyLen) };
}

/** Length-only policy (NIST SP 800-63B: length matters, composition rules do not). Breached-password lists: out of scope. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_POLICY.minLength) return `password must be at least ${PASSWORD_POLICY.minLength} characters`;
  if (password.length > PASSWORD_POLICY.maxLength) return `password must be at most ${PASSWORD_POLICY.maxLength} characters`;
  return null;
}
