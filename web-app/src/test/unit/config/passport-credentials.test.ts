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

let capturedGoogleVerify: any;

jest.mock('passport-google-oauth20', () => ({
    Strategy: jest.fn().mockImplementation((_options: any, verify: any) => {
        capturedGoogleVerify = verify;
        return { name: 'google' };
    })
}));

const mockBuild = jest.fn();
const mockGoogleConfigured = jest.fn(() => true);
jest.mock('../../../config/auth', () => ({
    __esModule: true,
    default: { googleAuth: { clientID: 'id', clientSecret: 'secret', callbackURL: 'https://example.org/cb' } },
    isGoogleAuthConfigured: () => mockGoogleConfigured()
}));

const mockFindOne = jest.fn();
jest.mock('../../../models', () => ({
    __esModule: true,
    default: {
        User: {
            findOne: (...args: any[]) => mockFindOne(...args),
            build: (...args: any[]) => mockBuild(...args)
        }
    }
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

describe('optional Google sign-in', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        capturedVerify = undefined;
        mockGoogleConfigured.mockReturnValue(true);
    });

    it('should still configure local auth when Google is not set up', () => {
        // Registering the Google strategy without a client id throws, which
        // took the entire process down on an appliance that does not use it.
        mockGoogleConfigured.mockReturnValue(false);
        const passportMock = buildPassport();

        expect(() => configurePassport(passportMock)).not.toThrow();

        const registered = passportMock.use.mock.calls.map((call: any) => call[0]?.name);
        expect(registered).toContain('local');
        expect(registered).not.toContain('google');
    });

    it('should still wire session serialisation without Google', () => {
        // Skipping the strategy must not skip everything after it.
        mockGoogleConfigured.mockReturnValue(false);
        const passportMock = buildPassport();

        configurePassport(passportMock);

        expect(passportMock.serializeUser).toHaveBeenCalled();
        expect(passportMock.deserializeUser).toHaveBeenCalled();
    });

    it('should register Google when it is configured', () => {
        const passportMock = buildPassport();

        configurePassport(passportMock);

        expect(passportMock.use.mock.calls.map((call: any) => call[0]?.name)).toContain('google');
    });
});

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

describe('Google sign-in records how someone signs in', () => {
    // The admin user list shows an OAuth Provider column. Setting oauthID
    // without oauthProvider left it blank for exactly the accounts that do use
    // OAuth, which is the opposite of what the column is for.
    const PROFILE = { id: 'google-oauth-id-123', displayName: 'Someone', emails: [{ value: 'someone@example.org' }] };

    beforeEach(() => {
        jest.clearAllMocks();
        capturedGoogleVerify = undefined;
        mockGoogleConfigured.mockReturnValue(true);
        configurePassport(buildPassport());
    });

    it('should record the provider when creating a new account', async () => {
        mockFindOne.mockResolvedValue(null);
        const saved = { id: 7 };
        const built = { save: jest.fn().mockResolvedValue(saved) };
        mockBuild.mockReturnValue(built);

        const done = jest.fn();
        capturedGoogleVerify!('token', 'refresh', PROFILE, done);
        await new Promise(process.nextTick);

        expect(mockBuild).toHaveBeenCalledWith(
            expect.objectContaining({ oauthID: PROFILE.id, oauthProvider: 'google' })
        );
    });

    it('should record the provider when adopting an existing account', async () => {
        // The path an invited user takes: the account already exists and
        // signing in with Google claims it.
        const existing: any = { id: 3, email: PROFILE.emails[0].value, save: jest.fn() };
        existing.save.mockResolvedValue(existing);
        mockFindOne
            .mockResolvedValueOnce(null)      // no account with this oauthID yet
            .mockResolvedValueOnce(existing); // but one with this email

        const done = jest.fn();
        capturedGoogleVerify!('token', 'refresh', PROFILE, done);
        await new Promise(process.nextTick);
        await new Promise(process.nextTick);

        expect(existing.oauthID).toBe(PROFILE.id);
        expect(existing.oauthProvider).toBe('google');
        expect(existing.save).toHaveBeenCalled();
    });
});
