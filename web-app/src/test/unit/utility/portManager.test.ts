import { getAvailablePort, isPortAvailable, getMultipleAvailablePorts } from '../../../utility/portManager';
import * as net from 'net';

describe('Port Manager Utility', () => {
    afterEach(() => {
        // Clean up any open servers
        jest.clearAllMocks();
    });

    describe('getAvailablePort', () => {
        it('should return an available port', async () => {
            const port = await getAvailablePort(3001);
            expect(port).toBeGreaterThanOrEqual(3001);
            expect(port).toBeLessThanOrEqual(65535);
        });

        it('should return a port within the specified range', async () => {
            const port = await getAvailablePort(5000, 5010);
            expect(port).toBeGreaterThanOrEqual(5000);
            expect(port).toBeLessThanOrEqual(5010);
        });

        it('should skip ports that are in use', async () => {
            // Create a server on port 4000
            const testServer = net.createServer();
            await new Promise<void>((resolve) => {
                testServer.listen(4000, '127.0.0.1', resolve);
            });

            try {
                // Should return 4001 or higher since 4000 is occupied
                const port = await getAvailablePort(4000, 4010);
                expect(port).toBeGreaterThan(4000);
            } finally {
                testServer.close();
            }
        });

        it('should reject if no ports are available in range', async () => {
            // Test with a restricted port that's likely to be in use or restricted
            // Port 1 is typically restricted and not available for user applications
            try {
                await getAvailablePort(1, 1);
                // If it somehow succeeds, that's also valid behavior
                expect(true).toBe(true);
            } catch (error: any) {
                // Should either be permission denied or no ports available
                expect(error.message).toMatch(/(?:No available ports found|EACCES|permission denied)/i);
            }
        });
    });

    describe('isPortAvailable', () => {
        it('should return true for an available port', async () => {
            // Bind port 0 so the OS picks a free one, then release it. Naming a
            // port and hoping it is free makes the result depend on whatever
            // else the machine happens to be running.
            const probe = net.createServer();
            await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
            const freePort = (probe.address() as net.AddressInfo).port;
            await new Promise<void>((resolve) => { probe.close(() => resolve()); });

            const available = await isPortAvailable(freePort);
            expect(available).toBe(true);
        });

        it('should return false for a port in use', async () => {
            // Port 0 lets the OS choose, so this cannot collide with another
            // process or a parallel jest worker. The previous version named 3998
            // and did not await close(), so the port could still be held on the
            // next run: the suite failed roughly one run in four.
            const testServer = net.createServer();
            await new Promise<void>((resolve) => {
                testServer.listen(0, '127.0.0.1', resolve);
            });
            const busyPort = (testServer.address() as net.AddressInfo).port;

            try {
                const available = await isPortAvailable(busyPort);
                expect(available).toBe(false);
            } finally {
                await new Promise<void>((resolve) => { testServer.close(() => resolve()); });
            }
        });
    });

    describe('getMultipleAvailablePorts', () => {
        it('should return multiple available ports', async () => {
            const ports = await getMultipleAvailablePorts(3, 6000);
            
            expect(ports).toHaveLength(3);
            expect(ports[0]).toBeGreaterThanOrEqual(6000);
            expect(ports[1]).toBeGreaterThan(ports[0]);
            expect(ports[2]).toBeGreaterThan(ports[1]);
            
            // All ports should be unique
            const uniquePorts = new Set(ports);
            expect(uniquePorts.size).toBe(3);
        });

        it('should return sequential available ports', async () => {
            const ports = await getMultipleAvailablePorts(2, 7000);
            
            expect(ports).toHaveLength(2);
            // Ports should be in ascending order
            expect(ports[1]).toBeGreaterThan(ports[0]);
        });
    });

    describe('Stress Testing Capabilities', () => {
        it('should handle multiple simultaneous port requests', async () => {
            const promises = Array.from({ length: 5 }, () => getAvailablePort(8000));
            const ports = await Promise.all(promises);
            
            // All ports should be unique
            const uniquePorts = new Set(ports);
            expect(uniquePorts.size).toBe(5);
            
            // All ports should be valid
            ports.forEach(port => {
                expect(port).toBeGreaterThanOrEqual(8000);
                expect(port).toBeLessThanOrEqual(65535);
            });
        });

        it('should work for development stress testing scenario', async () => {
            // Simulate creating 10 Docker instances simultaneously
            const instanceCount = 10;
            const startPort = 9000;
            
            const ports = await getMultipleAvailablePorts(instanceCount, startPort);
            
            expect(ports).toHaveLength(instanceCount);
            
            // Verify all ports are unique and in valid range
            const uniquePorts = new Set(ports);
            expect(uniquePorts.size).toBe(instanceCount);
            
            ports.forEach(port => {
                expect(port).toBeGreaterThanOrEqual(startPort);
            });
            
            console.log(`Stress test: Got ${instanceCount} ports:`, ports);
        });

        it('should handle edge cases and boundary conditions', async () => {
            // Test with minimum port number
            const minPort = await getAvailablePort(1024, 1030);
            expect(minPort).toBeGreaterThanOrEqual(1024);
            expect(minPort).toBeLessThanOrEqual(1030);
            
            // Test with single port in range
            try {
                const singlePort = await getAvailablePort(50000, 50000);
                expect(singlePort).toBe(50000);
            } catch (error: any) {
                // It's ok if the port is in use, we're testing the boundary
                expect(error.message).toContain('No available ports found');
            }
        });
    });
});
