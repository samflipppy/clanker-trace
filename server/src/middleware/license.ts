/**
 * License key system for Clanker Trace self-hosted deployments.
 *
 * Architecture:
 *   - You (Clanker) host a thin billing API at billing.clankertrace.com
 *   - Users run the full Clanker Trace server on their own infra
 *   - When a user pays, billing API issues a signed license key
 *   - The self-hosted server validates the key locally (no phone-home per request)
 *   - Keys encode: tenant ID, credit amount, expiry, and an HMAC signature
 *
 * Key format:  ct_lic_<base64url(JSON payload)>.<HMAC-SHA256 signature>
 *
 * The signing secret is only known to the billing server.
 * Self-hosted servers get a public verification key or shared secret on setup.
 */

import crypto from 'crypto';

export interface LicensePayload {
  tenant_id: string;
  credits: number;
  plan: 'free' | 'builder' | 'scale';
  issued_at: string;
  expires_at: string;
}

const SIGNING_SECRET = process.env.CLANKER_LICENSE_SECRET || 'ct-dev-secret-change-in-production';

export function signLicense(payload: LicensePayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(data)
    .digest('base64url');
  return `ct_lic_${data}.${sig}`;
}

export function verifyLicense(key: string): LicensePayload | null {
  if (!key.startsWith('ct_lic_')) return null;

  const body = key.slice(7); // strip ct_lic_
  const dotIndex = body.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const data = body.slice(0, dotIndex);
  const sig = body.slice(dotIndex + 1);

  const expectedSig = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(data)
    .digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as LicensePayload;

    // Check expiry
    if (new Date(payload.expires_at) < new Date()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function isLicenseExpired(payload: LicensePayload): boolean {
  return new Date(payload.expires_at) < new Date();
}
