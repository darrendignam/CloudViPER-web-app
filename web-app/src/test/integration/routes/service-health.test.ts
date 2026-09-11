import request from 'supertest';
import express from 'express';
import session from 'express-session';
import { UserRole } from '../../../types/UserRole';

// Simple mocks for health endpoint
const mockDockerPing = jest.fn();

jest.mock('dockerode', () => {
    return jest.fn().mockImplementation(() => ({
        ping: mockDockerPing
    }));
});

jest.mock('../../../models', () => ({
    ContainerImage: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
    Team: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), findOrCreate: jest.fn() },
    ViperInstance: {
        count: jest.fn()
    },
    User: {
        count: jest.fn()
    },
    sequelize: {
        authenticate: jest.fn()
    }
}));

// Import after mocking
import db from '../../../models';
import serviceRouter from '../../../routes/service';

/**
 * Integration tests for Service Health Endpoint
 * 
 * This test suite covers the /health endpoint which provides system health status
 * including database connectivity, Docker status, and basic statistics.
 * 
 * Target Coverage Areas:
 * - GET /health (basic health check)
 * - Database connectivity verification  
 * - Docker service health
 * - Admin statistics inclusion
 * - Authentication requirements
 * - Error handling scenarios
 */

describe('Service Health Endpoint', () => {
    // Test user data
    const TEST_USERS = {
        ADMIN: { id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN },
        MEMBER: { id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER },
        USER: { id: 3, username: 'user', email: 'user@test.com', role: UserRole.USER }
    };

    // Helper function to create test app with authentication
    const createTestApp = (user?: any) => {
        const testApp = express();
        testApp.use(session({
            secret: 'test-secret',
            resave: false,
            saveUninitialized: false,
            cookie: { secure: false }
        }));
        testApp.use(express.json());
        testApp.use(express.urlencoded({ extended: true }));
        
        if (user) {
            testApp.use((req, res, next) => {
                req.user = user;
                next();
            });
        }
        
        testApp.use('/service', serviceRouter);
        return testApp;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Setup default successful mocks
        (db.sequelize.authenticate as jest.Mock).mockResolvedValue(undefined);
        (db.User.count as jest.Mock).mockResolvedValue(10);
        (db.ViperInstance.count as jest.Mock).mockResolvedValue(5);
        mockDockerPing.mockResolvedValue('OK');
    });

    describe('GET /health', () => {
        it('should return healthy status for authenticated user', async () => {
            const testApp = createTestApp(TEST_USERS.MEMBER);
            
            const response = await request(testApp)
                .get('/service/health');

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                status: 'healthy',
                timestamp: expect.any(String),
                uptime: expect.any(Number),
                environment: expect.any(String),
                database: { status: 'connected' },
                docker: { status: 'connected' }
            });
        });

        it('should return 401 for unauthenticated request', async () => {
            const testApp = createTestApp(); // No user

            const response = await request(testApp)
                .get('/service/health');

            expect(response.status).toBe(401);
            expect(response.body.error).toBe('Authentication required');
        });

        it('should return degraded status when database fails', async () => {
            const testApp = createTestApp(TEST_USERS.MEMBER);
            
            (db.sequelize.authenticate as jest.Mock).mockRejectedValue(new Error('DB connection failed'));

            const response = await request(testApp)
                .get('/service/health');

            expect(response.status).toBe(503);
            expect(response.body.status).toBe('degraded');
            expect(response.body.database).toEqual({
                status: 'error',
                message: 'DB connection failed'
            });
            expect(response.body.docker).toEqual({ status: 'connected' });
        });

        it('should return degraded status when docker fails', async () => {
            const testApp = createTestApp(TEST_USERS.MEMBER);
            
            // Mock docker ping to fail
            mockDockerPing.mockRejectedValue(new Error('Docker unavailable'));

            const response = await request(testApp)
                .get('/service/health');

            expect(response.status).toBe(503);
            expect(response.body.status).toBe('degraded');
            expect(response.body.database).toEqual({ status: 'connected' });
            expect(response.body.docker).toEqual({
                status: 'error',
                message: 'Docker unavailable'
            });
        });

        it('should return additional statistics for admin users', async () => {
            const testApp = createTestApp(TEST_USERS.ADMIN);
            
            (db.ViperInstance.count as jest.Mock)
                .mockResolvedValueOnce(8) // total instances
                .mockResolvedValueOnce(6); // active instances

            const response = await request(testApp)
                .get('/service/health');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('healthy');
            expect(response.body.statistics).toEqual({
                totalInstances: 8,
                activeInstances: 6,
                totalUsers: 10,
                memoryUsage: expect.any(Object)
            });
        });

        it('should handle statistics gathering errors for admin', async () => {
            const testApp = createTestApp(TEST_USERS.ADMIN);
            
            (db.ViperInstance.count as jest.Mock).mockRejectedValue(new Error('Stats error'));

            const response = await request(testApp)
                .get('/service/health');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('healthy');
            expect(response.body.statistics).toEqual({
                error: 'Failed to gather statistics'
            });
        });

        it('should handle complete health check failure', async () => {
            const testApp = createTestApp(TEST_USERS.MEMBER);
            
            // Mock both database and docker to fail
            (db.sequelize.authenticate as jest.Mock).mockRejectedValue(new Error('DB connection failed'));
            mockDockerPing.mockRejectedValue(new Error('Docker unavailable'));

            const response = await request(testApp)
                .get('/service/health');

            expect(response.status).toBe(503);
            expect(response.body.status).toBe('degraded');
            expect(response.body.database.status).toBe('error');
            expect(response.body.docker.status).toBe('error');
        });

        it('should include correct environment information', async () => {
            const testApp = createTestApp(TEST_USERS.MEMBER);
            
            const response = await request(testApp)
                .get('/service/health');

            expect(response.status).toBe(200);
            expect(response.body.environment).toBeDefined();
            expect(typeof response.body.environment).toBe('string');
            expect(response.body.uptime).toBeGreaterThan(0);
        });

        it('should include memory usage information for admin', async () => {
            const testApp = createTestApp(TEST_USERS.ADMIN);
            
            const response = await request(testApp)
                .get('/service/health');

            expect(response.status).toBe(200);
            expect(response.body.statistics.memoryUsage).toEqual({
                rss: expect.any(Number),
                heapTotal: expect.any(Number),
                heapUsed: expect.any(Number),
                external: expect.any(Number),
                arrayBuffers: expect.any(Number)
            });
        });

        it('should not include statistics for non-admin users', async () => {
            const testApp = createTestApp(TEST_USERS.MEMBER);
            
            const response = await request(testApp)
                .get('/service/health');

            expect(response.status).toBe(200);
            expect(response.body.statistics).toBeUndefined();
        });
    });
});
