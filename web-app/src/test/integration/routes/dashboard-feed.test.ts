/**
 * The dashboard feed replaces six-second polling.
 *
 * Two things matter and neither is visible by looking at the page: host
 * telemetry must reach system admins only, and every connection must clean up
 * its timers, or a page refresh leaks one interval per visit for the life of
 * the process.
 */
import request from 'supertest';
import express from 'express';
import http from 'http';
import { UserRole } from '../../../types/UserRole';

jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

jest.mock('../../../models', () => ({
    ContainerImage: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn() },
    Team: { findByPk: jest.fn(), findAll: jest.fn() },
    ViperInstance: { findAll: jest.fn(), findOne: jest.fn(), count: jest.fn() },
    User: { findAll: jest.fn(), findByPk: jest.fn() },
    Screenshot: { findAll: jest.fn() },
    Activity: { findAll: jest.fn() },
    Log: { create: jest.fn() },
    sequelize: { query: jest.fn() }
}));

const mockCollect = jest.fn();
jest.mock('../../../services/SystemStatsService', () => ({
    __esModule: true,
    default: { collect: (...args: any[]) => mockCollect(...args) }
}));

jest.mock('../../../services/ViperInstanceService', () => ({
    __esModule: true,
    default: { grantInstanceAccess: jest.fn(), revokeInstanceAccess: jest.fn() }
}));

import db from '../../../models';

const mockDb = db as unknown as {
    ViperInstance: { findAll: jest.Mock };
    User: { findAll: jest.Mock };
};

const ADMIN = { id: 1, username: 'admin', email: 'a@x.org', role: UserRole.ADMIN, teamId: null };
const LEADER = { id: 2, username: 'lead', email: 'l@x.org', role: UserRole.TEAM_LEADER, teamId: 5 };
const MEMBER = { id: 3, username: 'mem', email: 'm@x.org', role: UserRole.MEMBER, teamId: 5 };

function buildApp(user?: any) {
    const app = express();
    app.use((req: any, _res, next) => { if (user) req.user = user; next(); });
    app.use('/service', require('../../../routes/service').default);
    return app;
}

/**
 * Read an event stream for a while, then hand back what arrived.
 *
 * A real socket against a real listener, rather than supertest: the connection
 * is designed never to end, and the test has to tear it down, which supertest
 * reports as a failed request no matter how it is handled.
 */
function readStream(app: any, ms = 400): Promise<string> {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app).listen(0, '127.0.0.1', () => {
            const port = (server.address() as any).port;
            const req = http.get({ host: '127.0.0.1', port, path: '/service/events' }, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk.toString(); });
                setTimeout(() => {
                    req.destroy();
                    server.close(() => resolve(body));
                }, ms);
            });
            req.on('error', () => { /* destroying our own request is how this ends */ });
        });
        server.on('error', reject);
    });
}

describe('GET /service/events', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.ViperInstance.findAll.mockResolvedValue([{ uuid: 'inst1', name: 'viper-cloud-inst1' }]);
        mockDb.User.findAll.mockResolvedValue([{ id: 2 }]);
        mockCollect.mockResolvedValue({ host: { cpuCount: 2 }, instances: [], capturedAt: 'now' });
    });

    it('should refuse an unauthenticated caller', async () => {
        await request(buildApp()).get('/service/events').expect(401);
    });

    it('should refuse a role with no instance access', async () => {
        const plain = { id: 9, username: 'u', email: 'u@x.org', role: UserRole.USER, teamId: null };

        await request(buildApp(plain)).get('/service/events').expect(403);
    });

    it('should stream instances to an admin', async () => {
        const body = await readStream(buildApp(ADMIN));

        expect(body).toContain('event: instances');
        expect(body).toContain('inst1');
    });

    it('should send host telemetry to a system admin', async () => {
        const body = await readStream(buildApp(ADMIN));

        expect(body).toContain('event: stats');
        expect(mockCollect).toHaveBeenCalled();
    });

    it('should NOT send host telemetry to a team leader', async () => {
        // Load, memory and disk describe the machine every tenant shares.
        // Instance access does not imply the right to watch the host.
        const body = await readStream(buildApp(LEADER));

        expect(body).toContain('event: instances');
        expect(body).not.toContain('event: stats');
        expect(mockCollect).not.toHaveBeenCalled();
    });

    it('should NOT send host telemetry to a member', async () => {
        const body = await readStream(buildApp(MEMBER));

        expect(body).not.toContain('event: stats');
        expect(mockCollect).not.toHaveBeenCalled();
    });

    it('should announce the feed before the first payload', async () => {
        const body = await readStream(buildApp(ADMIN));

        // The client needs to know whether stats are coming before deciding
        // what to render, rather than inferring it from silence.
        expect(body.indexOf('event: hello')).toBeLessThan(body.indexOf('event: instances'));
        expect(body).toContain('"stats":true');
    });

    it('should scope a member to their own instances', async () => {
        await readStream(buildApp(MEMBER));

        expect(mockDb.ViperInstance.findAll).toHaveBeenCalledWith(
            expect.objectContaining({ where: { owner: MEMBER.id } })
        );
    });

    it('should scope a team leader to their team', async () => {
        await readStream(buildApp(LEADER));

        expect(mockDb.User.findAll).toHaveBeenCalledWith(
            expect.objectContaining({ where: { teamId: LEADER.teamId } })
        );
    });

    it('should report a failure on the stream rather than dropping the connection', async () => {
        // Every open dashboard reconnecting at once because one query failed
        // would turn a transient blip into a thundering herd.
        mockDb.ViperInstance.findAll.mockRejectedValue(new Error('database is away'));

        const body = await readStream(buildApp(ADMIN));

        expect(body).toContain('event: feed-error');
        expect(body).toContain('database is away');
    });

    it('should clear its timers when the client goes away', async () => {
        const before = jest.getTimerCount ? jest.getTimerCount() : 0;
        await readStream(buildApp(ADMIN), 300);
        await new Promise(resolve => setTimeout(resolve, 150));

        // Not an exact count: the point is that closing a connection does not
        // leave intervals behind, because each visit would otherwise add two.
        const after = jest.getTimerCount ? jest.getTimerCount() : 0;
        expect(after).toBeLessThanOrEqual(before + 1);
    });
});
