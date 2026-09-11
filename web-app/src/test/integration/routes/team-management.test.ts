import request from 'supertest';
import express from 'express';
import { UserRole } from '../../../types/UserRole';

jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

jest.mock('../../../models', () => ({
    User: { findAll: jest.fn(), findByPk: jest.fn(), findOne: jest.fn(), count: jest.fn(), register: jest.fn(), resolveTeam: jest.fn() },
    Team: { findAll: jest.fn(), findByPk: jest.fn(), findOne: jest.fn(), create: jest.fn() },
    ContainerImage: { findAll: jest.fn(), findByPk: jest.fn(), findOne: jest.fn() },
    ViperInstance: { findAll: jest.fn(), count: jest.fn() },
    Log: { create: jest.fn() },
    sequelize: { query: jest.fn(), fn: jest.fn(), col: jest.fn() }
}));

import db from '../../../models';

const mockDb = db as unknown as {
    Team: { findAll: jest.Mock; findByPk: jest.Mock; findOne: jest.Mock; create: jest.Mock };
    User: { count: jest.Mock };
};

const ADMIN = { id: 1, username: 'admin', email: 'a@x.org', role: UserRole.ADMIN, teamId: null };
const TEAM_ADMIN = { id: 2, username: 'ta', email: 't@x.org', role: UserRole.TEAM_ADMIN, teamId: 5 };

function buildApp(user?: any) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { if (user) req.user = user; req.flash = jest.fn(() => []); next(); });
    app.use('/account', require('../../../routes/account').default);
    return app;
}

describe('team management', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.Team.findAll.mockResolvedValue([]);
        mockDb.User.count.mockResolvedValue(0);
    });

    describe('GET /account/teams/detail', () => {
        it('should report member counts alongside each team', async () => {
            mockDb.Team.findAll.mockResolvedValue([
                { id: 5, name: 'preservation', description: null, defaultImageId: 2 }
            ]);
            mockDb.User.count.mockResolvedValue(3);

            const response = await request(buildApp(ADMIN)).get('/account/teams/detail').expect(200);

            expect(response.body).toEqual([
                { id: 5, name: 'preservation', description: null, defaultImageId: 2, memberCount: 3 }
            ]);
        });

        it('should refuse anyone but a system admin', async () => {
            await request(buildApp(TEAM_ADMIN)).get('/account/teams/detail').expect(403);
            await request(buildApp()).get('/account/teams/detail').expect(401);
        });
    });

    describe('POST /account/teams', () => {
        it('should create a team', async () => {
            mockDb.Team.findOne.mockResolvedValue(null);
            mockDb.Team.create.mockResolvedValue({ id: 7, name: 'archives', description: null });

            const response = await request(buildApp(ADMIN))
                .post('/account/teams').send({ name: 'archives' }).expect(201);

            expect(response.body.name).toBe('archives');
        });

        it.each(['none', 'None', 'NONE'])('should refuse %p as a team name', async (name) => {
            // These mean "no team" everywhere else. A real row with that name
            // would make membership checks compare people who are in no team,
            // which is the bug moving to a nullable teamId removed.
            const response = await request(buildApp(ADMIN)).post('/account/teams').send({ name });

            expect(response.status).toBe(400);
            expect(response.body.message).toMatch(/means no team/i);
            expect(mockDb.Team.create).not.toHaveBeenCalled();
        });

        it('should refuse an empty name', async () => {
            await request(buildApp(ADMIN)).post('/account/teams').send({ name: '   ' }).expect(400);
        });

        it('should refuse a duplicate', async () => {
            mockDb.Team.findOne.mockResolvedValue({ id: 5, name: 'preservation' });

            await request(buildApp(ADMIN))
                .post('/account/teams').send({ name: 'preservation' }).expect(409);
        });

        it('should refuse a team admin', async () => {
            await request(buildApp(TEAM_ADMIN)).post('/account/teams').send({ name: 'x' }).expect(403);
        });
    });

    describe('DELETE /account/teams/:id', () => {
        it('should refuse while members remain', async () => {
            // Deleting would leave those users pointing at a row that no longer
            // exists. A dangling teamId matches nothing, so they would quietly
            // lose sight of their team's instances with no error anywhere.
            mockDb.Team.findByPk.mockResolvedValue({ id: 5, name: 'preservation', destroy: jest.fn() });
            mockDb.User.count.mockResolvedValue(2);

            const response = await request(buildApp(ADMIN)).delete('/account/teams/5');

            expect(response.status).toBe(409);
            expect(response.body.message).toMatch(/2 user\(s\) are still in this team/);
        });

        it('should delete an empty team', async () => {
            const team = { id: 5, name: 'preservation', destroy: jest.fn().mockResolvedValue(undefined) };
            mockDb.Team.findByPk.mockResolvedValue(team);
            mockDb.User.count.mockResolvedValue(0);

            await request(buildApp(ADMIN)).delete('/account/teams/5').expect(200);

            expect(team.destroy).toHaveBeenCalled();
        });

        it('should answer 404 for a team that does not exist', async () => {
            mockDb.Team.findByPk.mockResolvedValue(null);

            await request(buildApp(ADMIN)).delete('/account/teams/99').expect(404);
        });

        it('should refuse a team admin deleting anything', async () => {
            await request(buildApp(TEAM_ADMIN)).delete('/account/teams/5').expect(403);
        });
    });
});
