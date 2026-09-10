// Test setup file to handle common configuration
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables for testing
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.MAILERSEND_API_KEY = process.env.MAILERSEND_API_KEY || 'test-mailersend-key';
process.env.GOOGLE_AUTH_CLIENT_ID = process.env.GOOGLE_AUTH_CLIENT_ID || 'test_client_id';
process.env.GOOGLE_AUTH_CLIENT_SECRET = process.env.GOOGLE_AUTH_CLIENT_SECRET || 'test_client_secret';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_USER = process.env.DB_USER || 'viper_root';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'viper_pass';
process.env.DB_NAME = process.env.DB_NAME || 'viper_db_test';
// src/.env is gitignored, so anything the suite reads from the environment has
// to have a default here or it is undefined on a clean checkout. APP_HOST builds
// the instance URL, and without it new-instance produced "<uuid>.undefined" in
// CI while passing locally off the developer's own .env.
process.env.APP_HOST = process.env.APP_HOST || 'localhost';
process.env.DOMAIN_NAME = process.env.DOMAIN_NAME || 'cloudviper.org';

// Prevent automatic database sync during model imports
process.env.FORCE_DB_SYNC = 'false';

// Set test timeout globally
jest.setTimeout(30000);

// No get-port mock here. It was never a dependency of this project, nothing
// imports it, and utility/portManager finds free ports with the net module. On
// a clean install the mock fails to resolve and takes every suite down with it,
// which is why CI failed on its first real run while local passed.
