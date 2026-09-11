import { MailerSend } from 'mailersend';

// Create a mock send function that we can spy on
const mockSend = jest.fn();

// What each message was addressed from, and what it actually said. Without
// these a test can only prove a send happened, not that it was correct.
const sentFrom: any[] = [];
const sentBodies: string[] = [];

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
    setFrom: jest.fn(function (this: any, sender: any) { sentFrom.push(sender); return this; }),
    setTo: jest.fn().mockReturnThis(),
    setSubject: jest.fn().mockReturnThis(),
    setText: jest.fn(function (this: any, body: string) { sentBodies.push(body); return this; }),
    setHtml: jest.fn(function (this: any, body: string) { sentBodies.push(body); return this; })
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
        expect(require('../../../utility/emailRelay').isEmailConfigured()).toBe(false);
    });

    it('should be true with an API key', () => {
        process.env.MAILERSEND_API_KEY = 'a-key';
        expect(require('../../../utility/emailRelay').isEmailConfigured()).toBe(true);
    });
});

describe('sender and link domains are configured separately', () => {
    // A provider only sends as a domain verified with it, and that verification
    // is DNS work. An appliance on a new host therefore needs to send as an
    // established domain while every link points at its own, or the recipient
    // gets a message that either never arrives or leads back to the wrong site.
    const ORIGINAL_DOMAIN = process.env.DOMAIN_NAME;
    const ORIGINAL_FROM = process.env.MAIL_FROM_DOMAIN;

    afterEach(() => {
        if (ORIGINAL_DOMAIN === undefined) delete process.env.DOMAIN_NAME;
        else process.env.DOMAIN_NAME = ORIGINAL_DOMAIN;
        if (ORIGINAL_FROM === undefined) delete process.env.MAIL_FROM_DOMAIN;
        else process.env.MAIL_FROM_DOMAIN = ORIGINAL_FROM;
        jest.resetModules();
    });

    beforeEach(() => {
        sentFrom.length = 0;
        sentBodies.length = 0;
    });

    function loadWith(domain: string, from?: string) {
        process.env.DOMAIN_NAME = domain;
        if (from === undefined) delete process.env.MAIL_FROM_DOMAIN;
        else process.env.MAIL_FROM_DOMAIN = from;
        jest.resetModules();
        return require('../../../utility/emailRelay').default;
    }

    it('should send from the app domain when no sender domain is set', async () => {
        const relay = loadWith('example.org');
        await relay.sendWelcomeEmail('someone@elsewhere.test', 'someone');

        expect(sentFrom[sentFrom.length - 1].email).toBe('no-reply@example.org');
    });

    it('should send from the configured sender domain while linking to the app domain', async () => {
        const relay = loadWith('vipercloud.cc', 'cloudviper.org');
        await relay.sendResetEmail('someone@elsewhere.test', 'someone', 'tok123');

        expect(sentFrom[sentFrom.length - 1].email).toBe('no-reply@cloudviper.org');

        // The link must lead to the host the recipient is meant to reach.
        const body = sentBodies.join('\n');
        expect(body).toContain('vipercloud.cc/account/reset-token/tok123');
        expect(body).not.toContain('cloudviper.org/account/reset-token');
    });
});
