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
    User: { findByPk: jest.Mock; findOne: jest.Mock };
    Screenshot: { findAll: jest.Mock; findOne: jest.Mock };
    Activity: { findAll: jest.Mock };
};

const INSTANCE = { id: 3, uuid: 'inst123abc45', name: 'viper-cloud-inst123abc45', url: 'x.example.org', owner: 42 };

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

// Every endpoint that serves per-instance data must go through
// resolveAccessibleInstance. These ran their own copies of the check until 2.0,
// and one was missed during the refactor, so each is asserted individually.
const INSTANCE_SCOPED_ENDPOINTS = [
    '/service/launch/inst123abc45',
    '/service/screenshot/inst123abc45',
    '/service/screenshots/inst123abc45',
    '/service/activity/inst123abc45'
];

describe('Instance access control', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.ViperInstance.findOne.mockResolvedValue(INSTANCE);
        mockDb.Screenshot.findAll.mockResolvedValue([]);
        mockDb.Screenshot.findOne.mockResolvedValue(null);
        mockDb.Activity.findAll.mockResolvedValue([]);
    });

    describe.each(INSTANCE_SCOPED_ENDPOINTS)('%s', (endpoint) => {
        it('should refuse an unrelated signed-in user', async () => {
            mockDb.User.findByPk.mockResolvedValue({ id: 42, team: 'preservation' });

            const response = await request(buildApp({
                id: 77, username: 'stranger', email: 's@x.org', role: UserRole.MEMBER, team: 'other'
            })).get(endpoint);

            expect(response.status).toBe(403);
        });

        it('should not treat the default team "none" as a shared team', async () => {
            mockDb.User.findByPk.mockResolvedValue({ id: 42, team: 'none' });
            mockDb.User.findOne.mockResolvedValue({ id: 42, team: 'none' });

            const response = await request(buildApp({
                id: 88, username: 'leader', email: 'l@x.org', role: UserRole.TEAM_LEADER, team: 'none'
            })).get(endpoint);

            expect(response.status).toBe(403);
        });

        it('should admit a team leader on the same real team', async () => {
            mockDb.User.findByPk.mockResolvedValue({ id: 42, team: 'preservation' });

            const response = await request(buildApp({
                id: 88, username: 'leader', email: 'l@x.org', role: UserRole.TEAM_LEADER, team: 'preservation'
            })).get(endpoint);

            expect(response.status).not.toBe(403);
        });

        it('should refuse an unauthenticated caller', async () => {
            const response = await request(buildApp()).get(endpoint);

            expect(response.status).toBe(401);
        });
    });
});
