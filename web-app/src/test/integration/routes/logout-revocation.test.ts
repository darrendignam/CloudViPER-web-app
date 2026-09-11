/**
 * Logout withdraws the desktop credential and nothing else. The container keeps
 * running so a long job survives, and the user reconnects with a fresh token
 * after signing back in.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

const mockRevokeUserSessions = jest.fn();
const mockTerminateInstance = jest.fn();

jest.mock('../../../services/ViperInstanceService', () => ({
    __esModule: true,
    default: {
        revokeUserSessions: (...args: any[]) => mockRevokeUserSessions(...args),
        terminateInstance: (...args: any[]) => mockTerminateInstance(...args),
        grantInstanceAccess: jest.fn()
    }
}));

jest.mock('../../../models', () => ({
    ContainerImage: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
    Team: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), findOrCreate: jest.fn() },
    User: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), count: jest.fn() },
    ViperInstance: { findOne: jest.fn(), findAll: jest.fn(), count: jest.fn() },
    Log: { create: jest.fn() },
    sequelize: { query: jest.fn() }
}));

const USER = { id: 42, username: 'curator', email: 'curator@example.org', role: 'member' };

function buildApp(options: { user?: any; logoutError?: Error } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.user = 'user' in options ? options.user : USER;
        req.flash = jest.fn(() => []);
        req.logout = jest.fn((callback: any) => callback(options.logoutError ?? null));
        next();
    });
    app.use('/account', require('../../../routes/account').default);
    return app;
}

describe('GET /account/logout', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRevokeUserSessions.mockResolvedValue(1);
    });

    it('should withdraw the desktop sessions for the user logging out', async () => {
        await request(buildApp()).get('/account/logout').expect(302);

        expect(mockRevokeUserSessions).toHaveBeenCalledWith(USER.id);
    });

    it('should never terminate a container on logout', async () => {
        // The whole point: a long running job keeps going.
        await request(buildApp()).get('/account/logout').expect(302);

        expect(mockTerminateInstance).not.toHaveBeenCalled();
    });

    it('should revoke before ending the session, not after', async () => {
        // Ending the session first would drop req.user and leave the tokens
        // live with nothing left to attribute them to.
        let logoutCalledAt = 0;
        let revokedAt = 0;
        let tick = 0;

        mockRevokeUserSessions.mockImplementation(async () => {
            revokedAt = ++tick;
            return 1;
        });

        const app = express();
        app.use((req: any, _res, next) => {
            req.user = USER;
            req.flash = jest.fn(() => []);
            req.logout = jest.fn((callback: any) => {
                logoutCalledAt = ++tick;
                callback(null);
            });
            next();
        });
        app.use('/account', require('../../../routes/account').default);

        await request(app).get('/account/logout').expect(302);

        expect(revokedAt).toBeLessThan(logoutCalledAt);
    });

    it('should still sign the user out when revocation fails', async () => {
        // A container that cannot be reached must not trap someone in a
        // signed-in state.
        mockRevokeUserSessions.mockRejectedValue(new Error('control plane unreachable'));

        const response = await request(buildApp()).get('/account/logout');

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe('/account/login');
    });

    it('should not attempt revocation for a caller with no session', async () => {
        await request(buildApp({ user: undefined })).get('/account/logout').expect(302);

        expect(mockRevokeUserSessions).not.toHaveBeenCalled();
    });

    it('should answer once when passport reports a logout error', async () => {
        // This branch used to send JSON and then fall through to the redirect,
        // throwing "Cannot set headers after they are sent".
        const response = await request(buildApp({ logoutError: new Error('Logout failed') }))
            .get('/account/logout');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'Logout failed' });
    });
});
