/**
 * Read a whole number from the environment, falling back when the value is
 * absent or malformed.
 *
 * parseInt returns NaN for anything it cannot read, and NaN propagates quietly:
 * AbortSignal.timeout(NaN) becomes 0 and aborts immediately, and a NaN port
 * produces a URL that simply fails to connect. Both surface far from the cause.
 */
export function readIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];

    if (raw === undefined || raw === '') {
        return fallback;
    }

    // Strict: the whole value must be an integer. parseInt would read '5s' as 5,
    // turning a mistyped timeout into a 5ms one that fails every request, which
    // is harder to diagnose than falling back to the documented default.
    const parsed = /^-?\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : NaN;

    if (!Number.isFinite(parsed)) {
        // console rather than appLogger: this runs at module load, before the
        // logger is necessarily configured, and importing it here would create
        // a cycle through config/logger.
        console.warn(`Invalid ${name}="${raw}", falling back to ${fallback}`);
        return fallback;
    }

    return parsed;
}
