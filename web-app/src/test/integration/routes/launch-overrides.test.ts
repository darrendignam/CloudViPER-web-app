/**
 * The route's only job here is to pass the advanced options through intact.
 *
 * Deliberately not a second permission gate: the service refuses each of these
 * for a role that may not use it, and two gates that can drift apart are worse
 * than one that is tested. What this file checks is that nothing is dropped,
 * renamed or silently defaulted on the way.
 */
import request from 'supertest';
import express from 'express';
import { UserRole } from '../../../types/UserRole';

jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

const mockCreateInstance = jest.fn();

jest.mock('../../../services/ViperInstanceService', () => ({
    __esModule: true,
    default: { createInstance: mockCreateInstance },
    getInstanceLimit: jest.requireActual('../../../services/ViperInstanceService').getInstanceLimit
}));

jest.mock('../../../models', () => ({
    ViperInstance: { count: jest.fn(), findAll: jest.fn(), findOne: jest.fn() },
    ContainerImage: { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn() },
    Team: { findByPk: jest.fn() },
    User: { findByPk: jest.fn(), findAll: jest.fn() },
    Log: { create: jest.fn() },
    Screenshot: { findAll: jest.fn() },
    Activity: { findAll: jest.fn() },
    sequelize: { query: jest.fn() }
}));

import db from '../../../models';

const mockDb = db as unknown as { ViperInstance: { count: jest.Mock } };

const ADMIN = { id: 1, username: 'admin', email: 'a@x.org', role: UserRole.ADMIN, teamId: null };
const MEMBER = { id: 2, username: 'mem', email: 'm@x.org', role: UserRole.MEMBER, teamId: 5 };

function buildApp(user: any) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = user; next(); });
    app.use('/service', require('../../../routes/service').default);
    return app;
}

function optionsPassed() {
    return mockCreateInstance.mock.calls[0]?.[2] || {};
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.ViperInstance.count.mockResolvedValue(0);
    mockCreateInstance.mockResolvedValue({ success: true, container: { id: 'c', uuid: 'u', url: 'u.x', status: 'created' } });
});

describe('POST /service/new-instance with advanced options', () => {
    it('should pass the owner through', async () => {
        await request(buildApp(ADMIN)).post('/service/new-instance')
            .send({ ownerId: 7 }).expect(200);

        expect(optionsPassed().ownerId).toBe(7);
    });

    it('should pass environment overrides through unchanged', async () => {
        await request(buildApp(ADMIN)).post('/service/new-instance')
            .send({ envOverrides: { OPENROUTER_API_KEY: 'sk-or-v1-seven' } }).expect(200);

        expect(optionsPassed().envOverrides).toEqual({ OPENROUTER_API_KEY: 'sk-or-v1-seven' });
    });

    it('should pass an empty mount list through, which means mount nothing', async () => {
        // Distinct from omitting it, which means keep the image's. Coercing one
        // into the other would silently ignore the admin.
        await request(buildApp(ADMIN)).post('/service/new-instance')
            .send({ volumeOverrides: [] }).expect(200);

        expect(optionsPassed().volumeOverrides).toEqual([]);
    });

    it('should leave overrides undefined when none are sent', async () => {
        await request(buildApp(ADMIN)).post('/service/new-instance').send({}).expect(200);

        const options = optionsPassed();

        expect(options.ownerId).toBeUndefined();
        expect(options.envOverrides).toBeUndefined();
        expect(options.volumeOverrides).toBeUndefined();
    });

    it('should hand a member\'s options through for the service to refuse', async () => {
        // The route does not pre-filter. If it silently dropped these, a member
        // probing the endpoint would get a success and a surprise.
        mockCreateInstance.mockRejectedValue(new Error('Only system administrators can override an instance at launch'));

        const response = await request(buildApp(MEMBER)).post('/service/new-instance')
            .send({ ownerId: 1 });

        expect(optionsPassed().ownerId).toBe(1);
        expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('should still carry the image choice and build mode', async () => {
        await request(buildApp(ADMIN)).post('/service/new-instance')
            .send({ imageId: 4, buildMode: true }).expect(200);

        expect(mockCreateInstance.mock.calls[0][1]).toBe(4);
        expect(optionsPassed().buildMode).toBe(true);
    });
});
