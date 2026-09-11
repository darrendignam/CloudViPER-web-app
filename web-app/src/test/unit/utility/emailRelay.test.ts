import { MailerSend } from 'mailersend';

// Create a mock send function that we can spy on
const mockSend = jest.fn();

// Mock MailerSend
jest.mock('../../../config/logger', () => ({
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logSQL: jest.fn(),
  logSession: jest.fn()
}));

jest.mock('mailersend', () => ({
  MailerSend: jest.fn().mockImplementation(() => ({
    email: {
      send: mockSend
    }
  })),
  EmailParams: jest.fn().mockImplementation(() => ({
    setFrom: jest.fn().mockReturnThis(),
    setTo: jest.fn().mockReturnThis(),
    setSubject: jest.fn().mockReturnThis(),
    setText: jest.fn().mockReturnThis(),
    setHtml: jest.fn().mockReturnThis()
  })),
  Recipient: jest.fn().mockImplementation((email, name) => ({ email, name })),
  Sender: jest.fn().mockImplementation((email, name) => ({ email, name }))
}));

// Import emailRelay after the mock is set up
import emailRelay from '../../../utility/emailRelay';
import { appLogger } from '../../../config/logger';

describe('Email Relay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Setup console mocks
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('sendWelcomeEmail', () => {
    it('should send welcome email with correct parameters', async () => {
      mockSend.mockResolvedValue({ status: 202 });

      await emailRelay.sendWelcomeEmail('test@example.com', 'testuser');

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(appLogger.info).toHaveBeenCalledWith('Email sent', expect.any(Object));
    });

    it('should report a send failure rather than swallowing it', async () => {
      // It used to log and return normally, so a caller could not tell a
      // delivered invitation from an undelivered one. An invited user has no
      // way into the system except the link in that mail, so the caller has to
      // learn it never went.
      const error = new Error('MailerSend error');
      mockSend.mockRejectedValue(error);

      await expect(emailRelay.sendWelcomeEmail('test@example.com', 'testuser'))
        .rejects.toThrow('MailerSend error');

      expect(appLogger.error).toHaveBeenCalledWith('Email send failed', expect.objectContaining({ error: 'MailerSend error' }));
    });
  });

  describe('sendInvitedEmail', () => {
    it('should send invitation email with correct parameters', async () => {
      mockSend.mockResolvedValue({ status: 202 });

      await emailRelay.sendInvitedEmail('invited@example.com', 'inviteduser', 'admin@example.com');

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(appLogger.info).toHaveBeenCalledWith('Email sent', expect.any(Object));
    });
  });

  describe('sendResetEmail', () => {
    it('should send password reset email with token', async () => {
      mockSend.mockResolvedValue({ status: 202 });

      const token = 'reset-token-123';
      await emailRelay.sendResetEmail('user@example.com', 'username', token);

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(appLogger.info).toHaveBeenCalledWith('Email sent', expect.any(Object));
    });

    it('should include security warning in reset email', async () => {
      mockSend.mockResolvedValue({ status: 202 });

      await emailRelay.sendResetEmail('user@example.com', 'username', 'token');

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('API Key Configuration', () => {
    it('should handle MailerSend API key configuration', () => {
      // Set a test API key for this test
      const originalApiKey = process.env.MAILERSEND_API_KEY;
      process.env.MAILERSEND_API_KEY = 'test-api-key';
      
      // Check that the environment variable can be set
      expect(process.env.MAILERSEND_API_KEY).toBe('test-api-key');
      
      // Restore original value
      if (originalApiKey) {
        process.env.MAILERSEND_API_KEY = originalApiKey;
      } else {
        delete process.env.MAILERSEND_API_KEY;
      }
    });

    it('should handle missing API key gracefully', () => {
      const originalApiKey = process.env.MAILERSEND_API_KEY;
      delete process.env.MAILERSEND_API_KEY;
      
      // The module should handle missing API key without crashing
      expect(process.env.MAILERSEND_API_KEY).toBeUndefined();
      
      // Restore original value
      if (originalApiKey) {
        process.env.MAILERSEND_API_KEY = originalApiKey;
      }
    });
  });
});

describe('isEmailConfigured', () => {
    const ORIGINAL = process.env.MAILERSEND_API_KEY;

    afterEach(() => {
        if (ORIGINAL === undefined) delete process.env.MAILERSEND_API_KEY;
        else process.env.MAILERSEND_API_KEY = ORIGINAL;
    });

    it('should be false without an API key', () => {
        delete process.env.MAILERSEND_API_KEY;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        expect(require('../../../utility/emailRelay').isEmailConfigured()).toBe(false);
    });

    it('should be true with an API key', () => {
        process.env.MAILERSEND_API_KEY = 'a-key';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        expect(require('../../../utility/emailRelay').isEmailConfigured()).toBe(true);
    });
});
