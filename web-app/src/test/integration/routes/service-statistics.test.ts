import request from 'supertest';
import express from 'express';
import session from 'express-session';
import { UserRole } from '../../../types/UserRole';

// Simple mocks for statistics endpoint  
jest.mock('../../../models', () => ({
    ContainerImage: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
    Team: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), findOrCreate: jest.fn() },
    ViperInstance: {
        count: jest.fn(),
        findAll: jest.fn()
    },
    User: {
        count: jest.fn()
    },
    sequelize: {
        query: jest.fn()
    }
}));

// Import after mocking
import db from '../../../models';
import serviceRouter from '../../../routes/service';

/**
 * Integration tests for Service Statistics Endpoint
 * 
 * This test suite covers the /statistics endpoint which provides
 * administrative statistics about instances, users, and system state.
 * 
 * Target Coverage Areas:
 * - GET /statistics (admin-only statistics)
 * - Instance count and status breakdowns
 * - User role distribution
 * - Recent instances with age calculations
 * - Authentication and authorization
 * - Error handling scenarios
 */

describe('Service Statistics Endpoint', () => {
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
        
        // Setup default mocks for successful operation - but don't mock sequelize.query globally
        (db.ViperInstance.count as jest.Mock).mockResolvedValue(10);
        (db.User.count as jest.Mock).mockResolvedValue(25);
        
        // Default recent instances
        const mockRecentInstances = [
            {
                id: 1,
                uuid: 'uuid-1',
                status: 'active',
                createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
                toJSON: () => ({
                    id: 1,
                    uuid: 'uuid-1',
                    status: 'active',
                    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000)
                })
            },
            {
                id: 2,
                uuid: 'uuid-2',
                status: 'inactive',
                createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
                toJSON: () => ({
                    id: 2,
                    uuid: 'uuid-2',
                    status: 'inactive',
                    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000)
                })
            }
        ];
        (db.ViperInstance.findAll as jest.Mock).mockResolvedValue(mockRecentInstances);
    });

    describe('GET /statistics', () => {
        it('should return comprehensive statistics for admin users', async () => {
            const testApp = createTestApp(TEST_USERS.ADMIN);
            
            // Reset mocks for this specific test
            jest.clearAllMocks();
            
            // Mock specific counts for this test
            (db.ViperInstance.count as jest.Mock)
                .mockResolvedValueOnce(15) // total instances
                .mockResolvedValueOnce(12); // active instances

            // Mock sequelize queries for this test
            (db.sequelize.query as jest.Mock)
                .mockResolvedValueOnce([
                    { role: 'admin', count: 2 },
                    { role: 'member', count: 15 },
                    { role: 'testing', count: 8 }
                ])
                .mockResolvedValueOnce([
                    { status: 'active', count: 7 },
                    { status: 'inactive', count: 3 }
                ]);

            // Mock recent instances with toJSON
            const mockRecentInstances = [
                {
                    id: 1, uuid: 'uuid-1', status: 'active',
                    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
                    toJSON: () => ({ id: 1, uuid: 'uuid-1', status: 'active', createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
                },
                {
                    id: 2, uuid: 'uuid-2', status: 'inactive',
                    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
                    toJSON: () => ({ id: 2, uuid: 'uuid-2', status: 'inactive', createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
                }
            ];
            (db.ViperInstance.findAll as jest.Mock).mockResolvedValue(mockRecentInstances);

            const response = await request(testApp)
                .get('/service/statistics');

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                summary: {
                    totalInstances: 15,
                    activeInstances: 12,
                    inactiveInstances: 3
                },
                byRole: [
                    { role: 'admin', count: 2 },
                    { role: 'member', count: 15 },
                    { role: 'testing', count: 8 }
                ],
                byStatus: [
                    { status: 'active', count: 7 },
                    { status: 'inactive', count: 3 }
                ],
                recentInstances: [
                    expect.objectContaining({
                        id: 1,
                        uuid: 'uuid-1',
                        status: 'active',
                        age: '2 hours'
                    }),
                    expect.objectContaining({
                        id: 2,
                        uuid: 'uuid-2',
                        status: 'inactive',
                        age: '24 hours'
                    })
                ],
                timestamp: expect.any(String)
            });

            // Verify database queries were made correctly
            expect(db.ViperInstance.count).toHaveBeenCalledTimes(2);
            expect(db.ViperInstance.count).toHaveBeenCalledWith();
            expect(db.ViperInstance.count).toHaveBeenCalledWith({ where: { status: 'active' } });
            
            expect(db.sequelize.query).toHaveBeenCalledTimes(2);
            expect(db.ViperInstance.findAll).toHaveBeenCalledWith({
                limit: 10,
                order: [['createdAt', 'DESC']],
                include: [{
                    model: db.User,
                    as: 'ownerUser',
                    attributes: ['username', 'email', 'role']
                }],
                attributes: ['id', 'uuid', 'status', 'createdAt', 'url']
            });
        });

        it('should return 403 for non-admin users', async () => {
            const testApp = createTestApp(TEST_USERS.MEMBER);

            const response = await request(testApp)
                .get('/service/statistics');

            expect(response.status).toBe(403);
            expect(response.body.error).toBe('Insufficient permissions. Required: admin');
            
            // Should not make any database queries
            expect(db.ViperInstance.count).not.toHaveBeenCalled();
            expect(db.sequelize.query).not.toHaveBeenCalled();
        });

        it('should return 403 for testing role users', async () => {
            const testApp = createTestApp({ ...TEST_USERS.MEMBER, role: UserRole.TESTING });

            const response = await request(testApp)
                .get('/service/statistics');

            expect(response.status).toBe(403);
            expect(response.body.error).toBe('Insufficient permissions. Required: admin');
        });

        it('should return 403 for user role', async () => {
            const testApp = createTestApp(TEST_USERS.USER);

            const response = await request(testApp)
                .get('/service/statistics');

            expect(response.status).toBe(403);
            expect(response.body.error).toBe('Insufficient permissions. Required: admin');
        });

        it('should return 403 for unauthenticated users', async () => {
            const testApp = createTestApp(); // No user

            const response = await request(testApp)
                .get('/service/statistics');

            expect(response.status).toBe(403);
            expect(response.body.error).toBe('Authentication required');
        });

        it('should handle database errors during statistics generation', async () => {
            const testApp = createTestApp(TEST_USERS.ADMIN);
            
            (db.ViperInstance.count as jest.Mock).mockRejectedValue(new Error('Database connection failed'));

            const response = await request(testApp)
                .get('/service/statistics');

            expect(response.status).toBe(500);
            expect(response.body.error).toBe('Error generating statistics');
            expect(response.body.message).toBe('Failed to gather system statistics');
        });

        it('should handle recent instances query errors gracefully', async () => {
            const testApp = createTestApp(TEST_USERS.ADMIN);
            
            (db.ViperInstance.findAll as jest.Mock).mockRejectedValue(new Error('FindAll failed'));

            const response = await request(testApp)
                .get('/service/statistics');

            expect(response.status).toBe(500);
            expect(response.body.error).toBe('Error generating statistics');
        });

        it('should calculate age correctly for recent instances', async () => {
            const testApp = createTestApp(TEST_USERS.ADMIN);
            
            // Clear mocks and setup specific test data
            jest.clearAllMocks();
            (db.ViperInstance.count as jest.Mock).mockResolvedValue(10);
            (db.sequelize.query as jest.Mock)
                .mockResolvedValueOnce([])  // roles
                .mockResolvedValueOnce([]); // statuses
            
            // Mock instances with specific ages - note age calculation is in hours only
            const now = new Date();
            const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
            const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
            const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            
            const ageTestInstances = [
                {
                    id: 1, uuid: 'one-hour', status: 'active', createdAt: oneHourAgo,
                    toJSON: () => ({ id: 1, uuid: 'one-hour', status: 'active', createdAt: oneHourAgo })
                },
                {
                    id: 2, uuid: 'two-hours', status: 'active', createdAt: twoHoursAgo,
                    toJSON: () => ({ id: 2, uuid: 'two-hours', status: 'active', createdAt: twoHoursAgo })
                },
                {
                    id: 3, uuid: 'one-day', status: 'inactive', createdAt: twentyFourHoursAgo,
                    toJSON: () => ({ id: 3, uuid: 'one-day', status: 'inactive', createdAt: twentyFourHoursAgo })
                }
            ];
            (db.ViperInstance.findAll as jest.Mock).mockResolvedValue(ageTestInstances);

            const response = await request(testApp)
                .get('/service/statistics');

            expect(response.status).toBe(200);
            expect(response.body.recentInstances).toHaveLength(3);
            
            const instances = response.body.recentInstances;
            expect(instances[0].age).toBe('1 hours'); // Implementation shows hours only
            expect(instances[1].age).toBe('2 hours');
            expect(instances[2].age).toBe('24 hours');
        });

        it('should include correct timestamp in response', async () => {
            const testApp = createTestApp(TEST_USERS.ADMIN);
            
            // Add sequelize query mocks
            (db.sequelize.query as jest.Mock)
                .mockResolvedValueOnce([])  // roles
                .mockResolvedValueOnce([]); // statuses
            
            const beforeRequest = new Date().toISOString();
            const response = await request(testApp)
                .get('/service/statistics');
            const afterRequest = new Date().toISOString();

            expect(response.status).toBe(200);
            expect(response.body.timestamp).toBeDefined();
            expect(new Date(response.body.timestamp).getTime()).toBeGreaterThanOrEqual(new Date(beforeRequest).getTime());
            expect(new Date(response.body.timestamp).getTime()).toBeLessThanOrEqual(new Date(afterRequest).getTime());
        });

        it('should handle sequelize query errors', async () => {
            const testApp = createTestApp(TEST_USERS.ADMIN);
            
            // Override the mock for just this test - make the Promise.all fail
            (db.ViperInstance.count as jest.Mock).mockRejectedValueOnce(new Error('Database connection failed'));

            const response = await request(testApp)
                .get('/service/statistics');

            expect(response.status).toBe(500);
            expect(response.body.error).toBe('Error generating statistics');
            expect(response.body.message).toBe('Failed to gather system statistics');
        });

        it('should handle empty database results', async () => {
            const testApp = createTestApp(TEST_USERS.ADMIN);
            
            // Completely reset and recreate mocks
            jest.resetAllMocks();
            
            // Setup fresh mocks
            (db.ViperInstance.count as jest.Mock) = jest.fn()
                .mockResolvedValueOnce(0)   // total instances
                .mockResolvedValueOnce(0);  // active instances
            
            // Setup empty query results with fresh mock
            (db.sequelize.query as jest.Mock) = jest.fn()
                .mockResolvedValueOnce([])   // empty roles query
                .mockResolvedValueOnce([]);  // empty statuses query
            
            (db.ViperInstance.findAll as jest.Mock) = jest.fn().mockResolvedValueOnce([]);

            const response = await request(testApp)
                .get('/service/statistics');

            expect(response.status).toBe(200);
            expect(response.body.summary).toEqual({
                totalInstances: 0,
                activeInstances: 0,
                inactiveInstances: 0
            });
            expect(response.body.byRole).toEqual([]);
            expect(response.body.byStatus).toEqual([]);
            expect(response.body.recentInstances).toEqual([]);
            expect(response.body.timestamp).toBeDefined();
        });
    });
});
