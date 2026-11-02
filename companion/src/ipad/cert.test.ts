import { X509Certificate, createHash } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureCert } from './cert';

describe('ensureCert', () => {
  it('makes a P-256 certificate once, private, with a DER fingerprint', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cert-')), 'ipad');
    const first = ensureCert(dir);
    const x509 = new X509Certificate(first.cert);
    expect(x509.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(new Date(x509.validTo).getTime()).toBeGreaterThan(Date.now() + 9 * 365 * 24 * 3600_000);
    expect(first.fingerprint).toBe(createHash('sha256').update(x509.raw).digest('base64url'));
    expect(statSync(join(dir, 'key.pem')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'cert.pem')).mode & 0o777).toBe(0o600);
    expect(ensureCert(dir).fingerprint).toBe(first.fingerprint);
  });
});
