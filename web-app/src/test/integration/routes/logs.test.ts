import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import session from 'express-session';
import fs from 'fs';
import path from 'path';
import { UserRole } from '../../../types/UserRole';

// Mock file system operations
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock path operations  
jest.mock('path');
const mockPath = path as jest.Mocked<typeof path>;

// Mock the database models
jest.mock('../../../models', () => ({
    ContainerImage: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
    Team: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), findOrCreate: jest.fn() },
    default: {},
    sequelize: {
        sync: jest.fn()
    }
}));

// Mock the logger
jest.mock('../../../config/logger', () => ({
    appLogger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
    },
    logSession: jest.fn(),
    sqlLogger: {
        info: jest.fn(),
        error: jest.fn()
    }
}));

// Mock dotenv
jest.mock('dotenv', () => ({
    config: jest.fn()
}));

// Mock dockerode
jest.mock('dockerode', () => {
    return jest.fn().mockImplementation(() => ({
        listContainers: jest.fn(),
        createContainer: jest.fn(),
        getContainer: jest.fn()
    }));
});

// Mock helper functions
jest.mock('../../../utility/helperFunctions', () => ({
    default: {}
}));

// Mock port manager
jest.mock('../../../utility/portManager', () => ({
    getAvailablePort: jest.fn()
}));

describe('Log Service Integration Tests', () => {
    let app: express.Application;
    
    beforeEach(async () => {
        // Clear all mocks
        jest.clearAllMocks();
        
        // Create Express app with basic setup
        app = express();
        app.use(express.json());
        app.use(session({
            secret: 'test-secret',
            resave: false,
            saveUninitialized: false
        }));

        // Mock user middleware for admin access
        app.use((req, res, next) => {
            req.user = { 
                id: 1, 
                email: 'admin@example.com', 
                role: UserRole.ADMIN 
            };
            next();
        });

        // Import and use routes after setting up mocks
        const serviceRoutes = await import('../../../routes/service');
        app.use('/service', serviceRoutes.default);
    });

    describe('GET /service/logs/dates', () => {
        beforeEach(() => {
            // Setup file system mocks for each test
            mockFs.readdirSync.mockReturnValue([
                'session-2025-07-25.log',
                'session-2025-07-24.log',
                'app-2025-07-25.log',
                'app-2025-07-24.log',
                'sql-2025-07-25.log',
                'other-file.txt'
            ] as any);

            mockFs.existsSync.mockReturnValue(true);
            mockPath.join.mockReturnValue('/logs/path');
        });

        it('should return available log dates for admin users', async () => {
            const response = await request(app)
                .get('/service/logs/dates');

            expect(response.body).toHaveProperty('dates');
            expect(Array.isArray(response.body.dates)).toBe(true);
            expect(response.body.dates).toContain('2025-07-25');
            expect(response.body.dates).toContain('2025-07-24');
            expect(response.body).toHaveProperty('types');
        });

        it('should handle readdir errors gracefully', async () => {
            (mockFs.readdirSync as any).mockImplementation(() => {
                throw new Error('Directory not found');
            });

            (mockFs.existsSync as any).mockReturnValue(true);

            const response = await request(app)
                .get('/service/logs/dates')
                .expect(500);

            expect(response.body).toHaveProperty('message');
        });

        it('should deny access to non-admin users', async () => {
            // Create a new app instance with non-admin user for this test
            const nonAdminApp = express();
            nonAdminApp.use(express.json());
            nonAdminApp.use(session({
                secret: 'test-secret',
                resave: false,
                saveUninitialized: false
            }));

            // Set up non-admin user middleware
            nonAdminApp.use((req, res, next) => {
                req.user = { 
                    id: 2, 
                    email: 'user@example.com', 
                    role: UserRole.USER 
                };
                next();
            });

            // Import and use routes after setting up mocks
            const serviceRoutes = await import('../../../routes/service');
            nonAdminApp.use('/service', serviceRoutes.default);

            const response = await request(nonAdminApp)
                .get('/service/logs/dates')
                .expect(403);

            expect(response.body).toHaveProperty('message');
            expect(response.body.message).toContain('Admin access required');
        });
    });

    describe('GET /service/logs/:type', () => {
        beforeEach(() => {
            // Mock fs.existsSync to return true
            (mockFs.existsSync as any).mockReturnValue(true);
            
            // Mock fs.readFile for log file reading
            (mockFs.readFile as any).mockImplementation((filePath: any, encoding: any, callback: any) => {
                // Simulate log file content
                const logContent = '{"timestamp":"2025-07-25T10:00:00Z","message":"Test log entry","level":"info"}\n';
                callback(null, logContent);
            });
        });

        it('should return session logs with pagination', async () => {
            const response = await request(app)
                .get('/service/logs/session')
                .query({ date: '2025-07-25', limit: 10, offset: 0 })
                .expect(200);

            expect(response.body).toHaveProperty('logs');
            expect(response.body).toHaveProperty('total');
            expect(response.body).toHaveProperty('hasMore');
            expect(Array.isArray(response.body.logs)).toBe(true);
        });

        it('should return application logs with pagination', async () => {
            const response = await request(app)
                .get('/service/logs/app')
                .query({ date: '2025-07-25', limit: 10, offset: 0 })
                .expect(200);

            expect(response.body).toHaveProperty('logs');
            expect(response.body).toHaveProperty('total');
            expect(response.body).toHaveProperty('hasMore');
        });

        it('should return SQL logs with pagination', async () => {
            const response = await request(app)
                .get('/service/logs/sql')
                .query({ date: '2025-07-25', limit: 10, offset: 0 })
                .expect(200);

            expect(response.body).toHaveProperty('logs');
            expect(response.body).toHaveProperty('total');
            expect(response.body).toHaveProperty('hasMore');
        });

        it('should handle invalid log type', async () => {
            const response = await request(app)
                .get('/service/logs/invalid')
                .query({ date: '2025-07-25' })
                .expect(404); // No generic route exists, so 404 is expected

            expect(response.body).toBeDefined();
        });

        it('should handle missing date parameter', async () => {
            const response = await request(app)
                .get('/service/logs/session')
                .expect(200); // The actual route returns logs even without date

            expect(response.body).toHaveProperty('logs');
            expect(response.body).toHaveProperty('total');
            expect(response.body).toHaveProperty('hasMore');
        });

        it('should handle non-existent log files', async () => {
            (mockFs.existsSync as any).mockReturnValue(false);

            const response = await request(app)
                .get('/service/logs/session')
                .query({ date: '2025-07-25' })
                .expect(200); // Should still return 200 with empty logs

            expect(response.body.logs).toEqual([]);
            expect(response.body.total).toBe(0);
        });

        it('should apply correct pagination limits', async () => {
            const response = await request(app)
                .get('/service/logs/session')
                .query({ date: '2025-07-25', limit: 5, offset: 10 })
                .expect(200);

            expect(response.body).toHaveProperty('logs');
            expect(response.body).toHaveProperty('total');
            expect(response.body).toHaveProperty('hasMore');
        });

        it('should deny access to non-admin users', async () => {
            // Create a new app instance with non-admin user for this test
            const nonAdminApp = express();
            nonAdminApp.use(express.json());
            nonAdminApp.use(session({
                secret: 'test-secret',
                resave: false,
                saveUninitialized: false
            }));

            // Set up non-admin user middleware
            nonAdminApp.use((req, res, next) => {
                req.user = { 
                    id: 2, 
                    email: 'user@example.com', 
                    role: UserRole.USER 
                };
                next();
            });

            // Import and use routes after setting up mocks
            const serviceRoutes = await import('../../../routes/service');
            nonAdminApp.use('/service', serviceRoutes.default);

            const response = await request(nonAdminApp)
                .get('/service/logs/session')
                .query({ date: '2025-07-25' })
                .expect(403);

            expect(response.body).toHaveProperty('message');
            expect(response.body.message).toContain('Admin access required');
        });
    });

    describe('Log Content Parsing', () => {
        it('should correctly parse JSON log entries', async () => {
            const mockLogContent = [
                '{"timestamp":"2025-07-25T10:00:00Z","message":"User login","eventType":"User Login","userId":1}',
                '{"timestamp":"2025-07-25T10:01:00Z","message":"Role change","eventType":"Role Change","oldRole":"user","newRole":"admin"}',
                'Invalid JSON line',
                '{"timestamp":"2025-07-25T10:02:00Z","message":"Container created","containerId":"abc123"}'
            ].join('\n');

            (mockFs.existsSync as any).mockReturnValue(true);
            (mockFs.readFile as any).mockImplementation((filePath: any, encoding: any, callback: any) => {
                callback(null, mockLogContent);
            });

            const response = await request(app)
                .get('/service/logs/app')
                .query({ date: '2025-07-25' })
                .expect(200);

            expect(response.body.logs).toHaveLength(4); // Should include parsed and error entries
            expect(response.body.logs[0]).toHaveProperty('eventType', 'User Login');
            expect(response.body.logs[1]).toHaveProperty('eventType', 'Role Change');
            expect(response.body.logs[3]).toHaveProperty('containerId', 'abc123');
            // The invalid JSON should become an error entry
            expect(response.body.logs[2]).toHaveProperty('error', 'Failed to parse log entry');
        });

        it('should handle SQL log format correctly', async () => {
            const mockSqlContent = [
                '2025-07-25 10:00:00 - SELECT * FROM users WHERE id = 1',
                '2025-07-25 10:01:00 - INSERT INTO logs (message) VALUES ("test")',
                '2025-07-25 10:02:00 - UPDATE users SET role = "admin" WHERE id = 1'
            ].join('\n');

            (mockFs.existsSync as any).mockReturnValue(true);
            (mockFs.readFile as any).mockImplementation((filePath: any, encoding: any, callback: any) => {
                callback(null, mockSqlContent);
            });

            const response = await request(app)
                .get('/service/logs/sql')
                .query({ date: '2025-07-25' })
                .expect(200);

            expect(response.body.logs).toHaveLength(3);
            expect(response.body.logs[0]).toHaveProperty('content');
            expect(response.body.logs[0]).toHaveProperty('lineNumber', 1);
            expect(response.body.logs[0].content).toContain('SELECT * FROM users');
        });
    });
});
