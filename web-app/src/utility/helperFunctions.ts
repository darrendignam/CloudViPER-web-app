import crypto from 'crypto';
import { UserRole } from '../types/UserRole';

const RANDOM_STRING_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Largest multiple of the alphabet size that fits in a byte. Bytes at or above
// this are rejected rather than folded, which would bias the low characters.
const UNBIASED_BYTE_CEILING = 256 - (256 % RANDOM_STRING_ALPHABET.length);

const helperFunctions = {
    sanitizeUsername: (name: string): string => {
        return name.toLowerCase().replace(/[^a-z0-9]/g, '');
    },
    generateUsername: (email: string): string => {
        if (email.includes('@')) {
            const [emailName, domain] = email.split('@');
            return emailName.toLowerCase().replace(/[^a-z0-9]/g, '');
        } else {
            return email.toLowerCase().replace(/[^a-z0-9]/g, '');
        }
    },
    updateRoleIfAdmin: (email: string): UserRole => {
        const domain = email.split('@')[1];
        if (domain === 'openpreservation.org') {
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
