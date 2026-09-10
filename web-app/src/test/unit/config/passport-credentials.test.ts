/**
 * The dev-mode trace in the local strategy once logged the submitted password.
 * appLogger writes to a rotated file with 14 day retention that
 * /service/logs/app serves to admins, so anything logged there outlives the
 * request and is readable over HTTP. These tests pin that shut.
 */

type VerifyCallback = (username: string, password: string, done: jest.Mock) => void;

let capturedVerify: VerifyCallback | undefined;

jest.mock('passport-local', () => ({
    Strategy: jest.fn().mockImplementation((_options: any, verify: VerifyCallback) => {
        capturedVerify = verify;
        return { name: 'local' };
    })
}));

jest.mock('passport-google-oauth20', () => ({
    Strategy: jest.fn().mockImplementation(() => ({ name: 'google' }))
}));

const mockFindOne = jest.fn();
jest.mock('../../../models', () => ({
    __esModule: true,
    default: { User: { findOne: (...args: any[]) => mockFindOne(...args) } }
}));

const mockLoggerInfo = jest.fn();
jest.mock('../../../config/logger', () => ({
    appLogger: {
        info: (...args: any[]) => mockLoggerInfo(...args),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

import configurePassport from '../../../config/passport';

const PASSWORD = 'correct-horse-battery-staple';
const USERNAME = 'curator@example.org';

function buildPassport() {
    return {
        use: jest.fn(),
        serializeUser: jest.fn(),
        deserializeUser: jest.fn()
    } as any;
}

describe('LocalStrategy dev logging', () => {
    const ORIGINAL_ENV = process.env.NODE_ENV;

    beforeEach(() => {
        jest.clearAllMocks();
        capturedVerify = undefined;
        mockFindOne.mockResolvedValue(null);
    });

    afterEach(() => {
        process.env.NODE_ENV = ORIGINAL_ENV;
    });

    it.each(['dev', 'development'])('should never log the password in %s', async (env) => {
        process.env.NODE_ENV = env;
        configurePassport(buildPassport());

        expect(capturedVerify).toBeDefined();
        capturedVerify!(USERNAME, PASSWORD, jest.fn());

        expect(mockLoggerInfo).toHaveBeenCalled();
        const logged = JSON.stringify(mockLoggerInfo.mock.calls);
        expect(logged).not.toContain(PASSWORD);
        expect(logged).toContain(USERNAME);
    });

    it('should log nothing at all in production', () => {
        process.env.NODE_ENV = 'production';
        configurePassport(buildPassport());

        capturedVerify!(USERNAME, PASSWORD, jest.fn());

        expect(mockLoggerInfo).not.toHaveBeenCalled();
    });

    it('should still authenticate a known user', async () => {
        process.env.NODE_ENV = 'dev';
        const authenticate = jest.fn().mockResolvedValue({ id: 1 });
        mockFindOne.mockResolvedValue({ id: 1, authenticate });
        configurePassport(buildPassport());

        const done = jest.fn();
        capturedVerify!(USERNAME, PASSWORD, done);
        await new Promise(process.nextTick);

        expect(authenticate).toHaveBeenCalledWith(PASSWORD);
        expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ id: 1 }));
    });

    it('should refuse an unknown user without logging the password', async () => {
        process.env.NODE_ENV = 'dev';
        mockFindOne.mockResolvedValue(null);
        configurePassport(buildPassport());

        const done = jest.fn();
        capturedVerify!(USERNAME, PASSWORD, done);
        await new Promise(process.nextTick);

        expect(done).toHaveBeenCalledWith(null, false, { message: 'Incorrect username' });
        expect(JSON.stringify(mockLoggerInfo.mock.calls)).not.toContain(PASSWORD);
    });
});
