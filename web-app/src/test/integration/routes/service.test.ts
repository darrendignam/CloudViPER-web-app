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
    getContainer: jest.fn()
};

// Set up module mocks with isolated module registry
jest.mock('dockerode', () => {
    return jest.fn().mockImplementation(() => mockDockerInstance);
});

jest.mock('../../../utility/helperFunctions', () => ({
    generateRandomString: jest.fn(),
    generateSessionToken: jest.fn(() => 'mock-session-token')
}));

jest.mock('../../../utility/portManager', () => ({
    getAvailablePort: jest.fn(),
    getMultipleAvailablePorts: jest.fn()
}));

jest.mock('../../../models', () => ({
    ContainerImage: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
    Team: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), findOrCreate: jest.fn() },
    ViperInstance: {
        create: jest.fn(),
        findAll: jest.fn(),
        findOne: jest.fn(),
        count: jest.fn(),
        destroy: jest.fn(),
        update: jest.fn()
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
    Screenshot: {
        create: jest.fn(),
        findAll: jest.fn(),
        findOne: jest.fn(),
        destroy: jest.fn()
    },
    Activity: {
        create: jest.fn(),
        findAll: jest.fn(),
        findOne: jest.fn(),
        destroy: jest.fn()
    },
    sequelize: {
        sync: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        authenticate: jest.fn(),
        query: jest.fn()
    }
}));

// Import after mocking
import db from '../../../models';
import helperFunctions from '../../../utility/helperFunctions';
import * as portManager from '../../../utility/portManager';
import serviceRouter from '../../../routes/service';

const mockedHelperFunctions = helperFunctions as jest.Mocked<typeof helperFunctions>;
const mockedPortManager = portManager as jest.Mocked<typeof portManager>;

/**
 * Integration tests for Service Routes
 * 
 * This test suite covers all service routes including:
 * - Role-based authentication and redirects
 * - Container management operations (create, terminate, inspect)
 * - Admin-only functionality
 * - Error handling and edge cases
 * - Environment configuration testing
 * 
 * Test Coverage: 70.22% (42 tests)
 * All major functionality is tested including Docker operations,
 * database interactions, and user authentication flows.
 */

describe('Service Routes', () => {
    let mockExec: any;
    let mockStream: any;

    // Test data constants for better maintainability
    const TEST_USERS = {
        ADMIN: { id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN },
        TESTING: { id: 2, username: 'tester', email: 'test@test.com', role: UserRole.TESTING },
        MEMBER: { id: 3, username: 'member', email: 'member@test.com', role: UserRole.MEMBER },
        USER: { id: 4, username: 'user', email: 'user@test.com', role: UserRole.USER }
    };

    const TEST_CONTAINERS = {
        VALID_ID: 'test-container-id',
        NONEXISTENT_ID: 'nonexistent-container'
    };

    const TEST_RESPONSES = {
        AUTH_ERROR: { error: "Authentication" },
        ADMIN_REQUIRED: { message: 'Admin access required' },
        ERROR_4: { message: 'Error 4' },
        INSTANCE_NOT_FOUND: { message: 'Instance not found' }
    };

    // Helper function to create test app with authentication
    const createTestApp = (user?: any) => {
        const testApp = express();
        
        // Set up a mock view engine for rendering
        testApp.set('view engine', 'ejs');
        testApp.set('views', '/mock/views'); // Non-existent path
        
        // Mock the render function to avoid file system operations
        testApp.use((req, res, next) => {
            const originalRender = res.render;
            res.render = function(view: string, options?: any) {
                // Just send a simple response instead of rendering a template
                res.status(200).send(`<html><body>Mock ${view} page</body></html>`);
            };
            next();
        });
        
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

    // Helper function to create mock ViperInstance
    const createMockViperInstance = (overrides = {}) => ({
        id: 1,
        uuid: 'mock-random-string',
        dockerid: TEST_CONTAINERS.VALID_ID,
        name: 'viper-cloud-mock-random-string',
        url: 'mock-random-string.localhost',
        masterToken: 'mock-random-string',
        statusKey: 'mock-random-string',
        owner: 1,
        status: 'created',
        logs: [{ timestamp: expect.any(Date), message: "Created" }],
        ...overrides
    });

    // Helper function to setup common mocks
    const setupCommonMocks = () => {
        mockedHelperFunctions.generateRandomString.mockReturnValue('mock-random-string');
        mockedPortManager.getAvailablePort.mockResolvedValue(3001);
        mockedPortManager.getMultipleAvailablePorts.mockResolvedValue([3010, 3011]);
        
        // Mock database models with default implementations
        (db.ViperInstance.create as jest.Mock).mockResolvedValue(createMockViperInstance());
        (db.ViperInstance.findAll as jest.Mock).mockResolvedValue([]);
        (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);
        (db.ViperInstance.count as jest.Mock).mockResolvedValue(0);
        (db.ViperInstance.destroy as jest.Mock).mockResolvedValue(1);
        (db.ViperInstance.update as jest.Mock).mockResolvedValue([1]); // Sequelize update returns [affectedCount]

        (db.Log.create as jest.Mock).mockResolvedValue({});

        (db.User.findByPk as jest.Mock).mockResolvedValue(null);
        (db.User.findOne as jest.Mock).mockResolvedValue(null);
        (db.User.findAll as jest.Mock).mockResolvedValue([]);

        // Mock new models
        (db.Screenshot.create as jest.Mock).mockResolvedValue({});
        (db.Screenshot.findAll as jest.Mock).mockResolvedValue([]);
        (db.Screenshot.findOne as jest.Mock).mockResolvedValue(null);
        (db.Screenshot.destroy as jest.Mock).mockResolvedValue(1);

        (db.Activity.create as jest.Mock).mockResolvedValue({});
        (db.Activity.findAll as jest.Mock).mockResolvedValue([]);
        (db.Activity.findOne as jest.Mock).mockResolvedValue(null);
        (db.Activity.destroy as jest.Mock).mockResolvedValue(1);
    };

    // Helper functions for common test patterns
    const expectRedirect = (response: any, expectedLocation: string) => {
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(expectedLocation);
    };

    const expectPageRender = (response: any, expectedPageContent: string) => {
        expect(response.status).toBe(200);
        expect(response.text).toContain(expectedPageContent);
    };

    const expectUnauthorized = (response: any) => {
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe('/login');
    };

    const expectJsonResponse = (response: any, expectedStatus: number, expectedData?: any) => {
        expect(response.status).toBe(expectedStatus);
        expect(response.headers['content-type']).toMatch(/json/);
        if (expectedData) {
            expect(response.body).toMatchObject(expectedData);
        }
    };

    beforeAll(async () => {
        // Mock database setup - no real database needed
    });

    beforeEach(() => {
        // Clear all mocks to prevent interference between tests
        jest.clearAllMocks();
        
        // Reset all mock implementations to default state
        setupCommonMocks();
        
        // Setup Docker mocks
        mockStream = {
            on: jest.fn().mockImplementation((event, callback) => {
                if (event === 'data') {
                    callback(Buffer.from('test output'));
                } else if (event === 'end') {
                    setTimeout(callback, 10);
                }
            })
        };

        mockExec = {
            start: jest.fn().mockResolvedValue(mockStream)
        };

        // Reset mock implementations with test data
        mockContainer.start.mockResolvedValue(undefined);
        mockContainer.exec.mockResolvedValue(mockExec);
        mockContainer.inspect.mockResolvedValue({
            Id: TEST_CONTAINERS.VALID_ID,
            State: { Status: 'running' },
            Config: {
                Image: 'test-image',
                // Orphan teardown refuses a container that does not claim to be
                // one of ours.
                Labels: { 'org.openpreservation.cloudviper.instance': 'test-uuid' }
            }
        });
        // DockerContainerService awaits these, so they resolve rather than
        // taking a callback.
        mockContainer.stop.mockResolvedValue(undefined);
        mockContainer.remove.mockResolvedValue(undefined);

        // Setup Docker instance mocks
        mockDockerInstance.createContainer.mockResolvedValue(mockContainer);
        mockDockerInstance.getContainer.mockReturnValue(mockContainer);
    });

    afterEach(() => {
        // Clean up any lingering state
        jest.clearAllMocks();
    });

    afterAll(async () => {
        // Clean up mocks
        jest.clearAllMocks();
    });

    describe('GET /', () => {
        it('should redirect admin users to /service/admin', async () => {
            const testApp = createTestApp(TEST_USERS.ADMIN);
            const response = await request(testApp).get('/service/');
            expectRedirect(response, '/service/admin');
        });

        it('should redirect testing users to /service/testing', async () => {
            const testApp = createTestApp(TEST_USERS.TESTING);
            const response = await request(testApp).get('/service/');
            expectRedirect(response, '/service/testing');
        });

        it('should redirect member users to /service/member', async () => {
            const testApp = createTestApp(TEST_USERS.MEMBER);
            const response = await request(testApp).get('/service/');
            expectRedirect(response, '/service/member');
        });

        it('should redirect users with default role to /account', async () => {
            const testApp = createTestApp(TEST_USERS.USER);
            const response = await request(testApp).get('/service/');
            expectRedirect(response, '/account');
        });

        it('should redirect unauthenticated users to login', async () => {
            const testApp = createTestApp(); // No user
            const response = await request(testApp).get('/service/');
            expectRedirect(response, '/account/login');
        });

        it('should handle invalid user role gracefully', async () => {
            const invalidUser = { ...TEST_USERS.USER, role: 'INVALID_ROLE' as any };
            const testApp = createTestApp(invalidUser);
            const response = await request(testApp).get('/service/');
            expectRedirect(response, '/account');
        });
    });

    describe('GET /admin', () => {
        it('should render admin page for admin users', async () => {
            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

            const response = await request(testApp).get('/service/admin');
            expect(response.status).toBe(200);
        });        it('should redirect non-admin users', async () => {
            const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });
            const response = await request(testApp).get('/service/admin');
            expect(response.status).toBe(302);
            expect(response.headers.location).toBe('/service');
        });

        it('should redirect unauthenticated users', async () => {
            const testApp = createTestApp(); // No user
            const response = await request(testApp).get('/service/admin');
            expect(response.status).toBe(302);
            expect(response.headers.location).toBe('/service');
        });
    });

    describe('GET /testing', () => {
        it('should render testing page for testing users', async () => {
            const testApp = createTestApp({ id: 2, username: 'tester', email: 'test@test.com', role: UserRole.TESTING });

            const response = await request(testApp).get('/service/testing');
            expect(response.status).toBe(200);
        });

        it('should allow admin users to access testing page', async () => {
            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
            const response = await request(testApp).get('/service/testing');
            expect(response.status).toBe(200);
        });
    });

    describe('GET /member', () => {
        it('should render member page for member users', async () => {
            const testApp = createTestApp({ id: 3, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

            const response = await request(testApp).get('/service/member');
            expect(response.status).toBe(200);
        });

        it('should allow admin users to access member page', async () => {
            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
            const response = await request(testApp).get('/service/member');
            expect(response.status).toBe(200);
        });
    });

    // SameSite 'lax' sends the session cookie on top-level GET navigation, so a
    // state-changing route reachable by GET can be driven from a third party
    // page with an <img> or a link. Both of these create or destroy containers.
    describe('CSRF surface', () => {
        it.each([
            '/service/new-instance',
            '/service/terminate-instance/test-container-id'
        ])('should not expose %s over GET', async (endpoint) => {
            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

            const response = await request(testApp).get(endpoint);

            expect(response.status).toBe(404);
        });
    });

    describe('POST /new-instance', () => {
        beforeEach(() => {
            // Mock ViperInstance creation
            (db.ViperInstance.create as jest.Mock).mockResolvedValue({
                id: 1,
                uuid: 'mock-random-string',
                dockerid: 'test-container-id',
                name: 'viper-cloud-mock-random-string',
                url: 'mock-random-string.localhost',
                masterToken: 'mock-random-string',
                statusKey: 'mock-random-string',
                owner: 1,
                status: 'created',
                logs: [{ timestamp: expect.any(Date), message: "Created" }]
            });
        });

        it('should create new instance for admin user', async () => {
            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

            const response = await request(testApp).post('/service/new-instance');
            
            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                success: true,
                message: "ViPER instance created successfully",
                container: {
                    id: 'test-container-id',
                    uuid: 'mock-random-string',
                    url: 'mock-random-string.localhost',
                    status: "created"
                }
            });

            expect(mockDockerInstance.createContainer).toHaveBeenCalled();
            expect(mockContainer.start).toHaveBeenCalled();
            expect(db.ViperInstance.create).toHaveBeenCalled();
        });

        it('should create new instance for testing user', async () => {
            const testApp = createTestApp({ id: 2, username: 'tester', email: 'test@test.com', role: UserRole.TESTING });
            const response = await request(testApp).post('/service/new-instance');
            expect(response.status).toBe(200);
            expect(mockDockerInstance.createContainer).toHaveBeenCalled();
        });

        it('should create new instance for member user', async () => {
            const testApp = createTestApp({ id: 3, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });
            const response = await request(testApp).post('/service/new-instance');
            expect(response.status).toBe(200);
            expect(mockDockerInstance.createContainer).toHaveBeenCalled();
        });

        it('should reject user role', async () => {
            const testApp = createTestApp({ id: 4, username: 'user', email: 'user@test.com', role: UserRole.USER });
            const response = await request(testApp).post('/service/new-instance');
            expect(response.status).toBe(403);
            expect(response.body).toEqual({ "error": "Insufficient permissions" });
            expect(mockDockerInstance.createContainer).not.toHaveBeenCalled();
        });

        it('should reject unauthenticated users', async () => {
            const testApp = createTestApp(); // No user
            const response = await request(testApp).post('/service/new-instance');
            expect(response.status).toBe(403);
            expect(response.body).toEqual({ "error": "Insufficient permissions" });
        });

        it('should handle Docker errors', async () => {
            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

            const dockerError = new Error('Docker failed');
            mockDockerInstance.createContainer.mockRejectedValue(dockerError);

            // Mock Log creation
            (db.Log.create as jest.Mock).mockResolvedValue({});

            const response = await request(testApp).post('/service/new-instance');
            
            expect(response.status).toBe(500);
            expect(response.body).toEqual({ 
                error: 'Error creating or starting container',
                message: "An error occurred while creating your ViPER instance. Please try again or contact support."
            });
            expect(db.Log.create).toHaveBeenCalledWith({
                eventType: 'Error',
                message: 'Error creating or starting container',
                eventDescription: dockerError.toString(),
                userId: 1,
                createdAt: expect.any(Date)
            });
        });
    });

    describe('GET /viperinstances', () => {
        it('should return all instances for admin', async () => {
            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

            const mockInstanceData = [
                { id: 1, uuid: 'test1', owner: 1, createdAt: new Date() },
                { id: 2, uuid: 'test2', owner: 2, createdAt: new Date() }
            ];

            // Mock instances with toJSON method like real Sequelize models
            const mockInstances = mockInstanceData.map(data => ({
                ...data,
                toJSON: () => data
            }));

            (db.ViperInstance.findAll as jest.Mock).mockResolvedValue(mockInstances);
            (db.ViperInstance.count as jest.Mock).mockResolvedValue(2);

            const response = await request(testApp).get('/service/viperinstances');
            
            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('instances');
            expect(response.body).toHaveProperty('total', 2);
            expect(response.body).toHaveProperty('userRole', 'admin');
            expect(response.body).toHaveProperty('canCreateNew', true);
            expect(response.body.instances).toHaveLength(2);
            expect(response.body.instances[0]).toHaveProperty('id', 1);
            expect(response.body.instances[0]).toHaveProperty('uuid', 'test1');
            expect(response.body.instances[0]).toHaveProperty('operationalHours');
            expect(response.body.instances[0]).toHaveProperty('canTerminate');
            expect(db.ViperInstance.findAll).toHaveBeenCalledWith({
                attributes: {
                    exclude: ['masterToken', 'statusKey', 'sessionTokens', 'lastScreenshot', 'activityHistory']
                },
                include: [{
                    model: db.User,
                    as: 'ownerUser',
                    attributes: ['id', 'username', 'email', 'firstName', 'lastName']
                }, {
                    model: db.Screenshot,
                    as: 'screenshots',
                    attributes: ['id', 'capturedAt', 'receivedAt'],
                    limit: 1,
                    order: [['createdAt', 'DESC']],
                    required: false
                }, {
                    model: db.Activity,
                    as: 'activities',
                    attributes: ['id', 'activityScore', 'reportedAt', 'receivedAt'],
                    limit: 1,
                    order: [['createdAt', 'DESC']],
                    required: false
                }],
                order: [['createdAt', 'DESC']]
            });
        });

        it('should return user instances for non-admin, non-user roles', async () => {
            const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

            const userInstanceData = [
                { id: 1, uuid: 'test1', owner: 2, createdAt: new Date() }
            ];

            // Mock instances with toJSON method like real Sequelize models
            const userInstances = userInstanceData.map(data => ({
                ...data,
                toJSON: () => data
            }));

            (db.ViperInstance.findAll as jest.Mock).mockResolvedValue(userInstances);
            (db.ViperInstance.count as jest.Mock).mockResolvedValue(1); // User at their limit (MEMBER role has limit of 1)

            const response = await request(testApp).get('/service/viperinstances');
            
            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('instances');
            expect(response.body).toHaveProperty('total', 1);
            expect(response.body).toHaveProperty('userRole', 'member');
            expect(response.body).toHaveProperty('canCreateNew', false); // MEMBER role limit is 1, user already has 1
            expect(response.body.instances).toHaveLength(1);
            expect(response.body.instances[0]).toHaveProperty('id', 1);
            expect(response.body.instances[0]).toHaveProperty('uuid', 'test1');
            expect(response.body.instances[0]).toHaveProperty('operationalHours');
            expect(response.body.instances[0]).toHaveProperty('canTerminate');
            expect(db.ViperInstance.findAll).toHaveBeenCalledWith({
                where: { owner: 2 },
                attributes: {
                    exclude: ['masterToken', 'statusKey', 'sessionTokens', 'lastScreenshot', 'activityHistory']
                },
                include: [{
                    model: db.User,
                    as: 'ownerUser',
                    attributes: ['id', 'username', 'email', 'firstName', 'lastName']
                }, {
                    model: db.Screenshot,
                    as: 'screenshots',
                    attributes: ['id', 'capturedAt', 'receivedAt'],
                    limit: 1,
                    order: [['createdAt', 'DESC']],
                    required: false
                }, {
                    model: db.Activity,
                    as: 'activities',
                    attributes: ['id', 'activityScore', 'reportedAt', 'receivedAt'],
                    limit: 1,
                    order: [['createdAt', 'DESC']],
                    required: false
                }],
                order: [['createdAt', 'DESC']]
            });
        });

        it('should return 403 for user role', async () => {
            const testApp = createTestApp({ id: 4, username: 'user', email: 'user@test.com', role: UserRole.USER });
            const response = await request(testApp).get('/service/viperinstances');
            
            expect(response.status).toBe(403);
            expect(response.body).toEqual({ error: 'Insufficient permissions. Required: testing or member or subscriber' });
        });

        it('should return 401 for unauthenticated users', async () => {
            const testApp = createTestApp(); // No user
            const response = await request(testApp).get('/service/viperinstances');
            
            expect(response.status).toBe(401);
            expect(response.body).toEqual({ error: 'Authentication required' });
        });

        it('should handle database errors for admin', async () => {
            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

            const dbError = new Error('Database error');
            (db.ViperInstance.findAll as jest.Mock).mockRejectedValue(dbError);

            const response = await request(testApp).get('/service/viperinstances');
            
            expect(response.status).toBe(500);
            expect(response.body.message).toBe('Failed to load instance list. Please try again.');
            expect(response.body.error).toBeDefined(); // Error objects get serialized differently
        });

        it('should handle database errors for non-admin users', async () => {
            const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

            const dbError = new Error('Database error');
            (db.ViperInstance.findAll as jest.Mock).mockRejectedValue(dbError);

            const response = await request(testApp).get('/service/viperinstances');
            
            expect(response.status).toBe(500);
            expect(response.body.message).toBe('Failed to load instance list. Please try again.');
            expect(response.body.error).toBeDefined(); // Error objects get serialized differently
        });
    });

    describe('POST /terminate-instance/:containerId', () => {
        let mockInstanceRow: any;

        beforeEach(() => {
            // A Sequelize instance, not a plain object: terminateInstance calls
            // instance.update to soft delete before touching the container.
            mockInstanceRow = {
                id: 7,
                dockerid: 'test-container-id',
                owner: 1,
                uuid: 'test-uuid',
                name: 'viper-cloud-test-uuid',
                masterToken: null,
                logs: [],
                update: jest.fn().mockResolvedValue(undefined)
            };
            (db.ViperInstance.findOne as jest.Mock) = jest.fn().mockResolvedValue(mockInstanceRow);
        });

        it('should successfully terminate container', async () => {
            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

            const response = await request(testApp).post('/service/terminate-instance/test-container-id');

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                success: true,
                message: 'Instance terminated successfully'
            });
            expect(mockDockerInstance.getContainer).toHaveBeenCalledWith('test-container-id');
            expect(mockContainer.stop).toHaveBeenCalled();
            expect(mockContainer.remove).toHaveBeenCalled();
        }, 10000);

        it('should soft delete the row rather than destroying it', async () => {
            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

            await request(testApp).post('/service/terminate-instance/test-container-id');

            expect(mockInstanceRow.update).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'deleted' })
            );
        }, 10000);

        it('should still report success when the container has already gone', async () => {
            mockContainer.stop.mockRejectedValue(new Error('No such container'));

            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
            const response = await request(testApp).post('/service/terminate-instance/test-container-id');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
        }, 10000);

        // Distinct from the case above: there, stop failed but the container was
        // removed, so termination did what it promised. Here the container is
        // still running while the row is already marked deleted, which hides it
        // from the orphan reclaim path. Reporting success would strand it.
        it('should treat an already-removed container as success', async () => {
            // Two terminations of the same instance race in practice: a click in
            // the dashboard and a scripted call, or two admins at once. The
            // loser gets a 404 about a container that has just been removed,
            // which is the outcome it wanted, not a failure needing attention.
            mockContainer.remove.mockRejectedValue(new Error('(HTTP code 404) no such container'));

            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
            const response = await request(testApp).post('/service/terminate-instance/test-container-id');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
        }, 10000);

        it('should report failure when the container could not be removed', async () => {
            mockContainer.remove.mockRejectedValue(new Error('device or resource busy'));

            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
            const response = await request(testApp).post('/service/terminate-instance/test-container-id');

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toMatch(/could not be removed/i);
        }, 10000);

        it('should tear down an orphaned container for an admin', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);

            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
            const response = await request(testApp).post('/service/terminate-instance/test-container-id');

            expect(response.status).toBe(200);
            expect(response.body.message).toBe('Orphaned container removed');
            expect(mockContainer.stop).toHaveBeenCalled();
            expect(mockContainer.remove).toHaveBeenCalled();
        }, 10000);

        it('should refuse to remove a container that is not a CloudViPER instance', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);
            // The orchestrator's own container, MySQL and the proxy all clear the
            // route's only check, that the id is ten characters or more.
            mockContainer.inspect.mockResolvedValue({ Config: { Image: 'mysql:8.0', Labels: {} } });

            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
            const response = await request(testApp).post('/service/terminate-instance/cloud-viper-mysqldb');

            expect(response.status).toBe(404);
            expect(mockContainer.remove).not.toHaveBeenCalled();
        }, 10000);

        it('should refuse a container it cannot inspect', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);
            mockContainer.inspect.mockRejectedValue(new Error('no such container'));

            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
            const response = await request(testApp).post('/service/terminate-instance/deadbeef1234');

            expect(response.status).toBe(404);
            expect(mockContainer.remove).not.toHaveBeenCalled();
        }, 10000);

        it('should still remove a container whose stop call fails', async () => {
            mockContainer.stop.mockRejectedValue(new Error('container already stopped'));

            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
            await request(testApp).post('/service/terminate-instance/test-container-id');

            // An exited container is exactly the state orphan teardown exists for,
            // and Docker rejects stop on one.
            expect(mockContainer.remove).toHaveBeenCalled();
        }, 10000);

        it('should refuse an orphaned container for a non-admin, who has no ownership to prove', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);

            const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });
            const response = await request(testApp).post('/service/terminate-instance/test-container-id');

            expect(response.status).toBe(404);
            expect(mockContainer.remove).not.toHaveBeenCalled();
        }, 10000);

        it('should reject a non-owner with 403 and leave the container running', async () => {
            const testApp = createTestApp({ id: 99, username: 'other', email: 'other@test.com', role: UserRole.MEMBER });
            const response = await request(testApp).post('/service/terminate-instance/test-container-id');

            expect(response.status).toBe(403);
            expect(mockContainer.remove).not.toHaveBeenCalled();
        }, 10000);

        it('should surface a database failure as a server error', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockRejectedValue(new Error('Database error'));

            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
            const response = await request(testApp).post('/service/terminate-instance/test-container-id');

            expect(response.status).toBe(500);
        }, 10000);
    });

    describe('GET /set-status-instance/:statuskey/:status', () => {
        it('should successfully update instance status', async () => {
            const mockInstance = {
                logs: [{ timestamp: new Date(), message: 'Initial log' }],
                status: 'active',
                save: jest.fn().mockResolvedValue(undefined),
                update: jest.fn().mockResolvedValue(undefined)
            };

            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(mockInstance);

            const testApp = createTestApp();
            const response = await request(testApp)
                .get('/service/set-status-instance/test-status-key/active');
            
            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                success: true,
                message: "Status updated successfully",
                instance: expect.objectContaining({
                    newStatus: 'active',
                    previousStatus: 'active'
                })
            });

            expect(db.ViperInstance.findOne).toHaveBeenCalledWith({
                where: { statusKey: 'test-status-key' }
            });

            expect(mockInstance.update).toHaveBeenCalledWith(expect.objectContaining({
                status: 'active',
                logs: expect.arrayContaining([
                    expect.objectContaining({
                        message: 'Status changed to: active'
                    })
                ])
            }));
        });

        it('should handle instance not found', async () => {
            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);

            const testApp = createTestApp();
            const response = await request(testApp)
                .get('/service/set-status-instance/nonexistent-key/active');
            
            expect(response.status).toBe(404);
            // The endpoint returns 404 when instance is not found
        });

        it('should handle database error', async () => {
            const dbError = new Error('Database error');
            (db.ViperInstance.findOne as jest.Mock).mockRejectedValue(dbError);

            const testApp = createTestApp();
            const response = await request(testApp)
                .get('/service/set-status-instance/test-status-key/active');
            
            expect(response.status).toBe(500);
            expect(response.body.error).toBeDefined(); // Error objects get serialized differently
        });

        it('should handle save error', async () => {
            const saveError = new Error('Save failed');
            const mockInstance = {
                logs: [],
                status: 'active',
                save: jest.fn().mockRejectedValue(saveError),
                update: jest.fn().mockRejectedValue(saveError)
            };

            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(mockInstance);

            const testApp = createTestApp();
            const response = await request(testApp)
                .get('/service/set-status-instance/test-status-key/active');
            
            expect(response.status).toBe(500);
            expect(response.body.error).toBeDefined(); // Error objects get serialized differently
        });
    });

    describe('Environment Variables and Configuration', () => {
        it('should use production configuration in prod environment', async () => {
            const originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'prod';

            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

            (db.ViperInstance.create as jest.Mock).mockResolvedValue({});

            await request(testApp).post('/service/new-instance');

            expect(mockDockerInstance.createContainer).toHaveBeenCalled();
            const createContainerCall = mockDockerInstance.createContainer.mock.calls[0][0];

            // Traefik watches this network; an instance that is not on it is
            // unreachable no matter how correct its labels are.
            expect(createContainerCall.NetworkingConfig.EndpointsConfig).toHaveProperty('cloudviper_ingress');
            expect(createContainerCall.HostConfig.PortBindings).toBeUndefined();

            // Routing comes from labels, not from VIRTUAL_HOST env vars.
            const labels = createContainerCall.Labels;
            expect(labels['traefik.enable']).toBe('true');
            expect(labels['traefik.docker.network']).toBe('cloudviper_ingress');
            expect(Object.keys(labels).some(key => key.endsWith('.rule'))).toBe(true);

            // The ownership label has to survive alongside the routing labels.
            // isCloudViPERInstance refuses to tear down a container without it,
            // so a Labels block that replaced rather than merged would disable
            // the guard that stops a stray id reaching MySQL or the app itself.
            expect(labels['org.openpreservation.cloudviper.instance']).toBeTruthy();

            // The nginx-proxy contract is gone: nothing reads these now, and
            // leaving them would imply a proxy that is not there.
            const envNames = createContainerCall.Env.map((entry: string) => entry.split('=')[0]);
            expect(envNames).not.toContain('VIRTUAL_HOST');
            expect(envNames).not.toContain('LETSENCRYPT_HOST');
            expect(envNames).not.toContain('ACME_PRE_HOOK');
            expect(envNames).not.toContain('ACME_POST_HOOK');
            expect(envNames).toContain('SELKIES_MASTER_TOKEN');

            process.env.NODE_ENV = originalEnv;
        });

        it('should use development configuration in dev environment', async () => {
            const originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'dev';

            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

            (db.ViperInstance.create as jest.Mock).mockResolvedValue({});

            await request(testApp).post('/service/new-instance');

            expect(mockDockerInstance.createContainer).toHaveBeenCalled();
            const createContainerCall = mockDockerInstance.createContainer.mock.calls[0][0];
            const portBindings = createContainerCall.HostConfig.PortBindings;

            expect(portBindings).toBeDefined();
            expect(portBindings['3000/tcp']).toEqual([{ HostPort: '3010' }]);

            // The control plane mints desktop access, and Docker's default
            // 0.0.0.0 binding bypasses a host firewall via its own iptables
            // rules, so this one must never leave the loopback address.
            expect(portBindings['8083/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '3011' }]);

            process.env.NODE_ENV = originalEnv;
        });
    });

    // Additional tests for the new admin-only routes
    describe('Admin-only routes', () => {
        describe('GET /viperinstance/:dockerid/inspect', () => {
        it('should return instance details for admin users', async () => {
            const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

            const mockInstance = {
                id: 1,
                dockerid: 'test-docker-id',
                createdAt: '2023-01-01T00:00:00.000Z', // Use string to match JSON serialization
                ownerUser: {
                    id: 1,
                    username: 'testuser',
                    email: 'test@example.com'
                }
            };

            const mockDockerInspect = {
                Id: 'test-docker-id',
                State: { Status: 'running' },
                Config: {
                Image: 'test-image',
                // Orphan teardown refuses a container that does not claim to be
                // one of ours.
                Labels: { 'org.openpreservation.cloudviper.instance': 'test-uuid' }
            }
            };

            (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(mockInstance);
            mockContainer.inspect = jest.fn().mockResolvedValue(mockDockerInspect);

            const response = await request(testApp).get('/service/viperinstance/test-docker-id/inspect');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('instance');
            expect(response.body).toHaveProperty('operationalHours');
            expect(response.body).toHaveProperty('dockerInspect');
            expect(response.body.instance).toEqual(mockInstance);
            expect(response.body.dockerInspect).toEqual(mockDockerInspect);
        });            it('should return 403 for non-admin users', async () => {
                const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

                const response = await request(testApp).get('/service/viperinstance/test-docker-id/inspect');

                expect(response.status).toBe(403);
                expect(response.body).toEqual({ message: 'Admin access required' });
            });

            it('should return 404 for non-existent instance', async () => {
                const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

                (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);

                const response = await request(testApp).get('/service/viperinstance/nonexistent/inspect');

                expect(response.status).toBe(404);
                expect(response.body).toEqual({ message: 'Instance not found' });
            });
        });

        describe('GET /logs/*', () => {
            it('should return 403 for session logs for non-admin', async () => {
                const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

                const response = await request(testApp).get('/service/logs/session');

                expect(response.status).toBe(403);
                expect(response.body).toEqual({ message: 'Admin access required' });
            });

            it('should return 403 for SQL logs for non-admin', async () => {
                const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

                const response = await request(testApp).get('/service/logs/sql');

                expect(response.status).toBe(403);
                expect(response.body).toEqual({ message: 'Admin access required' });
            });

            it('should return 403 for app logs for non-admin', async () => {
                const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

                const response = await request(testApp).get('/service/logs/app');

                expect(response.status).toBe(403);
                expect(response.body).toEqual({ message: 'Admin access required' });
            });

            it('should return 403 for log dates for non-admin', async () => {
                const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

                const response = await request(testApp).get('/service/logs/dates');

                expect(response.status).toBe(403);
                expect(response.body).toEqual({ message: 'Admin access required' });
            });
        });

        describe('GET /health', () => {
            it('should return healthy status for authenticated user', async () => {
                const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });
                
                // Mock successful database and docker connections
                (db.sequelize.authenticate as jest.Mock) = jest.fn().mockResolvedValue(undefined);
                (mockDockerInstance as any).ping = jest.fn().mockResolvedValue('OK');

                const response = await request(testApp).get('/service/health');

                expect(response.status).toBe(200);
                expect(response.body).toEqual(expect.objectContaining({
                    status: 'healthy',
                    timestamp: expect.any(String),
                    uptime: expect.any(Number),
                    environment: expect.any(String),
                    database: { status: 'connected' },
                    docker: { status: 'connected' }
                }));
            });

            it('should return 401 for unauthenticated request', async () => {
                const testApp = createTestApp(); // No user

                const response = await request(testApp).get('/service/health');

                expect(response.status).toBe(401);
                expect(response.body.error).toBe('Authentication required');
            });

            it('should return degraded status when database fails', async () => {
                const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });
                
                (db.sequelize.authenticate as jest.Mock) = jest.fn().mockRejectedValue(new Error('DB connection failed'));
                (mockDockerInstance as any).ping = jest.fn().mockResolvedValue('OK');

                const response = await request(testApp).get('/service/health');

                expect(response.status).toBe(503);
                expect(response.body.status).toBe('degraded');
                expect(response.body.database).toEqual({
                    status: 'error',
                    message: expect.any(String)
                });
            });

            it('should return additional statistics for admin users', async () => {
                const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
                
                (db.sequelize.authenticate as jest.Mock) = jest.fn().mockResolvedValue(undefined);
                (mockDockerInstance as any).ping = jest.fn().mockResolvedValue('OK');
                (db.ViperInstance.count as jest.Mock)
                    .mockResolvedValueOnce(5) // total instances
                    .mockResolvedValueOnce(3); // active instances
                (db.User.count as jest.Mock).mockResolvedValue(10);

                const response = await request(testApp).get('/service/health');

                expect(response.status).toBe(200);
                expect(response.body.statistics).toEqual({
                    totalInstances: 5,
                    activeInstances: 3,
                    totalUsers: 10,
                    memoryUsage: expect.any(Object)
                });
            });
        });

        describe('GET /statistics', () => {
            beforeEach(() => {
                jest.clearAllMocks();
                // Mock Sequelize query results for statistics
                (db.sequelize.query as jest.Mock)
                    .mockResolvedValueOnce([
                        { role: 'admin', count: 2 },
                        { role: 'member', count: 5 },
                        { role: 'testing', count: 3 }
                    ])
                    .mockResolvedValueOnce([
                        { status: 'active', count: 8 },
                        { status: 'inactive', count: 2 }
                    ]);
            });

            it('should return statistics for admin users', async () => {
                const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });
                
                (db.ViperInstance.count as jest.Mock)
                    .mockResolvedValueOnce(10) // total instances
                    .mockResolvedValueOnce(8); // active instances

                const recentInstances = [
                    { id: 1, uuid: 'uuid1', status: 'active', createdAt: new Date(), toJSON: () => ({ id: 1, uuid: 'uuid1', status: 'active', createdAt: new Date() }) },
                    { id: 2, uuid: 'uuid2', status: 'inactive', createdAt: new Date(), toJSON: () => ({ id: 2, uuid: 'uuid2', status: 'inactive', createdAt: new Date() }) }
                ];
                (db.ViperInstance.findAll as jest.Mock).mockResolvedValue(recentInstances);

                const response = await request(testApp).get('/service/statistics');

                expect(response.status).toBe(200);
                expect(response.body).toEqual({
                    summary: {
                        totalInstances: 10,
                        activeInstances: 8,
                        inactiveInstances: 2
                    },
                    byRole: [
                        { role: 'admin', count: 2 },
                        { role: 'member', count: 5 },
                        { role: 'testing', count: 3 }
                    ],
                    byStatus: [
                        { status: 'active', count: 8 },
                        { status: 'inactive', count: 2 }
                    ],
                    recentInstances: [
                        expect.objectContaining({ id: 1, uuid: 'uuid1', age: expect.stringContaining('hours') }),
                        expect.objectContaining({ id: 2, uuid: 'uuid2', age: expect.stringContaining('hours') })
                    ],
                    timestamp: expect.any(String)
                });
            });

            it('should return 403 for non-admin users', async () => {
                const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

                const response = await request(testApp).get('/service/statistics');

                expect(response.status).toBe(403);
                expect(response.body.error).toBe('Insufficient permissions. Required: admin');
            });

            it('should return 403 for unauthenticated users', async () => {
                const testApp = createTestApp(); // No user

                const response = await request(testApp).get('/service/statistics');

                expect(response.status).toBe(403);
                expect(response.body.error).toBe('Authentication required');
            });
        });

        // Tests for input validation - major untested area
        describe('Input Validation', () => {
            describe('GET /set-status-instance/:statuskey/:status', () => {
                it('should reject invalid status key (too short)', async () => {
                    const testApp = createTestApp();

                    const response = await request(testApp)
                        .get('/service/set-status-instance/short/active');

                    expect(response.status).toBe(400);
                    expect(response.body.error).toBe('Invalid status key');
                });

                it('should reject invalid status values', async () => {
                    const testApp = createTestApp();

                    const response = await request(testApp)
                        .get('/service/set-status-instance/valid-status-key/invalid-status');

                    expect(response.status).toBe(400);
                    expect(response.body.error).toBe('Invalid status value');
                    expect(response.body.validStatuses).toEqual(['created', 'starting', 'begin_cert', 'active', 'stopping', 'stopped', 'error']);
                });
            });

            describe('POST /terminate-instance/:containerId', () => {
                it('should reject invalid container ID (too short)', async () => {
                    const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

                    const response = await request(testApp)
                        .post('/service/terminate-instance/short');

                    expect(response.status).toBe(400);
                    expect(response.body.error).toBe('Invalid container ID provided');
                });

                it('should return 404 for a non-existent instance when the caller is not an admin', async () => {
                    const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

                    (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);

                    const response = await request(testApp)
                        .post('/service/terminate-instance/valid-container-id');

                    expect(response.status).toBe(404);
                    expect(response.body.error).toBe('Instance not found');
                });

                it('should return 403 for unauthorized termination', async () => {
                    const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

                    const mockInstance = {
                        dockerid: 'valid-container-id',
                        owner: 99, // Different owner
                        uuid: 'test-uuid'
                    };
                    (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(mockInstance);

                    const response = await request(testApp)
                        .post('/service/terminate-instance/valid-container-id');

                    expect(response.status).toBe(403);
                    expect(response.body.error).toBe('Unauthorized - can only terminate own instances');
                });
            });

            describe('POST /new-instance - Instance Limits', () => {
            it('should enforce instance limits for testing role', async () => {
                const testApp = createTestApp({ id: 2, username: 'tester', email: 'test@test.com', role: UserRole.TESTING });

                // Mock that user already has 1 instance (at limit for TESTING role)
                (db.ViperInstance.count as jest.Mock).mockResolvedValue(1);

                const response = await request(testApp).post('/service/new-instance');

                expect(response.status).toBe(429);
                expect(response.body).toEqual({
                    error: 'Instance limit reached',
                    message: 'Your testing account is limited to 1 active instance. Please terminate existing instances before creating new ones.',
                    existingInstances: 1,
                    limit: 1
                });
            });                it('should enforce instance limits for member role', async () => {
                    const testApp = createTestApp({ id: 3, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });

                    // Mock that user already has 1 instance (at limit for MEMBER role)
                    (db.ViperInstance.count as jest.Mock).mockResolvedValue(1);

                    const response = await request(testApp).post('/service/new-instance');

                    expect(response.status).toBe(429);
                    expect(response.body).toEqual({
                        error: 'Instance limit reached',
                        message: 'Your member account is limited to 1 active instance. Please terminate existing instances before creating new ones.',
                        existingInstances: 1,
                        limit: 1
                    });
                });

                it('should allow unlimited instances for admin role', async () => {
                    const testApp = createTestApp({ id: 1, username: 'admin', email: 'admin@test.com', role: UserRole.ADMIN });

                    // Mock that admin already has 100 instances - should still be allowed
                    (db.ViperInstance.count as jest.Mock).mockResolvedValue(100);
                    (db.ViperInstance.create as jest.Mock).mockResolvedValue(createMockViperInstance());

                    const response = await request(testApp).post('/service/new-instance');

                    expect(response.status).toBe(200);
                    expect(response.body.success).toBe(true);
                });

                it('should handle database errors during limit checking', async () => {
                    const testApp = createTestApp({ id: 2, username: 'tester', email: 'test@test.com', role: UserRole.TESTING });

                    (db.ViperInstance.count as jest.Mock).mockRejectedValue(new Error('Database error'));

                    const response = await request(testApp).post('/service/new-instance');

                    expect(response.status).toBe(500);
                    expect(response.body.error).toBe('Database error checking instance limits');
                });
            });
        });

        // Test monitoring endpoints - major untested functionality
        describe('Monitoring Endpoints', () => {
            describe('GET /monitoring-test/:instanceUUID', () => {
                it('should return test information for existing instance', async () => {
                    const testApp = createTestApp();
                    
                    const mockInstance = {
                        id: 1,
                        uuid: 'test-instance-uuid',
                        status: 'active',
                        lastActivity: new Date(),
                        isUserActive: true,
                        activityScore: 50
                    };
                    (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(mockInstance);

                    const response = await request(testApp)
                        .get('/service/monitoring-test/test-instance-uuid');

                    expect(response.status).toBe(200);
                    expect(response.body).toEqual({
                        success: true,
                        instanceUUID: 'test-instance-uuid',
                        message: 'Monitoring test endpoint - instance found',
                        instance: {
                            id: 1,
                            uuid: 'test-instance-uuid',
                            status: 'active',
                            lastActivity: expect.any(String),
                            isUserActive: true,
                            activityScore: 50
                        },
                        endpoints: {
                            screenshot: '/service/screenshot/test-instance-uuid',
                            activity: '/service/activity/test-instance-uuid',
                            test: '/service/monitoring-test/test-instance-uuid'
                        },
                        testCurl: {
                            activity: expect.stringContaining('curl -X POST')
                        }
                    });
                });

                it('should return 404 for a non-existent instance when the caller is not an admin', async () => {
                    const testApp = createTestApp();
                    
                    (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);

                    const response = await request(testApp)
                        .get('/service/monitoring-test/nonexistent-uuid');

                    expect(response.status).toBe(404);
                    expect(response.body).toEqual({
                        error: 'Instance not found',
                        instanceUUID: 'nonexistent-uuid',
                        message: 'No instance found with this UUID'
                    });
                });
            });

            describe('POST /screenshot/:instanceUUID', () => {
                it('should reject screenshot upload with invalid statusKey', async () => {
                    const testApp = createTestApp();
                    
                    const mockInstance = {
                        id: 1,
                        uuid: 'test-instance-uuid',
                        statusKey: 'valid-status-key'
                    };
                    (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(mockInstance);

                    const response = await request(testApp)
                        .post('/service/screenshot/test-instance-uuid')
                        .send({
                            screenshot: 'base64-data',
                            statusKey: 'invalid-status-key'
                        });

                    expect(response.status).toBe(401);
                    expect(response.body.error).toBe('Unauthorized');
                    expect(response.body.message).toBe('Invalid statusKey authentication');
                });

                it('should reject screenshot upload with missing statusKey', async () => {
                    const testApp = createTestApp();

                    const response = await request(testApp)
                        .post('/service/screenshot/test-instance-uuid')
                        .send({
                            screenshot: 'base64-data'
                        });

                    expect(response.status).toBe(401);
                    expect(response.body.error).toBe('Unauthorized');
                    expect(response.body.message).toBe('Invalid or missing statusKey');
                });

                it('should reject screenshot upload for non-existent instance', async () => {
                    const testApp = createTestApp();
                    
                    (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);

                    const response = await request(testApp)
                        .post('/service/screenshot/test-instance-uuid')
                        .send({
                            screenshot: 'base64-data',
                            statusKey: 'valid-status-key'
                        });

                    expect(response.status).toBe(401);
                    expect(response.body.error).toBe('Unauthorized');
                    expect(response.body.message).toBe('Instance not found');
                });
            });

            describe('POST /activity/:instanceUUID', () => {
                it('should reject activity report with invalid statusKey', async () => {
                    const testApp = createTestApp();
                    
                    const mockInstance = {
                        id: 1,
                        uuid: 'test-instance-uuid',
                        statusKey: 'valid-status-key'
                    };
                    (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(mockInstance);

                    const response = await request(testApp)
                        .post('/service/activity/test-instance-uuid')
                        .send({
                            mouseEvents: 5,
                            keyboardEvents: 3,
                            statusKey: 'invalid-key'
                        });

                    expect(response.status).toBe(401);
                    expect(response.body.error).toBe('Unauthorized');
                });

                it('should reject activity report with missing statusKey', async () => {
                    const testApp = createTestApp();

                    const response = await request(testApp)
                        .post('/service/activity/test-instance-uuid')
                        .send({
                            mouseEvents: 5,
                            keyboardEvents: 3
                        });

                    expect(response.status).toBe(401);
                    expect(response.body.error).toBe('Unauthorized');
                    expect(response.body.message).toBe('Invalid or missing statusKey');
                });
            });

            describe('GET /screenshot/:instanceUUID', () => {
                it('should return 401 for unauthenticated request', async () => {
                    const testApp = createTestApp(); // No user

                    const response = await request(testApp)
                        .get('/service/screenshot/test-instance-uuid');

                    expect(response.status).toBe(401);
                    expect(response.body.error).toBe('Authentication required');
                });

                it('should return 403 for unauthorized user', async () => {
                    const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });
                    
                    const mockInstance = {
                        id: 1,
                        uuid: 'test-instance-uuid',
                        owner: 99 // Different owner
                    };
                    (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(mockInstance);

                    const response = await request(testApp)
                        .get('/service/screenshot/test-instance-uuid');

                    expect(response.status).toBe(403);
                    expect(response.body.error).toBe('Unauthorized - can only view own or team instances');
                });

                it('should return 404 for a non-existent instance when the caller is not an admin', async () => {
                    const testApp = createTestApp({ id: 2, username: 'member', email: 'member@test.com', role: UserRole.MEMBER });
                    
                    (db.ViperInstance.findOne as jest.Mock).mockResolvedValue(null);

                    const response = await request(testApp)
                        .get('/service/screenshot/nonexistent-uuid');

                    expect(response.status).toBe(404);
                    expect(response.body.error).toBe('Instance not found');
                });
            });
        });
    });
});
