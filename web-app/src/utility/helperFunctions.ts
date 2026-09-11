import crypto from 'crypto';
import { UserRole } from '../types/UserRole';

const RANDOM_STRING_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Largest multiple of the alphabet size that fits in a byte. Bytes at or above
// this are rejected rather than folded, which would bias the low characters.
const UNBIASED_BYTE_CEILING = 256 - (256 % RANDOM_STRING_ALPHABET.length);

/**
 * Email domains whose members are created as system administrators. Configured
 * rather than hardcoded so a deployment that is not OPF's own does not silently
 * grant administration to a domain it has nothing to do with.
 */
export function adminEmailDomains(): string[] {
    return (process.env.ADMIN_EMAIL_DOMAINS || 'openpreservation.org')
        .split(',')
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean);
}

const helperFunctions = {
    sanitizeUsername: (name: string): string => {
        return name.toLowerCase().replace(/[^a-z0-9]/g, '');
    },
    generateUsername: (email: string): string => {
        if (email.includes('@')) {
            const [emailName] = email.split('@');
            return emailName.toLowerCase().replace(/[^a-z0-9]/g, '');
        } else {
            return email.toLowerCase().replace(/[^a-z0-9]/g, '');
        }
    },
    /**
     * The role a brand new Google sign-in should be created with.
     *
     * Anyone with an address at an admin domain becomes a system administrator
     * on first sign-in. That is only safe because the domain's own identity
     * provider decides who holds such an address; widen ADMIN_EMAIL_DOMAINS and
     * you hand system administration to whoever controls that domain's mail.
     *
     * Applies to account creation only. An existing account keeps whatever role
     * it already has, so a demotion cannot be undone by signing out and in.
     */
    updateRoleIfAdmin: (email: string): UserRole => {
        const domain = String(email || '').split('@')[1]?.toLowerCase();

        if (domain && adminEmailDomains().includes(domain)) {
            return UserRole.ADMIN;
        }
        return UserRole.USER;
    },
    generateRandomString: (length: number): string => {
        let result = '';
        while (result.length < length) {
            for (const byte of crypto.randomBytes(length - result.length)) {
                if (byte < UNBIASED_BYTE_CEILING) {
                    result += RANDOM_STRING_ALPHABET.charAt(byte % RANDOM_STRING_ALPHABET.length);
                }
            }
        }
        return result;
    },
    generateSessionToken: (): string => {
        return crypto.randomBytes(32).toString('base64url');
    }
};

export default helperFunctions;
