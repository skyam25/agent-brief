/** The LAN listener's self-signed certificate. The iPad pins its fingerprint from the pairing QR code. */

import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const OPENSSL = '/usr/bin/openssl';
const DAYS = '3650';

export interface LanCert {
  key: string;
  cert: string;
  /** Base64url SHA-256 of the certificate's DER bytes. */
  fingerprint: string;
}

export function fingerprintOf(certPem: string): string {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('base64url');
}

/** Reads the certificate in `dir`, making it on first use. */
export function ensureCert(dir: string, run: typeof execFileSync = execFileSync): LanCert {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpKey = `${keyPath}.tmp`;
    const tmpCert = `${certPath}.tmp`;
    run(OPENSSL, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', tmpKey], { stdio: 'ignore' });
    chmodSync(tmpKey, 0o600);
    run(OPENSSL, ['req', '-new', '-x509', '-sha256', '-key', tmpKey, '-out', tmpCert, '-days', DAYS, '-subj', '/CN=Agent Brief'], { stdio: 'ignore' });
    chmodSync(tmpCert, 0o600);
    renameSync(tmpKey, keyPath);
    renameSync(tmpCert, certPath);
  }
  const cert = readFileSync(certPath, 'utf8');
  return { key: readFileSync(keyPath, 'utf8'), cert, fingerprint: fingerprintOf(cert) };
}
