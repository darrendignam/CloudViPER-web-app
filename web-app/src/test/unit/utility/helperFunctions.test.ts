import crypto from 'crypto';
import helperFunctions from '../../../utility/helperFunctions';

describe('Helper Functions', () => {
  describe('sanitizeUsername', () => {
    it('should convert to lowercase and remove special characters', () => {
      expect(helperFunctions.sanitizeUsername('User@Name!')).toBe('username');
      expect(helperFunctions.sanitizeUsername('Test_User-123')).toBe('testuser123');
      expect(helperFunctions.sanitizeUsername('UPPERCASE')).toBe('uppercase');
    });

    it('should handle empty strings', () => {
      expect(helperFunctions.sanitizeUsername('')).toBe('');
    });

    it('should handle strings with only special characters', () => {
      expect(helperFunctions.sanitizeUsername('@#$%')).toBe('');
    });
  });

  describe('generateUsername', () => {
    it('should extract username from email', () => {
      expect(helperFunctions.generateUsername('john.doe@example.com')).toBe('johndoe');
      expect(helperFunctions.generateUsername('test_user@domain.org')).toBe('testuser');
    });

    it('should handle email without @ symbol', () => {
      expect(helperFunctions.generateUsername('username')).toBe('username');
    });

    it('should handle emails with special characters', () => {
      expect(helperFunctions.generateUsername('user+tag@example.com')).toBe('usertag');
    });

    it('should handle empty strings', () => {
      expect(helperFunctions.generateUsername('')).toBe('');
    });
  });

  describe('updateRoleIfAdmin', () => {
    it('should return admin for openpreservation.org domain', () => {
      expect(helperFunctions.updateRoleIfAdmin('admin@openpreservation.org')).toBe('admin');
      expect(helperFunctions.updateRoleIfAdmin('user@openpreservation.org')).toBe('admin');
    });

    it('should return user for other domains', () => {
      expect(helperFunctions.updateRoleIfAdmin('user@example.com')).toBe('user');
      expect(helperFunctions.updateRoleIfAdmin('admin@other.org')).toBe('user');
    });

    it('should handle emails without domain', () => {
      expect(helperFunctions.updateRoleIfAdmin('user')).toBe('user');
    });
  });

  describe('generateRandomString', () => {
    it('should generate string of specified length', () => {
      const result = helperFunctions.generateRandomString(10);
      expect(result).toHaveLength(10);
    });

    it('should generate different strings on multiple calls', () => {
      const result1 = helperFunctions.generateRandomString(8);
      const result2 = helperFunctions.generateRandomString(8);
      expect(result1).not.toBe(result2);
    });

    it('should only contain allowed characters', () => {
      const result = helperFunctions.generateRandomString(20);
      expect(result).toMatch(/^[a-z0-9]+$/);
    });

    it('should handle zero length', () => {
      expect(helperFunctions.generateRandomString(0)).toBe('');
    });

    it('should draw from crypto, not Math.random', () => {
      // The instance UUID, the status key and account passwords all come from
      // here. Math.random's V8 state is recoverable from a handful of outputs,
      // and these are minted consecutively, so one leaked value exposed the rest.
      const randomBytesSpy = jest.spyOn(crypto, 'randomBytes');
      const mathRandomSpy = jest.spyOn(Math, 'random');

      helperFunctions.generateRandomString(12);

      expect(randomBytesSpy).toHaveBeenCalled();
      expect(mathRandomSpy).not.toHaveBeenCalled();

      randomBytesSpy.mockRestore();
      mathRandomSpy.mockRestore();
    });

    it('should reject biased bytes rather than folding them into the alphabet', () => {
      // 36 characters do not divide 256, so bytes 252-255 would map back onto
      // the first four characters and make them likelier. Those bytes are
      // rejected, which is why the implementation loops.
      const spy = jest.spyOn(crypto, 'randomBytes');
      spy.mockReturnValueOnce(Buffer.from([252, 253, 254, 255]) as any);
      spy.mockReturnValueOnce(Buffer.from([0, 1, 2, 3]) as any);

      const result = helperFunctions.generateRandomString(4);

      expect(result).toBe('abcd');
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    it('should request only the shortfall on each refill', () => {
      const spy = jest.spyOn(crypto, 'randomBytes');
      spy.mockReturnValueOnce(Buffer.from([0, 1, 255, 255]) as any);
      spy.mockReturnValueOnce(Buffer.from([2, 3]) as any);

      const result = helperFunctions.generateRandomString(4);

      expect(result).toHaveLength(4);
      expect(spy.mock.calls[0][0]).toBe(4);
      // Two of the four bytes were rejected, so the refill asks for two.
      expect(spy.mock.calls[1][0]).toBe(2);
      spy.mockRestore();
    });

    it('should never overshoot the requested length', () => {
      for (const length of [1, 5, 12, 25, 64]) {
        expect(helperFunctions.generateRandomString(length)).toHaveLength(length);
      }
    });

    it('should cover the whole alphabet over many draws', () => {
      const seen = new Set(helperFunctions.generateRandomString(5000).split(''));

      expect(seen.size).toBe(36);
    });

    it('should not skew towards the low characters the rejection guards', () => {
      // A folded implementation would make a, b, c and d roughly 4/36 more
      // likely than the rest. This asserts no gross skew, not perfect uniformity.
      const sample = helperFunctions.generateRandomString(36000);
      const counts = new Map<string, number>();
      for (const character of sample) {
        counts.set(character, (counts.get(character) || 0) + 1);
      }

      const expected = sample.length / 36;
      for (const character of 'abcd') {
        expect(counts.get(character)!).toBeLessThan(expected * 1.25);
      }
    });
  });

  describe('generateSessionToken', () => {
    it('should return 43 base64url characters, which is 32 bytes', () => {
      const token = helperFunctions.generateSessionToken();

      expect(token).toHaveLength(43);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    });

    it('should only use the URL-safe alphabet, since it rides in a query string', () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        expect(helperFunctions.generateSessionToken()).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it('should not need percent-encoding', () => {
      const token = helperFunctions.generateSessionToken();

      expect(encodeURIComponent(token)).toBe(token);
    });

    it('should be unique across many draws', () => {
      const tokens = new Set(Array.from({ length: 500 }, () => helperFunctions.generateSessionToken()));

      expect(tokens.size).toBe(500);
    });

    it('should draw from crypto, not Math.random', () => {
      const randomBytesSpy = jest.spyOn(crypto, 'randomBytes');
      const mathRandomSpy = jest.spyOn(Math, 'random');

      helperFunctions.generateSessionToken();

      expect(randomBytesSpy).toHaveBeenCalledWith(32);
      expect(mathRandomSpy).not.toHaveBeenCalled();

      randomBytesSpy.mockRestore();
      mathRandomSpy.mockRestore();
    });
  });
});
