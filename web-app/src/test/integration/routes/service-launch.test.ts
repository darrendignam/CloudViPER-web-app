import request from 'supertest';
import express from 'express';
import path from 'path';
import exphbs from '../../../config/handlebars';
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
    default: { grantInstanceAccess: jest.fn(), revokeInstanceAccess: jest.fn() }
}));

import db from '../../../models';
import viperInstanceService from '../../../services/ViperInstanceService';

const mockDb = db as unknown as {
    ViperInstance: { findOne: jest.Mock };
    User: { findByPk: jest.Mock };
};
const mockService = viperInstanceService as unknown as {
    grantInstanceAccess: jest.Mock;
    revokeInstanceAccess: jest.Mock;
};

const OWNER = { id: 42, username: 'owner', email: 'owner@example.org', role: UserRole.MEMBER, team: 'preservation' };
const INSTANCE = { id: 3, uuid: 'inst123abc45', name: 'viper-cloud-inst123abc45', url: 'inst123abc45.example.org', owner: 42 };

function frameSource(html: string): string {
    const match = html.match(/<iframe[\s\S]*?src="([^"]+)"/);
    if (!match) throw new Error('no iframe found in rendered page');
    return match[1];
}

function decodeHtmlEntities(value: string): string {
    return value.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                .replace(/&amp;/g, '&');
}

function buildApp(user?: any) {
    const app = express();
    app.set('views', path.join(__dirname, '../../../views'));
    app.engine('handlebars', exphbs.engine);
    app.set('view engine', 'handlebars');
    app.use((req, _res, next) => {
        if (user) (req as any).user = user;
        next();
    });
    app.use('/service', require('../../../routes/service').default);
    return app;
}

describe('Service launch and proxy auth routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.ViperInstance.findOne.mockResolvedValue(INSTANCE);
        mockService.grantInstanceAccess.mockResolvedValue('minted-session-token');
    });

    describe('GET /service/launch/:instanceUUID', () => {
        it('should mint a token and frame the desktop for the owner', async () => {
            const response = await request(buildApp(OWNER)).get('/service/launch/inst123abc45').expect(200);

            expect(mockService.grantInstanceAccess).toHaveBeenCalledWith(INSTANCE);
            expect(response.text).toContain('<iframe');
            // Handlebars escapes "=" to "&#x3D;" in the src attribute. Browsers
            // decode character references inside attribute values, so the URL
            // requested is the unescaped one; assert against that.
            expect(decodeHtmlEntities(frameSource(response.text))).toBe(
                'http://inst123abc45.example.org/?token=minted-session-token'
            );
        });

        it('should keep the token out of the address bar by never redirecting to it', async () => {
            const response = await request(buildApp(OWNER)).get('/service/launch/inst123abc45');

            expect(response.status).toBe(200);
            expect(response.headers.location).toBeUndefined();
        });

        it('should send Referrer-Policy: no-referrer so the token cannot leak onward', async () => {
            const response = await request(buildApp(OWNER)).get('/service/launch/inst123abc45');

            expect(response.headers['referrer-policy']).toBe('no-referrer');
        });

        it('should allow an admin to launch an instance they do not own', async () => {
            const admin = { ...OWNER, id: 99, role: UserRole.ADMIN };

            await request(buildApp(admin)).get('/service/launch/inst123abc45').expect(200);

            expect(mockService.grantInstanceAccess).toHaveBeenCalled();
        });

        it('should reject an unauthenticated caller with 401', async () => {
            await request(buildApp()).get('/service/launch/inst123abc45').expect(401);

            expect(mockService.grantInstanceAccess).not.toHaveBeenCalled();
        });

        it('should reject a signed-in stranger with 403 and mint nothing', async () => {
            const stranger = { ...OWNER, id: 77, team: 'other' };

            const response = await request(buildApp(stranger)).get('/service/launch/inst123abc45').expect(403);

            expect(response.body.error).toContain('own or team instances');
            expect(mockService.grantInstanceAccess).not.toHaveBeenCalled();
        });

        it('should allow a team leader on the same real team', async () => {
            mockDb.User.findByPk.mockResolvedValue({ id: 42, team: 'preservation' });
            const leader = { ...OWNER, id: 88, role: UserRole.TEAM_LEADER, team: 'preservation' };

            await request(buildApp(leader)).get('/service/launch/inst123abc45').expect(200);
        });

        it('should not treat the default team "none" as a shared team', async () => {
            mockDb.User.findByPk.mockResolvedValue({ id: 42, team: 'none' });
            const teamlessLeader = { ...OWNER, id: 88, role: UserRole.TEAM_LEADER, team: 'none' };

            await request(buildApp(teamlessLeader)).get('/service/launch/inst123abc45').expect(403);

            expect(mockService.grantInstanceAccess).not.toHaveBeenCalled();
        });

        it('should return 404 for an unknown instance', async () => {
            mockDb.ViperInstance.findOne.mockResolvedValue(null);

            await request(buildApp(OWNER)).get('/service/launch/unknownuuid1').expect(404);
        });

        it('should return 502 when the container control plane cannot be reached', async () => {
            mockService.grantInstanceAccess.mockRejectedValue(new Error('Could not reach control plane'));

            const response = await request(buildApp(OWNER)).get('/service/launch/inst123abc45').expect(502);

            expect(response.body.error).toBe('Could not prepare the instance for launch');
        });

        it('should never put the instance master token in the rendered page', async () => {
            mockDb.ViperInstance.findOne.mockResolvedValue({ ...INSTANCE, masterToken: 'super-secret-master' });

            const response = await request(buildApp(OWNER)).get('/service/launch/inst123abc45').expect(200);

            expect(response.text).not.toContain('super-secret-master');
        });

        it('should not leak the control plane failure detail to the caller', async () => {
            mockService.grantInstanceAccess.mockRejectedValue(new Error('Bearer master-token-abc rejected'));

            const response = await request(buildApp(OWNER)).get('/service/launch/inst123abc45');

            expect(response.text).not.toContain('master-token-abc');
        });
    });

    describe('GET /service/auth/instance/:instanceUUID', () => {
        it('should return 200 with an empty body for the owner', async () => {
            const response = await request(buildApp(OWNER)).get('/service/auth/instance/inst123abc45').expect(200);

            expect(response.text).toBe('');
        });

        it('should return 401 when there is no session', async () => {
            await request(buildApp()).get('/service/auth/instance/inst123abc45').expect(401);
        });

        it('should return 403 for a signed-in stranger', async () => {
            await request(buildApp({ ...OWNER, id: 77, team: 'other' }))
                .get('/service/auth/instance/inst123abc45')
                .expect(403);
        });

        it('should answer 403 rather than 404 for an unknown instance, so probing reveals nothing', async () => {
            mockDb.ViperInstance.findOne.mockResolvedValue(null);

            await request(buildApp(OWNER)).get('/service/auth/instance/unknownuuid1').expect(403);
        });

        it('should deny rather than admit when the lookup itself fails', async () => {
            mockDb.ViperInstance.findOne.mockRejectedValue(new Error('database unavailable'));

            await request(buildApp(OWNER)).get('/service/auth/instance/inst123abc45').expect(403);
        });
    });
});
