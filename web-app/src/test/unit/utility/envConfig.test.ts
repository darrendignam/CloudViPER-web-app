import { readIntEnv } from '../../../utility/envConfig';

describe('readIntEnv', () => {
    const ORIGINAL = process.env.TEST_INT_VAR;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
        if (ORIGINAL === undefined) {
            delete process.env.TEST_INT_VAR;
        } else {
            process.env.TEST_INT_VAR = ORIGINAL;
        }
    });

    it('should read a valid integer', () => {
        process.env.TEST_INT_VAR = '8083';

        expect(readIntEnv('TEST_INT_VAR', 1)).toBe(8083);
    });

    it('should fall back when the variable is unset', () => {
        delete process.env.TEST_INT_VAR;

        expect(readIntEnv('TEST_INT_VAR', 5000)).toBe(5000);
    });

    it('should fall back on an empty value', () => {
        process.env.TEST_INT_VAR = '';

        expect(readIntEnv('TEST_INT_VAR', 5000)).toBe(5000);
    });

    it('should fall back and warn on a value it cannot read', () => {
        // '5s' is the shape an operator naturally reaches for on a timeout, and
        // parseInt would give NaN, which AbortSignal.timeout turns into 0.
        process.env.TEST_INT_VAR = 'abc';

        expect(readIntEnv('TEST_INT_VAR', 5000)).toBe(5000);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TEST_INT_VAR'));
    });

    it('should not silently accept a NaN result for a unit-suffixed value', () => {
        process.env.TEST_INT_VAR = 'abc5';

        expect(readIntEnv('TEST_INT_VAR', 5000)).toBe(5000);
    });

    it('should reject a trailing unit rather than reading it as a tiny number', () => {
        // parseInt('5s') is 5, which would turn a mistyped 5 second timeout into
        // a 5ms one that fails every request. Falling back is easier to diagnose.
        process.env.TEST_INT_VAR = '5s';

        expect(readIntEnv('TEST_INT_VAR', 5000)).toBe(5000);
        expect(warnSpy).toHaveBeenCalled();
    });

    it('should tolerate surrounding whitespace', () => {
        process.env.TEST_INT_VAR = '  8083  ';

        expect(readIntEnv('TEST_INT_VAR', 1)).toBe(8083);
    });

    it('should accept a negative value rather than inventing a policy', () => {
        process.env.TEST_INT_VAR = '-1';

        expect(readIntEnv('TEST_INT_VAR', 5000)).toBe(-1);
    });
});
