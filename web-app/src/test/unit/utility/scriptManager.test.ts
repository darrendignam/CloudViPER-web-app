import * as fs from 'fs';
import * as path from 'path';
import { readAndProcessScript, getAvailableScripts, validateRequiredScripts, getScriptsDirectory } from '../../../utility/scriptManager';

// Mock fs module
jest.mock('fs');
jest.mock('path');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockPath = path as jest.Mocked<typeof path>;

describe('Script Manager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Setup default path mocking
        mockPath.join.mockImplementation((...segments) => segments.join('/'));
    });

    describe('readAndProcessScript', () => {
        it('should read and process script with template variables', () => {
            const scriptContent = 'Script with {{INSTANCE_UUID}} and {{SERVICE_URL}}';
            const processedContent = 'Script with test-uuid and http://localhost:3000';
            
            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue(scriptContent);
            
            const variables = {
                INSTANCE_UUID: 'test-uuid',
                SERVICE_URL: 'http://localhost:3000',
                DOMAIN_NAME: 'localhost',
                STATUS_KEY: 'test-key'
            };
            
            const result = readAndProcessScript('test-script.sh', variables);
            
            expect(result).toContain('test-uuid');
            expect(result).toContain('http://localhost:3000');
            expect(result).not.toContain('{{INSTANCE_UUID}}');
            expect(result).not.toContain('{{SERVICE_URL}}');
        });

        it('should throw error if script file does not exist', () => {
            mockFs.existsSync.mockReturnValue(false);
            
            const variables = {
                INSTANCE_UUID: 'test-uuid',
                SERVICE_URL: 'http://localhost:3000',
                DOMAIN_NAME: 'localhost',
                STATUS_KEY: 'test-key'
            };
            
            expect(() => {
                readAndProcessScript('nonexistent-script.sh', variables);
            }).toThrow('Script file not found');
        });

        it('should replace all occurrences of template variables', () => {
            const scriptContent = '{{INSTANCE_UUID}} - {{INSTANCE_UUID}} - {{DOMAIN_NAME}}';
            
            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue(scriptContent);
            
            const variables = {
                INSTANCE_UUID: 'uuid-123',
                SERVICE_URL: 'http://test.com',
                DOMAIN_NAME: 'test.com',
                STATUS_KEY: 'status-123'
            };
            
            const result = readAndProcessScript('test-script.sh', variables);
            
            expect(result).toBe('uuid-123 - uuid-123 - test.com');
        });
    });

    describe('getScriptsDirectory', () => {
        afterEach(() => {
            delete process.env.SCRIPTS_DIR;
        });

        it('should prefer SCRIPTS_DIR when set', () => {
            process.env.SCRIPTS_DIR = '/explicit/scripts';

            expect(getScriptsDirectory()).toBe('/explicit/scripts');
        });

        it('should use the built layout when the scripts sit two levels up', () => {
            mockFs.existsSync.mockImplementation((filePath: any) => !filePath.includes('../../../'));

            expect(getScriptsDirectory()).toContain('../../scripts');
        });

        it('should fall back to the source layout, which is why dev used to find nothing', () => {
            mockFs.existsSync.mockImplementation((filePath: any) => filePath.includes('../../../scripts'));

            expect(getScriptsDirectory()).toContain('../../../scripts');
        });

        it('should return the built layout when neither candidate holds the scripts', () => {
            mockFs.existsSync.mockReturnValue(false);

            expect(getScriptsDirectory()).toContain('../../scripts');
        });
    });

    describe('getAvailableScripts', () => {
        it('should return filtered script files when scripts directory exists', () => {
            const mockFiles = [
                'viper-monitor.sh',
                'viper-monitor.service',
                'viper-monitor.desktop',
                'readme.txt',
                'config.json'
            ];
            mockFs.existsSync.mockReturnValue(true);
            mockFs.readdirSync.mockReturnValue(mockFiles as any);
            
            const result = getAvailableScripts();
            
            // .service is not listed: the systemd unit was removed in 2.0 and
            // nothing produces or consumes one.
            expect(result).toEqual([
                'viper-monitor.sh',
                'viper-monitor.desktop'
            ]);
        });

        it('should return empty array when scripts directory does not exist', () => {
            mockFs.existsSync.mockReturnValue(false);
            
            const result = getAvailableScripts();
            
            expect(result).toEqual([]);
        });

        it('should filter files by extension correctly', () => {
            const mockFiles = [
                'script1.sh',
                'script2.service',
                'script3.desktop',
                'document.pdf',
                'image.png',
                'config.xml'
            ];
            
            mockFs.existsSync.mockReturnValue(true);
            mockFs.readdirSync.mockReturnValue(mockFiles as any);
            
            const result = getAvailableScripts();
            
            expect(result).toEqual([
                'script1.sh',
                'script3.desktop'
            ]);
        });
    });

    describe('validateRequiredScripts', () => {
        it('should return valid when all required scripts exist', () => {
            mockFs.existsSync.mockReturnValue(true);
            
            const result = validateRequiredScripts();
            
            expect(result.valid).toBe(true);
            expect(result.missing).toEqual([]);
        });

        it('should return invalid with missing scripts when some scripts do not exist', () => {
            mockFs.existsSync.mockImplementation((filePath: any) => {
                // Only viper-monitor.sh exists
                return filePath.includes('viper-monitor.sh');
            });
            
            const result = validateRequiredScripts();
            
            expect(result.valid).toBe(false);
            expect(result.missing).toEqual(['viper-monitor.desktop']);
        });

        it('should return invalid with all missing when scripts directory is empty', () => {
            mockFs.existsSync.mockReturnValue(false);
            
            const result = validateRequiredScripts();
            
            expect(result.valid).toBe(false);
            expect(result.missing).toEqual([
                'viper-monitor.sh',
                'viper-monitor.desktop'
            ]);
        });
    });
});
