/**
 * The launch page used to probe the instance itself with a no-cors fetch, whose
 * opaque response resolves on a 502 exactly as it does on a 200, so a proxy
 * error was reported as "Connected" over a blank frame. The probe now runs on
 * the server, where the real status is visible.
 */
import request from 'supertest';
import express from 'express';
import { UserRole } from '../../../types/UserRole';

jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

jest.mock('../../../models', () => ({
    ViperInstance: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), count: jest.fn(), update: jest.fn() },
    User: { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), count: jest.fn() },
    Log: { create: jest.fn() },
    Screenshot: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn() },
    Activity: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn() },
    sequelize: { query: jest.fn() }
}));

jest.mock('../../../services/ViperInstanceService', () => ({
    __esModule: true,
    default: { grantInstanceAccess: jest.fn().mockResolvedValue('tok'), revokeInstanceAccess: jest.fn() }
}));

import db from '../../../models';

const mockDb = db as unknown as {
    ViperInstance: { findOne: jest.Mock };
    User: { findByPk: jest.Mock };
};

const OWNER = { id: 42, username: 'owner', email: 'owner@example.org', role: UserRole.MEMBER, team: 'preservation' };
const INSTANCE = {
    id: 3,
    uuid: 'inst123abc45',
    name: 'viper-cloud-inst123abc45',
    url: 'inst123abc45.example.org',
    owner: 42
};

const READY_URL = '/service/launch/inst123abc45/ready';

function buildApp(user?: any) {
    const app = express();
    app.set('view engine', 'handlebars');
    app.engine('handlebars', (_p: string, _o: any, cb: any) => cb(null, 'ok'));
    app.use((req, _res, next) => {
        if (user) (req as any).user = user;
        next();
    });
    app.use('/service', require('../../../routes/service').default);
    return app;
}

describe('GET /service/launch/:instanceUUID/ready', () => {
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.ViperInstance.findOne.mockResolvedValue(INSTANCE);
        mockDb.User.findByPk.mockResolvedValue({ id: 42, team: 'preservation' });
        fetchSpy = jest.spyOn(global, 'fetch');
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    it('should report reachable when the desktop answers 200', async () => {
        fetchSpy.mockResolvedValue({ status: 200 } as any);

        const response = await request(buildApp(OWNER)).get(READY_URL);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ reachable: true, status: 200 });
    });

    it('should report unreachable on a proxy 502', async () => {
        // The case the old client could not see at all.
        fetchSpy.mockResolvedValue({ status: 502 } as any);

        const response = await request(buildApp(OWNER)).get(READY_URL);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ reachable: false, status: 502 });
    });

    it('should treat an auth status as proof the desktop is up', async () => {
        // Selkies authenticates over the WebSocket, so a 401 here still means
        // something is listening and the frame will render.
        fetchSpy.mockResolvedValue({ status: 401 } as any);

        const response = await request(buildApp(OWNER)).get(READY_URL);

        expect(response.body.reachable).toBe(true);
    });

    it('should report unreachable when the connection is refused', async () => {
        fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

        const response = await request(buildApp(OWNER)).get(READY_URL);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ reachable: false });
    });

    it('should report unreachable when the probe times out', async () => {
        const timeout = new Error('The operation was aborted due to timeout');
        timeout.name = 'TimeoutError';
        fetchSpy.mockRejectedValue(timeout);

        const response = await request(buildApp(OWNER)).get(READY_URL);

        expect(response.body.reachable).toBe(false);
    });

    it('should probe the instance URL and not follow redirects', async () => {
        fetchSpy.mockResolvedValue({ status: 200 } as any);

        await request(buildApp(OWNER)).get(READY_URL);

        expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringContaining('inst123abc45.example.org'),
            expect.objectContaining({ method: 'GET', redirect: 'manual' })
        );
    });

    it('should answer 500 rather than hang when the lookup itself fails', async () => {
        mockDb.ViperInstance.findOne.mockRejectedValue(new Error('DB is down'));

        const response = await request(buildApp(OWNER)).get(READY_URL);

        expect(response.status).toBe(500);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should not probe anything for a caller who cannot reach the instance', async () => {
        mockDb.User.findByPk.mockResolvedValue({ id: 99, team: 'other' });

        const response = await request(buildApp({
            id: 99, username: 'stranger', email: 's@x.org', role: UserRole.MEMBER, team: 'other'
        })).get(READY_URL);

        expect(response.status).toBe(403);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
