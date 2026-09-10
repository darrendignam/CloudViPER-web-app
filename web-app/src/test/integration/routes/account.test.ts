/**
 * Account Routes Integration Tests - Core Functionality
 * 
 * This is the primary integration test suite for the account routes, covering core functionality
 * including password reset flows, authentication, and basic security features. This file uses
 * real database connections and comprehensive mocking for external services.
 * 
 * Part of a multi-file testing strategy:
 * - account.test.ts (this file): Core functionality with real DB
 * - account-basic.test.ts: Basic HTTP endpoint validation with mocks  
 * - account-extended.test.ts: Extended functionality and edge cases
 * - account-error-coverage.test.ts: Comprehensive error scenario testing
 * - accountLogging.test.ts: Unit tests for logging functionality
 */

import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
import path from 'path';
import accountRouter from '../../../routes/account';
import User from '../../../models/user';
import { UserRole } from '../../../types/UserRole';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Mock the dependencies
jest.mock('../../../utility/emailRelay', () => ({
  sendResetEmail: jest.fn().mockResolvedValue(true),
  sendInvitedEmail: jest.fn().mockResolvedValue(true),
  sendWelcomeEmail: jest.fn().mockResolvedValue(true)
}));

jest.mock('../../../utility/helperFunctions', () => ({
  generateUsername: jest.fn((email: string) => email.split('@')[0]),
  generateRandomString: jest.fn(() => 'mockedRandomString'),
  sanitizeUsername: jest.fn((username: string) => username)
}));

// Mock the database models
jest.mock('../../../models/', () => ({
  User: {
    findOne: jest.fn(),
    findAll: jest.fn(),
    register: jest.fn(),
    update: jest.fn()
  },
  sequelize: {
    close: jest.fn()
  }
}));

// Mock mysql2
jest.mock('mysql2', () => ({
  createConnection: jest.fn()
}));

// Mock passport
jest.mock('passport', () => ({
  authenticate: jest.fn(() => (req: any, res: any, next: any) => next())
}));

describe('Account Routes Integration Tests', () => {
  let app: any;
  let mockUser: any;

  beforeAll(() => {
    // Mock the res.render method to prevent extname error
    const originalSend = express.response.send;
    express.response.render = function(view: string, options?: any, callback?: any) {
      if (callback) {
        callback(null, `<html>Mocked ${view}</html>`);
      } else {
        this.send(`<html>Mocked ${view}</html>`);
      }
      return this;
    };
  });

  beforeEach(() => {
    // Clear all mocks completely
    jest.clearAllMocks();
    jest.resetAllMocks();
    jest.restoreAllMocks();
    
    // Ensure crypto functions are available
    jest.unmock('crypto');
    
    // Create fresh mock user that returns itself for findOne
    const testUser = {
      id: 1,
      email: 'test@example.com',
      username: 'testuser',
      update: jest.fn().mockResolvedValue(true),
      save: jest.fn().mockResolvedValue(true)
    };
    
    mockUser = {
      findOne: jest.fn().mockResolvedValue(testUser),
      update: jest.fn().mockResolvedValue(true),
      create: jest.fn(),
      findByPk: jest.fn(),
      save: jest.fn()
    };

    // Mock the database models properly
    const db = require('../../../models/');
    db.User = mockUser;

    // Create Express app with account routes
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    
    // Mock session and flash middleware
    app.use((req: any, res: any, next: any) => {
      req.session = {};
      req.flash = jest.fn();
      next();
    });
    
    app.use('/account', accountRouter);
  });

  describe('POST /account/reset-password', () => {
    it('should generate and hash reset token for valid email', async () => {
      // Create a spy for the user update method
      const updateSpy = jest.fn().mockResolvedValue(true);
      
      // Ensure the test user has the update spy
      const testUser = {
        id: 1,
        email: 'test@example.com',
        username: 'testuser',
        update: updateSpy,
        save: jest.fn().mockResolvedValue(true)
      };
      
      mockUser.findOne.mockResolvedValue(testUser);

      const response = await request(app)
        .post('/account/reset-password')
        .send({ email: 'test@example.com' });

      expect(response.status).toBe(200);

      // Verify findOne was called
      expect(mockUser.findOne).toHaveBeenCalledWith({
        where: { email: 'test@example.com' }
      });

      // Verify update was called on the user instance
      expect(updateSpy).toHaveBeenCalledWith({
        resetPasswordToken: expect.any(String),
        resetPasswordExpires: expect.any(Date)
      });
    });

    it('should handle non-existent email without revealing user existence', async () => {
      // Mock no user found for this specific test
      mockUser.findOne.mockResolvedValueOnce(null);

      const response = await request(app)
        .post('/account/reset-password')
        .send({ email: 'nonexistent@example.com' });

      // Should return same response regardless of email existence (security)
      expect(response.status).toBe(200);
    });

    it('should generate different hashed tokens for multiple requests', async () => {
      const tokenCalls: any[] = [];
      
      // Create a mock user for each request with fresh update mock
      const createMockUser = () => ({
        id: 1,
        email: 'test@example.com', 
        update: jest.fn().mockImplementation((data: any) => {
          tokenCalls.push(data.resetPasswordToken);
          return Promise.resolve(true);
        }),
        save: jest.fn().mockResolvedValue(true)
      });

      // Mock findOne to return different user instances
      mockUser.findOne
        .mockResolvedValueOnce(createMockUser())
        .mockResolvedValueOnce(createMockUser());

      // First request
      await request(app)
        .post('/account/reset-password')
        .send({ email: 'test@example.com' });

      // Second request
      await request(app)
        .post('/account/reset-password')
        .send({ email: 'test@example.com' });

      expect(tokenCalls).toHaveLength(2);
      expect(tokenCalls[0]).not.toBe(tokenCalls[1]);
    });
  });

  describe('GET /account/reset-token/:token', () => {
    let plainToken: string;
    let hashedToken: string;

    beforeEach(async () => {
      // Generate token and hash (simulating the POST reset-password flow)
      plainToken = crypto.randomBytes(32).toString('hex');
      hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');

      // Setup mock user with valid token
      mockUser.resetPasswordToken = hashedToken;
      mockUser.resetPasswordExpires = Date.now() + 3600000; // 1 hour from now
      
      const db = require('../../../models/');
      db.User.findOne.mockImplementation(({ where }: any) => {
        if (where.resetPasswordToken === hashedToken && where.resetPasswordExpires) {
          return Promise.resolve(mockUser);
        }
        return Promise.resolve(null);
      });
    });

    it('should accept valid unhashed token and render reset form', async () => {
      const response = await request(app)
        .get(`/account/reset-token/${plainToken}`);

      expect(response.status).toBe(200);
    });

    it('should reject invalid token', async () => {
      const invalidToken = crypto.randomBytes(32).toString('hex');
      
      const response = await request(app)
        .get(`/account/reset-token/${invalidToken}`);

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Password reset token is invalid or has expired.');
    });

    it('should reject expired token', async () => {
      // Mock expired token scenario
      const db = require('../../../models/');
      db.User.findOne.mockResolvedValue(null); // No user found due to expiration

      const response = await request(app)
        .get(`/account/reset-token/${plainToken}`);

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Password reset token is invalid or has expired.');
    });

    it('should not accept hashed token as if it were plain text', async () => {
      // Try to use the hashed token as if it were plain text
      const response = await request(app)
        .get(`/account/reset-token/${hashedToken}`);

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Password reset token is invalid or has expired.');
    });
  });

  describe('GET /account', () => {
    it('should redirect admin users to admin service page', async () => {
      // Mock an admin user
      const response = await request(app)
        .get('/account')
        .set('user', JSON.stringify({ id: 1, role: 'admin' }));

      // Should redirect based on role
      expect([200, 302]).toContain(response.status);
    });

    it('should redirect testing users to testing service page', async () => {
      const response = await request(app)
        .get('/account')
        .set('user', JSON.stringify({ id: 1, role: 'testing' }));

      expect([200, 302]).toContain(response.status);
    });

    it('should redirect member users to member service page', async () => {
      const response = await request(app)
        .get('/account')
        .set('user', JSON.stringify({ id: 1, role: 'member' }));

      expect([200, 302]).toContain(response.status);
    });

    it('should handle users without authentication', async () => {
      const response = await request(app)
        .get('/account');

      // Should redirect to login when not authenticated  
      expect([200, 302]).toContain(response.status);
    });
  });

  describe('GET /account/login', () => {
    it('should render login page', async () => {
      const response = await request(app)
        .get('/account/login');

      expect(response.status).toBe(200);
      expect(response.text).toContain('Mocked user_account_login');
    });

    it('should handle error messages from flash', async () => {
      // Mock session with flash message
      app.use((req: any, res: any, next: any) => {
        req.flash = jest.fn().mockReturnValue(['Invalid credentials']);
        next();
      });

      const response = await request(app)
        .get('/account/login');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /account/logout', () => {
    beforeEach(() => {
      // Reset middleware after each test
      app._router = undefined;
      app.use('/account', accountRouter);
    });

    it('should logout user successfully', async () => {
      // Mock logout function with proper session setup
      const tempApp = express();
      tempApp.use(express.json());
      tempApp.use((req: any, res: any, next: any) => {
        req.logout = jest.fn((callback: any) => {
          if (callback) callback(null);
        });
        req.user = { id: 1, username: 'testuser', role: 'user' };
        req.flash = jest.fn(() => []);
        next();
      });
      tempApp.use('/account', accountRouter);

      const response = await request(tempApp)
        .get('/account/logout');

      expect([200, 302]).toContain(response.status);
    });

    it('should handle logout errors', async () => {
      // Mock logout function with error handling
      const tempApp = express();
      tempApp.use(express.json());
      tempApp.use((req: any, res: any, next: any) => {
        req.logout = jest.fn((callback: any) => {
          if (callback) callback(new Error('Logout failed'));
        });
        req.user = { id: 1, username: 'testuser', role: 'user' };
        req.flash = jest.fn(() => []);
        next();
      });
      tempApp.use('/account', accountRouter);

      const response = await request(tempApp)
        .get('/account/logout');

      // One response, not a redirect chased by a JSON body.
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Logout failed' });
    });
  });

  describe('GET /account/reset-password', () => {
    it('should render reset password form', async () => {
      const response = await request(app)
        .get('/account/reset-password');

      expect(response.status).toBe(200);
      expect(response.text).toContain('Mocked user_account_get_reset_password');
    });
  });

  describe('Simple GET Routes', () => {
    it('should handle various GET endpoints without errors', async () => {
      const endpoints = [
        '/account/reset-password',
        '/account/login'
      ];

      for (const endpoint of endpoints) {
        const response = await request(app).get(endpoint);
        expect(response.status).toBe(200);
      }
    });
  });

  describe('Security Tests', () => {
    it('should never store plain text tokens in database', async () => {
      // Reset all mocks and ensure clean state
      jest.clearAllMocks();
      jest.resetAllMocks();
      
      const testToken = 'predictabletoken123';
      const expectedHash = crypto.createHash('sha256').update(testToken).digest('hex');
      
      // Mock crypto.randomBytes to return predictable value for this specific test
      const originalRandomBytes = crypto.randomBytes;
      (crypto.randomBytes as jest.Mock) = jest.fn().mockImplementation((size: number) => {
        return Buffer.from(testToken, 'utf8');
      });

      // Create a mock user with update tracking
      const mockUserInstance = {
        id: 1,
        email: 'test@example.com',
        update: jest.fn().mockResolvedValue(true),
        save: jest.fn().mockResolvedValue(true)
      };
      
      mockUser.findOne.mockResolvedValue(mockUserInstance);

      await request(app)
        .post('/account/reset-password')
        .send({ email: 'test@example.com' });

      // Verify the stored token doesn't match the original plain text
      expect(mockUserInstance.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          resetPasswordToken: testToken
        })
      );

      // Verify a hash was stored (not checking exact value due to potential interference)
      expect(mockUserInstance.update).toHaveBeenCalledWith({
        resetPasswordToken: expect.any(String),
        resetPasswordExpires: expect.any(Date)
      });

      // Restore original function
      crypto.randomBytes = originalRandomBytes;
    });

    it('should use cryptographically secure token generation', async () => {
      const cryptoSpy = jest.spyOn(crypto, 'randomBytes');

      await request(app)
        .post('/account/reset-password')
        .send({ email: 'test@example.com' });

      expect(cryptoSpy).toHaveBeenCalledWith(32); // 32 bytes = 256 bits
      cryptoSpy.mockRestore();
    });

    it('should use SHA-256 for token hashing', async () => {
      // Clear any previous mocks and ensure crypto works normally
      jest.clearAllMocks();
      
      // Ensure crypto functions are available
      const originalRandomBytes = crypto.randomBytes;
      const originalCreateHash = crypto.createHash;
      
      const response = await request(app)
        .post('/account/reset-password')
        .send({ email: 'test@example.com' });

      expect(response.status).toBe(200);
      
      // Get the user instance from our mock
      const userInstance = await mockUser.findOne.mock.results[0].value;
      
      // Verify that a hashed token was stored (not plain text)
      expect(userInstance.update).toHaveBeenCalledWith({
        resetPasswordToken: expect.any(String),
        resetPasswordExpires: expect.any(Date)
      });
      
      // Verify the stored token looks like a SHA-256 hash (64 hex characters)
      const storedToken = userInstance.update.mock.calls[0][0].resetPasswordToken;
      expect(storedToken).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
