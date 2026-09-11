import request from 'supertest';
import express from 'express';
import { UserRole } from '../../../types/UserRole';

jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

const mockService = {
    addImageFromRegistry: jest.fn(),
    setGlobalDefault: jest.fn(),
    setTeamDefault: jest.fn(),
    removeImage: jest.fn(),
    launchableImages: jest.fn(),
    hostImagesAvailableToAdd: jest.fn(),
    commitInstanceToImage: jest.fn()
};

jest.mock('../../../services/ContainerImageService', () => {
    const actual = jest.requireActual('../../../services/ContainerImageService');
    return {
        __esModule: true,
        ...actual,
        default: mockService
    };
});

jest.mock('../../../models', () => ({
    ContainerImage: { findAll: jest.fn(), findByPk: jest.fn(), findOne: jest.fn() },
    Team: { findByPk: jest.fn() },
    User: { findByPk: jest.fn() },
    ViperInstance: { findOne: jest.fn(), findAll: jest.fn() },
    sequelize: { query: jest.fn() }
}));

import db from '../../../models';

const mockDb = db as unknown as {
    ContainerImage: { findAll: jest.Mock };
    ViperInstance: { findOne: jest.Mock; findAll: jest.Mock };
};

const ADMIN = { id: 1, username: 'admin', email: 'a@x.org', role: UserRole.ADMIN, teamId: null };
const TEAM_ADMIN = { id: 2, username: 'ta', email: 't@x.org', role: UserRole.TEAM_ADMIN, teamId: 5 };
const LEADER = { id: 3, username: 'lead', email: 'l@x.org', role: UserRole.TEAM_LEADER, teamId: 5 };
const MEMBER = { id: 4, username: 'mem', email: 'm@x.org', role: UserRole.MEMBER, teamId: 5 };

function buildApp(user?: any) {
    const app = express();
    app.use(express.json());
    app.set('view engine', 'handlebars');
    app.engine('handlebars', (_p: string, _o: any, cb: any) => cb(null, 'ok'));
    app.use((req: any, _res, next) => {
        if (user) req.user = user;
        next();
    });
    app.use('/images', require('../../../routes/images').default);
    return app;
}

describe('image pool routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.ContainerImage.findAll.mockResolvedValue([]);
    });

    describe('who may manage the pool', () => {
        it.each([
            ['POST', '/images/api/pool'],
            ['GET', '/images/api/host']
        ])('should refuse %s %s for a team admin', async (method, path) => {
            const agent = request(buildApp(TEAM_ADMIN));
            const response = method === 'POST' ? await agent.post(path).send({}) : await agent.get(path);

            expect(response.status).toBe(403);
        });

        it('should refuse an unauthenticated caller', async () => {
            await request(buildApp()).get('/images/api/pool').expect(401);
        });

        it('should refuse a plain member even reading the pool', async () => {
            await request(buildApp(MEMBER)).get('/images/api/pool').expect(403);
        });

        it.each([
            ['admin', ADMIN],
            ['team admin', TEAM_ADMIN],
            ['team leader', LEADER]
        ])('should let a %s read the pool', async (_label, user) => {
            await request(buildApp(user)).get('/images/api/pool').expect(200);
        });
    });

    describe('POST /images/api/pool', () => {
        it('should answer 202, because the row exists before the bytes do', async () => {
            mockService.addImageFromRegistry.mockResolvedValue({
                id: 1, reference: 'ghcr.io/x/y:1', name: 'Y', status: 'pending'
            });

            const response = await request(buildApp(ADMIN))
                .post('/images/api/pool')
                .send({ reference: 'ghcr.io/x/y:1', name: 'Y' });

            expect(response.status).toBe(202);
            expect(response.body.status).toBe('pending');
        });

        it('should attribute the row to the admin who added it', async () => {
            mockService.addImageFromRegistry.mockResolvedValue({ id: 1, reference: 'r', name: 'n' });

            await request(buildApp(ADMIN)).post('/images/api/pool').send({ reference: 'r', name: 'n' });

            expect(mockService.addImageFromRegistry).toHaveBeenCalledWith(
                expect.objectContaining({ createdById: ADMIN.id })
            );
        });

        it('should pass a rejection back as a 400 with its reason', async () => {
            mockService.addImageFromRegistry.mockRejectedValue(new Error('That image is blocked from use as a desktop'));

            const response = await request(buildApp(ADMIN)).post('/images/api/pool').send({ reference: 'mysql:8' });

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/blocked/);
        });
    });

    describe('PUT /images/api/team/:teamId/default', () => {
        it('should let a team admin set their own team default', async () => {
            mockService.setTeamDefault.mockResolvedValue({ id: 5, name: 'preservation', defaultImageId: 9 });

            await request(buildApp(TEAM_ADMIN))
                .put('/images/api/team/5/default')
                .send({ imageId: 9 })
                .expect(200);

            expect(mockService.setTeamDefault).toHaveBeenCalledWith(5, 9);
        });

        it('should refuse a team admin setting another team default', async () => {
            const response = await request(buildApp(TEAM_ADMIN))
                .put('/images/api/team/6/default')
                .send({ imageId: 9 });

            expect(response.status).toBe(403);
            expect(mockService.setTeamDefault).not.toHaveBeenCalled();
        });

        it('should refuse a team leader, who may choose but not decide for others', async () => {
            await request(buildApp(LEADER))
                .put('/images/api/team/5/default')
                .send({ imageId: 9 })
                .expect(403);
        });

        it('should let a system admin set any team default', async () => {
            mockService.setTeamDefault.mockResolvedValue({ id: 6, name: 'archives', defaultImageId: 9 });

            await request(buildApp(ADMIN))
                .put('/images/api/team/6/default')
                .send({ imageId: 9 })
                .expect(200);
        });

        it('should treat a null imageId as clearing the default', async () => {
            mockService.setTeamDefault.mockResolvedValue({ id: 5, name: 'preservation', defaultImageId: null });

            await request(buildApp(ADMIN))
                .put('/images/api/team/5/default')
                .send({ imageId: null })
                .expect(200);

            expect(mockService.setTeamDefault).toHaveBeenCalledWith(5, null);
        });
    });

    describe('POST /images/api/commit/:instanceUUID', () => {
        beforeEach(() => {
            mockDb.ViperInstance.findOne.mockResolvedValue({
                id: 3, uuid: 'inst123abc45', dockerid: 'c1', isBuildInstance: true
            });
            mockService.commitInstanceToImage.mockResolvedValue({
                id: 77, reference: 'forensics:latest', name: 'Forensics', source: 'commit', status: 'available'
            });
        });

        it('should commit a build instance for an admin', async () => {
            const response = await request(buildApp(ADMIN))
                .post('/images/api/commit/inst123abc45')
                .send({ name: 'Forensics', promoteDesktop: true });

            expect(response.status).toBe(201);
            expect(mockService.commitInstanceToImage).toHaveBeenCalledWith(
                expect.objectContaining({ uuid: 'inst123abc45' }),
                expect.objectContaining({ name: 'Forensics', promoteDesktop: true, createdById: ADMIN.id })
            );
        });

        it('should refuse to commit an ordinary instance', async () => {
            // An ordinary instance had sudo stripped, so nobody could have
            // customised it, and committing one would just clone the base image
            // with somebody's home directory in it.
            mockDb.ViperInstance.findOne.mockResolvedValue({
                id: 4, uuid: 'inst123abc45', dockerid: 'c2', isBuildInstance: false
            });

            const response = await request(buildApp(ADMIN))
                .post('/images/api/commit/inst123abc45')
                .send({ name: 'Sneaky' });

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/build instance/i);
            expect(mockService.commitInstanceToImage).not.toHaveBeenCalled();
        });

        it('should refuse a non-admin', async () => {
            await request(buildApp(TEAM_ADMIN))
                .post('/images/api/commit/inst123abc45')
                .send({ name: 'Forensics' })
                .expect(403);
        });

        it('should require a name', async () => {
            const response = await request(buildApp(ADMIN))
                .post('/images/api/commit/inst123abc45')
                .send({});

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/name is required/i);
        });

        it('should answer 404 for an instance that does not exist', async () => {
            mockDb.ViperInstance.findOne.mockResolvedValue(null);

            await request(buildApp(ADMIN))
                .post('/images/api/commit/nope12345678')
                .send({ name: 'Forensics' })
                .expect(404);
        });
    });

    describe('DELETE /images/api/pool/:imageId', () => {
        it('should forward the force flag for an image built here', async () => {
            mockService.removeImage.mockResolvedValue(undefined);

            await request(buildApp(ADMIN))
                .delete('/images/api/pool/7')
                .send({ force: true })
                .expect(200);

            expect(mockService.removeImage).toHaveBeenCalledWith(7, { force: true });
        });

        it('should default to not forcing', async () => {
            mockService.removeImage.mockResolvedValue(undefined);

            await request(buildApp(ADMIN)).delete('/images/api/pool/7').expect(200);

            expect(mockService.removeImage).toHaveBeenCalledWith(7, { force: false });
        });

        it('should refuse a non-admin', async () => {
            await request(buildApp(LEADER)).delete('/images/api/pool/7').expect(403);
            expect(mockService.removeImage).not.toHaveBeenCalled();
        });
    });
});
