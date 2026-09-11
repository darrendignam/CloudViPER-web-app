/**
 * Teams became rows in 2.1. The wire format still speaks team names, because a
 * name is how a person identifies a team, so there is a seam where a name is
 * turned into an id. These tests pin that seam.
 *
 * The hazard is the string 'none'. It is what the UI sends for "no team" and
 * what every row in the database held before this change. Resolving it as an
 * ordinary name would create a team genuinely called "none" whose members all
 * compare equal to one another, which is precisely the bug that moving to a
 * nullable teamId was meant to end.
 */
import request from 'supertest';
import express from 'express';
import { UserRole } from '../../../types/UserRole';

jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

const mockResolveTeam = jest.fn();

jest.mock('../../../models', () => ({
    User: {
        findAll: jest.fn(),
        findByPk: jest.fn(),
        findOne: jest.fn(),
        count: jest.fn(),
        register: jest.fn(),
        resolveTeam: (...args: any[]) => mockResolveTeam(...args)
    },
    Team: { findAll: jest.fn(), findByPk: jest.fn(), findOne: jest.fn() },
    ContainerImage: { findAll: jest.fn(), findByPk: jest.fn(), findOne: jest.fn() },
    ViperInstance: { findAll: jest.fn(), findOne: jest.fn(), count: jest.fn() },
    Log: { create: jest.fn() },
    sequelize: { query: jest.fn(), fn: jest.fn(), col: jest.fn() }
}));

import db from '../../../models';

const mockDb = db as unknown as {
    User: { findByPk: jest.Mock; findAll: jest.Mock };
    Team: { findAll: jest.Mock; findByPk: jest.Mock };
};

const ADMIN = { id: 1, username: 'admin', email: 'a@x.org', role: UserRole.ADMIN, teamId: null };

function buildApp(user: any) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.user = user;
        req.flash = jest.fn(() => []);
        next();
    });
    app.use('/account', require('../../../routes/account').default);
    return app;
}

describe('team name to id resolution', () => {
    let target: any;

    beforeEach(() => {
        jest.clearAllMocks();
        target = { id: 7, username: 'curator', email: 'c@x.org', teamId: 3, save: jest.fn().mockResolvedValue(undefined) };
        mockDb.User.findByPk.mockResolvedValue(target);
        mockResolveTeam.mockImplementation(async (name: string) => ({ id: 99, name }));
    });

    describe('PUT /account/users/:id/team', () => {
        it.each(['none', 'None', 'NONE', '', '   '])('should treat %p as no team', async (value) => {
            await request(buildApp(ADMIN))
                .put('/account/users/7/team')
                .send({ team: value })
                .expect(200);

            expect(mockResolveTeam).not.toHaveBeenCalled();
            expect(target.teamId).toBeNull();
        });

        it('should treat a missing team field as no team', async () => {
            await request(buildApp(ADMIN))
                .put('/account/users/7/team')
                .send({})
                .expect(200);

            expect(mockResolveTeam).not.toHaveBeenCalled();
            expect(target.teamId).toBeNull();
        });

        it('should resolve a real team name to its id', async () => {
            await request(buildApp(ADMIN))
                .put('/account/users/7/team')
                .send({ team: 'preservation' })
                .expect(200);

            expect(mockResolveTeam).toHaveBeenCalledWith('preservation');
            expect(target.teamId).toBe(99);
        });

        it('should trim surrounding whitespace before resolving', async () => {
            // '  preservation  ' and 'preservation' are the same team to a
            // person, and two rows differing only by spaces would split a team
            // in half without anyone seeing why.
            await request(buildApp(ADMIN))
                .put('/account/users/7/team')
                .send({ team: '  preservation  ' })
                .expect(200);

            expect(mockResolveTeam).toHaveBeenCalledWith('preservation');
        });
    });

    describe('GET /account/teams', () => {
        it('should return plain names, which is what the UI binds to', async () => {
            mockDb.Team.findAll.mockResolvedValue([{ name: 'archives' }, { name: 'preservation' }]);

            const response = await request(buildApp(ADMIN)).get('/account/teams').expect(200);

            expect(response.body).toEqual(['archives', 'preservation']);
        });

        it('should no longer need to filter a sentinel out of the list', async () => {
            // Teams are rows, so "no team" is the absence of one and cannot
            // appear here at all.
            mockDb.Team.findAll.mockResolvedValue([]);

            const response = await request(buildApp(ADMIN)).get('/account/teams').expect(200);

            expect(response.body).toEqual([]);
        });
    });

    describe('GET /account/users', () => {
        it('should render a team as its name rather than a nested row', async () => {
            mockDb.User.findAll.mockResolvedValue([
                { toJSON: () => ({ id: 7, username: 'curator', teamId: 3, team: { id: 3, name: 'preservation' } }) },
                { toJSON: () => ({ id: 8, username: 'loner', teamId: null, team: null }) }
            ]);

            const response = await request(buildApp(ADMIN)).get('/account/users').expect(200);

            expect(response.body[0].team).toBe('preservation');
            expect(response.body[1].team).toBeNull();
        });
    });
});
