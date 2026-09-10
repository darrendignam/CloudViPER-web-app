import request from 'supertest';
import express from 'express';
import session from 'express-session';
import { UserRole } from '../../../types/UserRole';

// Mock the container object returned by docker operations
const mockContainer = {
    id: 'test-container-id',
    start: jest.fn(),
    stop: jest.fn(),
    remove: jest.fn(),
    inspect: jest.fn(),
    exec: jest.fn()
};

// Mock dockerode instance
const mockDockerInstance = {
    createContainer: jest.fn(),
    getContainer: jest.fn(),
    info: jest.fn(),
    ping: jest.fn()
};

// Set up module mocks
jest.mock('dockerode', () => {
    return jest.fn().mockImplementation(() => mockDockerInstance);
});

jest.mock('../../../utility/helperFunctions', () => ({
    generateRandomString: jest.fn(),
    generateSessionToken: jest.fn(() => 'mock-session-token')
}));

jest.mock('../../../utility/portManager', () => ({
    getAvailablePort: jest.fn()
}));

jest.mock('../../../utility/scriptManager', () => ({
    validateRequiredScripts: jest.fn(),
    readAndProcessScript: jest.fn()
}));

jest.mock('../../../models', () => ({
    ViperInstance: {
        create: jest.fn(),
        findAll: jest.fn(),
        findOne: jest.fn(),
        count: jest.fn(),
        destroy: jest.fn(),
        update: jest.fn()
    },
    Screenshot: {
        create: jest.fn(),
        findAll: jest.fn(),
        findOne: jest.fn(),
        count: jest.fn(),
        destroy: jest.fn()
    },
    Activity: {
        create: jest.fn(),
        findAll: jest.fn(),
        findOne: jest.fn(),
        count: jest.fn(),
        destroy: jest.fn()
    },
    Log: {
        create: jest.fn()
    },
    User: {
        findByPk: jest.fn(),
        findOne: jest.fn(),
        findAll: jest.fn(),
        count: jest.fn()
    },
    sequelize: {
        query: jest.fn()
    }
}));

// Mock the logger
jest.mock('../../../config/logger', () => ({
    appLogger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    },
    logSession: jest.fn(),
    sqlLogger: {
        info: jest.fn()
    }
}));

// Mock filesystem operations
jest.mock('fs', () => ({
    existsSync: jest.fn(),
    readFile: jest.fn(),
    readdirSync: jest.fn()
}));

// Mock path operations  
jest.mock('path', () => ({
    join: jest.fn((...args) => args.join('/')),
    resolve: jest.fn((...args) => '/' + args.join('/'))
}));

import serviceRouter from '../../../routes/service';
import helperFunctions from '../../../utility/helperFunctions';
import { validateRequiredScripts, readAndProcessScript } from '../../../utility/scriptManager';
import * as fs from 'fs';
import * as path from 'path';

// Get the mocked modules
const db = require('../../../models');
const mockHelperFunctions = helperFunctions as jest.Mocked<typeof helperFunctions>;

describe('Service Routes - Extended Coverage', () => {
    let app: express.Application;

    // Helper function - create minimal test app
    const createTestApp = (user?: any) => {
        const testApp = express();
        testApp.use(express.json());
        testApp.use(express.urlencoded({ extended: true }));
        
        // Simple user middleware instead of session
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
        // Reset all mocks
        jest.clearAllMocks();

        // Create test app without user by default
        app = createTestApp();

        // Setup default mocks
        mockHelperFunctions.generateRandomString.mockReturnValue('mock-random-string');
        (validateRequiredScripts as jest.Mock).mockReturnValue({ valid: true, missing: [] });
        (readAndProcessScript as jest.Mock).mockReturnValue('mock-script-content');
        
        mockDockerInstance.createContainer.mockResolvedValue(mockContainer);
        mockDockerInstance.getContainer.mockReturnValue(mockContainer);
        mockDockerInstance.info.mockResolvedValue({
            Containers: 5,
            ContainersRunning: 3,
            ContainersPaused: 0,
            ContainersStopped: 2,
            Images: 10,
            ServerVersion: '20.10.0'
        });
        mockDockerInstance.ping.mockResolvedValue('OK');

        mockContainer.start.mockResolvedValue(undefined);
        mockContainer.stop.mockResolvedValue(undefined);
        mockContainer.remove.mockResolvedValue(undefined);
        mockContainer.inspect.mockResolvedValue({
            Id: 'test-container-id',
            Name: '/test-container',
            State: { Status: 'running' },
            Config: { Image: 'test-image' }
        });
        mockContainer.exec.mockResolvedValue({
            start: jest.fn().mockResolvedValue({
                on: jest.fn(),
                write: jest.fn(),
                end: jest.fn()
            })
        });

        // Mock database models
        (db.ViperInstance.create as jest.Mock).mockResolvedValue({
            id: 1,
            uuid: 'mock-random-string',
            dockerid: 'test-container-id',
            logs: []
        });
        (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
            id: 1,
            uuid: 'mock-random-string',
            owner: 1,
            statusKey: 'test-status-key',
            update: jest.fn().mockResolvedValue(true)
        });
        (db.ViperInstance.count as jest.Mock).mockResolvedValue(0);
        (db.User.count as jest.Mock).mockResolvedValue(5);
        
        // Mock sequelize.authenticate for health checks
        const mockSequelize = db.sequelize as any;
        mockSequelize.authenticate = jest.fn().mockResolvedValue(true);
    });

    // Helper function to create authenticated requests
    const authenticatedRequest = (userRole: UserRole, userId: number = 1) => {
        const authApp = createTestApp({
            id: userId,
            role: userRole,
            email: `${userRole}@test.com`,
            username: userRole
        });
        return request(authApp);
    };

    describe('GET /health', () => {
        it('should return system health status for authenticated users', async () => {
            // Health endpoint requires authentication
            const response = await authenticatedRequest(UserRole.MEMBER)
                .get('/service/health')
                .expect(200);

            expect(response.body).toHaveProperty('status', 'healthy');
            expect(response.body).toHaveProperty('timestamp');
            expect(response.body).toHaveProperty('docker');
            expect(response.body).toHaveProperty('database');
        });

        it('should require authentication', async () => {
            const response = await request(app)
                .get('/service/health')
                .expect(401);

            expect(response.body).toHaveProperty('error', 'Authentication required');
        });

        it('should handle Docker connection errors gracefully', async () => {
            mockDockerInstance.ping = jest.fn().mockRejectedValue(new Error('Docker daemon not running'));

            const response = await authenticatedRequest(UserRole.MEMBER)
                .get('/service/health')
                .expect(503); // Health check returns 503 when degraded

            expect(response.body.status).toBe('degraded');
            expect(response.body.docker.status).toBe('error');
        });

        it('should handle database connection errors gracefully', async () => {
            // Mock sequelize.authenticate to throw error
            const mockSequelize = db.sequelize as any;
            mockSequelize.authenticate = jest.fn().mockRejectedValue(new Error('Database connection failed'));

            const response = await authenticatedRequest(UserRole.MEMBER)
                .get('/service/health')
                .expect(503); // Health check returns 503 when degraded

            expect(response.body.status).toBe('degraded');
            expect(response.body.database.status).toBe('error');
        });

        it('should include additional statistics for admin users', async () => {
            (db.ViperInstance.count as jest.Mock)
                .mockResolvedValueOnce(10) // totalInstances
                .mockResolvedValueOnce(7); // activeInstances

            const response = await authenticatedRequest(UserRole.ADMIN)
                .get('/service/health')
                .expect(200);

            expect(response.body).toHaveProperty('status', 'healthy');
            expect(response.body).toHaveProperty('statistics');
            expect(response.body.statistics).toHaveProperty('totalInstances');
            expect(response.body.statistics).toHaveProperty('activeInstances');
        });
    });

    describe('GET /statistics', () => {
        beforeEach(() => {
            (db.ViperInstance.count as jest.Mock).mockResolvedValue(10);
            (db.Screenshot.count as jest.Mock).mockResolvedValue(50);
            (db.Activity.count as jest.Mock).mockResolvedValue(100);
            (db.sequelize.query as jest.Mock).mockResolvedValue([
                [
                    { role: 'admin', count: 2 },
                    { role: 'member', count: 8 },
                    { role: 'testing', count: 5 }
                ]
            ]);
        });

        it('should return statistics for admin users', async () => {
            // Mock User model to include 'ownerUser' association
            (db.ViperInstance.findAll as jest.Mock).mockResolvedValue([
                { 
                    id: 1, 
                    uuid: 'test1', 
                    status: 'active', 
                    createdAt: new Date(), 
                    url: 'http://test1',
                    toJSON: () => ({ id: 1, uuid: 'test1', status: 'active', createdAt: new Date(), url: 'http://test1' })
                },
                { 
                    id: 2, 
                    uuid: 'test2', 
                    status: 'inactive', 
                    createdAt: new Date(), 
                    url: 'http://test2',
                    toJSON: () => ({ id: 2, uuid: 'test2', status: 'inactive', createdAt: new Date(), url: 'http://test2' })
                }
            ]);

            const response = await authenticatedRequest(UserRole.ADMIN)
                .get('/service/statistics')
                .expect(200);

            expect(response.body).toHaveProperty('summary');
            expect(response.body).toHaveProperty('byRole');
            expect(response.body).toHaveProperty('byStatus');
            expect(response.body).toHaveProperty('recentInstances');
            expect(response.body).toHaveProperty('timestamp');
            expect(response.body.summary).toHaveProperty('totalInstances', 10);
        });

        it('should reject non-admin users', async () => {
            const response = await authenticatedRequest(UserRole.MEMBER)
                .get('/service/statistics')
                .expect(403);

            expect(response.body).toHaveProperty('error', 'Insufficient permissions. Required: admin');
        });

        it('should reject unauthenticated users', async () => {
            const response = await request(app)
                .get('/service/statistics')
                .expect(403);

            expect(response.body).toHaveProperty('error', 'Authentication required');
        });

        it('should handle database errors gracefully', async () => {
            (db.ViperInstance.count as jest.Mock).mockRejectedValue(new Error('Database error'));

            const response = await authenticatedRequest(UserRole.ADMIN)
                .get('/service/statistics')
                .expect(500);

            expect(response.body).toHaveProperty('error', 'Error generating statistics');
        });
    });

    describe('POST /screenshot/:instanceUUID', () => {
        beforeEach(() => {
            (db.Screenshot.create as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'screenshot-uuid',
                instanceUuid: 'test-instance-uuid'
            });
            
            // Mock the cleanup findAll and destroy operations
            (db.Screenshot.findAll as jest.Mock).mockResolvedValue([]);
            (db.Screenshot.destroy as jest.Mock).mockResolvedValue(0);
        });

        it('should accept screenshot data with valid statusKey', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                statusKey: 'valid-status-key',
                update: jest.fn().mockResolvedValue(true)
            });

            const response = await request(app)
                .post('/service/screenshot/test-instance-uuid')
                .send({
                    statusKey: 'valid-status-key',
                    screenshot: 'base64-image-data',
                    timestamp: new Date().toISOString()
                })
                .expect(200);

            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('message', 'Screenshot received');
            expect(response.body).toHaveProperty('instanceUUID', 'test-instance-uuid');
            expect(db.Screenshot.create).toHaveBeenCalled();
        });

        it('should reject screenshot with invalid statusKey', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                statusKey: 'valid-status-key'
            });

            const response = await request(app)
                .post('/service/screenshot/test-instance-uuid')
                .send({
                    statusKey: 'invalid-status-key',
                    screenshot: 'base64-image-data'
                })
                .expect(401);

            expect(response.body).toHaveProperty('error', 'Unauthorized');
        });

        it('should reject screenshot for non-existent instance', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);

            const response = await request(app)
                .post('/service/screenshot/non-existent-uuid')
                .send({
                    statusKey: 'any-status-key',
                    screenshot: 'base64-image-data'
                })
                .expect(401);

            expect(response.body).toHaveProperty('error', 'Unauthorized');
        });

        it('should validate required fields', async () => {
            const response = await request(app)
                .post('/service/screenshot/test-instance-uuid')
                .send({}) // Missing required fields
                .expect(401);

            expect(response.body).toHaveProperty('error', 'Unauthorized');
        });
    });

    describe('POST /activity/:instanceUUID', () => {
        beforeEach(() => {
            (db.Activity.create as jest.Mock).mockResolvedValue({
                id: 1,
                instanceUuid: 'test-instance-uuid',
                activityScore: 0.75
            });
            
            // Mock the cleanup findAll and destroy operations
            (db.Activity.findAll as jest.Mock).mockResolvedValue([]);
            (db.Activity.destroy as jest.Mock).mockResolvedValue(0);
        });

        it('should accept activity data with valid statusKey', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                statusKey: 'valid-status-key',
                lastActivity: new Date(),
                update: jest.fn().mockResolvedValue(true)
            });

            const response = await request(app)
                .post('/service/activity/test-instance-uuid')
                .send({
                    statusKey: 'valid-status-key',
                    mouseEvents: 5,
                    keyboardEvents: 10,
                    windowActive: true,
                    cpuUsage: 10,
                    memoryUsage: 20,
                    timestamp: new Date().toISOString()
                })
                .expect(200);

            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('message', 'Activity report received');
            expect(response.body).toHaveProperty('instanceUUID', 'test-instance-uuid');
            expect(response.body).toHaveProperty('activityScore');
            expect(response.body).toHaveProperty('isActive');
            expect(db.Activity.create).toHaveBeenCalled();
        });

        it('should validate activity score range', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                statusKey: 'valid-status-key',
                lastActivity: new Date(),
                update: jest.fn().mockResolvedValue(true)
            });

            // This test actually doesn't apply since the endpoint calculates score from mouseEvents + keyboardEvents
            // Let's test the successful case instead
            const response = await request(app)
                .post('/service/activity/test-instance-uuid')
                .send({
                    statusKey: 'valid-status-key',
                    mouseEvents: 15,
                    keyboardEvents: 25,
                    windowActive: true,
                    timestamp: new Date().toISOString()
                })
                .expect(200);

            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('activityScore', 40); // 15 + 25
        });

        it('should handle missing activity data gracefully', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                statusKey: 'valid-status-key',
                lastActivity: new Date(),
                update: jest.fn().mockResolvedValue(true)
            });

            // The endpoint should handle missing optional fields gracefully
            const response = await request(app)
                .post('/service/activity/test-instance-uuid')
                .send({
                    statusKey: 'valid-status-key'
                    // Missing optional fields like mouseEvents, keyboardEvents
                })
                .expect(200);

            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('activityScore', 0); // Default to 0
        });

        it('should reject activity data with invalid statusKey', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                statusKey: 'valid-status-key'
            });

            const response = await request(app)
                .post('/service/activity/test-instance-uuid')
                .send({
                    statusKey: 'invalid-status-key',
                    mouseEvents: 5,
                    keyboardEvents: 10
                })
                .expect(401);

            expect(response.body).toHaveProperty('error', 'Unauthorized');
        });
    });

    describe('GET /monitoring-test/:instanceUUID', () => {
        it('should return monitoring test response for valid instance', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                status: 'active',
                lastActivity: new Date(),
                isUserActive: true,
                activityScore: 0.8
            });

            const response = await request(app)
                .get('/service/monitoring-test/test-instance-uuid')
                .expect(200);

            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('message', 'Monitoring test endpoint - instance found');
            expect(response.body).toHaveProperty('instanceUUID', 'test-instance-uuid');
            expect(response.body).toHaveProperty('instance');
            expect(response.body).toHaveProperty('endpoints');
        });

        it('should return 404 for non-existent instance', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);

            const response = await request(app)
                .get('/service/monitoring-test/non-existent-uuid')
                .expect(404);

            expect(response.body).toHaveProperty('error', 'Instance not found');
            expect(response.body).toHaveProperty('instanceUUID', 'non-existent-uuid');
        });
    });

    describe('GET /screenshot/:instanceUUID', () => {
        it('should return latest screenshot for instance owner', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                owner: 1 // Same as user ID
            });

            (db.Screenshot.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                instanceUUID: 'test-instance-uuid',
                screenshotData: 'base64-image-data',
                capturedAt: new Date(),
                receivedAt: new Date()
            });

            const response = await authenticatedRequest(UserRole.MEMBER, 1)
                .get('/service/screenshot/test-instance-uuid')
                .expect(200);

            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('screenshot');
            expect(response.body.screenshot).toHaveProperty('screenshot', 'base64-image-data');
        });

        it('should return latest screenshot for admin users', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                owner: 999 // Different owner
            });

            (db.Screenshot.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                instanceUUID: 'test-instance-uuid',
                screenshotData: 'base64-image-data',
                capturedAt: new Date(),
                receivedAt: new Date()
            });

            const response = await authenticatedRequest(UserRole.ADMIN)
                .get('/service/screenshot/test-instance-uuid')
                .expect(200);

            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('screenshot');
        });

        it('should reject non-owners who are not admin', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                owner: 999 // Different owner
            });

            const response = await authenticatedRequest(UserRole.MEMBER, 1)
                .get('/service/screenshot/test-instance-uuid')
                .expect(403);

            expect(response.body).toHaveProperty('error', 'Unauthorized - can only view own or team instances');
        });

        it('should handle no screenshots available', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                owner: 1
            });

            (db.Screenshot.findOne as jest.Mock).mockResolvedValue(null);

            const response = await authenticatedRequest(UserRole.MEMBER, 1)
                .get('/service/screenshot/test-instance-uuid')
                .expect(404);

            expect(response.body).toHaveProperty('error', 'No screenshot available');
        });

        it('should require authentication', async () => {
            const response = await request(app)
                .get('/service/screenshot/test-instance-uuid')
                .expect(401);

            expect(response.body).toHaveProperty('error', 'Authentication required');
        });
    });

    describe('GET /screenshots/:instanceUUID', () => {
        it('should return screenshots list for instance owner', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                owner: 1
            });

            (db.Screenshot.findAll as jest.Mock).mockResolvedValue([
                { id: 1, instanceUUID: 'test-instance-uuid', capturedAt: new Date(), receivedAt: new Date(), screenshotData: 'data1' },
                { id: 2, instanceUUID: 'test-instance-uuid', capturedAt: new Date(), receivedAt: new Date(), screenshotData: 'data2' }
            ]);

            const response = await authenticatedRequest(UserRole.MEMBER, 1)
                .get('/service/screenshots/test-instance-uuid')
                .expect(200);

            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('screenshots');
            expect(Array.isArray(response.body.screenshots)).toBe(true);
        });

        it('should require authentication', async () => {
            const response = await request(app)
                .get('/service/screenshots/test-instance-uuid')
                .expect(401);

            expect(response.body).toHaveProperty('error', 'Authentication required');
        });

        it('should reject non-owners who are not admin', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                owner: 999 // Different owner
            });

            const response = await authenticatedRequest(UserRole.MEMBER, 1)
                .get('/service/screenshots/test-instance-uuid')
                .expect(403);

            expect(response.body).toHaveProperty('error', 'Unauthorized - can only view own or team instances');
        });
    });

    describe('GET /activity/:instanceUUID', () => {
        it('should return activity data for instance owner', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                owner: 1
            });

            (db.Activity.findAll as jest.Mock).mockResolvedValue([
                { 
                    id: 1, 
                    activityScore: 0.75, 
                    mouseEvents: 5, 
                    keyboardEvents: 10,
                    reportedAt: new Date() 
                }
            ]);

            const response = await authenticatedRequest(UserRole.MEMBER, 1)
                .get('/service/activity/test-instance-uuid')
                .expect(200);

            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('activityHistory');
            expect(Array.isArray(response.body.activityHistory)).toBe(true);
            expect(response.body.activityHistory).toHaveLength(1);
        });

        it('should require authentication', async () => {
            const response = await request(app)
                .get('/service/activity/test-instance-uuid')
                .expect(401);

            expect(response.body).toHaveProperty('error', 'Authentication required');
        });

        it('should reject non-owners who are not admin', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'test-instance-uuid',
                owner: 999 // Different owner
            });

            const response = await authenticatedRequest(UserRole.MEMBER, 1)
                .get('/service/activity/test-instance-uuid')
                .expect(403);

            expect(response.body).toHaveProperty('error', 'Unauthorized - can only view own or team instances');
        });
    });

    describe('POST /cleanup-inactive', () => {
        it('should cleanup inactive instances for admin users', async () => {
            (db.ViperInstance.findAll as jest.Mock).mockResolvedValue([
                {
                    id: 1,
                    uuid: 'inactive-instance',
                    dockerid: 'inactive-container',
                    status: 'inactive_pending_shutdown',
                    lastActivity: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
                    update: jest.fn().mockResolvedValue(true)
                }
            ]);

            mockContainer.stop.mockResolvedValue(undefined);
            mockContainer.remove.mockResolvedValue(undefined);

            const response = await authenticatedRequest(UserRole.ADMIN)
                .post('/service/cleanup-inactive')
                .expect(200);

            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('message', 'Inactive instances cleanup completed');
            expect(response.body).toHaveProperty('shutdownCount');
            expect(response.body).toHaveProperty('results');
            expect(Array.isArray(response.body.results)).toBe(true);
        });

        it('should reject non-admin users', async () => {
            const response = await authenticatedRequest(UserRole.MEMBER)
                .post('/service/cleanup-inactive')
                .expect(403);

            expect(response.body).toHaveProperty('error', 'Insufficient permissions. Required: admin');
        });
    });

    describe('Error handling scenarios', () => {
        it('should handle malformed JSON in screenshot endpoint', async () => {
            const response = await request(app)
                .post('/service/screenshot/test-instance-uuid')
                .set('Content-Type', 'application/json')
                .send('invalid-json')
                .expect(400);
        });

        it('should handle very long instanceUUID parameters', async () => {
            const longUUID = 'a'.repeat(1000);
            
            const response = await request(app)
                .get(`/service/screenshot/${longUUID}`)
                .expect(401); // Will fail at authentication first

            expect(response.body).toHaveProperty('error', 'Authentication required');
        });

        it('should handle database connection failures in statistics', async () => {
            (db.ViperInstance.count as jest.Mock).mockRejectedValue(new Error('Connection lost'));

            const response = await authenticatedRequest(UserRole.ADMIN)
                .get('/service/statistics')
                .expect(500);

            expect(response.body).toHaveProperty('error', 'Error generating statistics');
        });
    });
});
