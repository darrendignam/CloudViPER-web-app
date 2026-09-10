import * as net from 'net';
import { appLogger } from '../config/logger';
import Docker from 'dockerode';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Track ports being allocated to prevent race conditions
const allocatingPorts = new Set<number>();

/**
 * Get list of ports currently used by Docker containers
 * @returns Promise<Set<number>> - Set of ports in use by Docker
 */
async function getDockerUsedPorts(): Promise<Set<number>> {
    const usedPorts = new Set<number>();
    
    try {
        const containers = await docker.listContainers({ all: true });
        
        for (const container of containers) {
            if (container.Ports) {
                for (const portInfo of container.Ports) {
                    if (portInfo.PublicPort) {
                        usedPorts.add(portInfo.PublicPort);
                    }
                }
            }
        }
    } catch (error) {
        appLogger.warn('Failed to get Docker port usage:', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
        // Continue without Docker port checking if Docker is unavailable
    }
    
    return usedPorts;
}

/**
 * Find an available port on the system that's not used by Docker
 * @param startPort - Starting port to check (default: 3001)
 * @param endPort - Ending port to check (default: 65535)
 * @returns Promise<number> - Available port number
 */
export async function getAvailablePort(startPort: number = 3001, endPort: number = 65535): Promise<number> {
    const dockerUsedPorts = await getDockerUsedPorts();
    
    return new Promise((resolve, reject) => {
        const checkPort = (port: number) => {
            if (port > endPort) {
                reject(new Error(`No available ports found between ${startPort} and ${endPort}`));
                return;
            }

            // Skip ports used by Docker or currently being allocated
            if (dockerUsedPorts.has(port) || allocatingPorts.has(port)) {
                checkPort(port + 1);
                return;
            }

            // Mark port as being allocated to prevent race conditions
            allocatingPorts.add(port);

            const server = net.createServer();
            
            server.listen(port, '127.0.0.1', () => {
                const availablePort = port;
                server.close(() => {
                    // Keep port marked as allocated for a short time to prevent race conditions
                    setTimeout(() => {
                        allocatingPorts.delete(port);
                    }, 100);
                    resolve(availablePort);
                });
            });

            server.on('error', (err: NodeJS.ErrnoException) => {
                // Remove from allocating set on error
                allocatingPorts.delete(port);
                
                if (err.code === 'EADDRINUSE') {
                    // Port is in use, try the next one
                    checkPort(port + 1);
                } else {
                    reject(err);
                }
            });
        };

        checkPort(startPort);
    });
}

/**
 * Check if a specific port is available (both system and Docker)
 * @param port - Port number to check
 * @returns Promise<boolean> - True if port is available
 */
export async function isPortAvailable(port: number): Promise<boolean> {
    const dockerUsedPorts = await getDockerUsedPorts();
    
    // Check if Docker is using this port or it's being allocated
    if (dockerUsedPorts.has(port) || allocatingPorts.has(port)) {
        return false;
    }
    
    return new Promise((resolve) => {
        const server = net.createServer();
        
        server.listen(port, '127.0.0.1', () => {
            server.close(() => {
                resolve(true);
            });
        });

        server.on('error', () => {
            resolve(false);
        });
    });
}

/**
 * Get multiple available ports
 * @param count - Number of ports needed
 * @param startPort - Starting port to check (default: 3001)
 * @returns Promise<number[]> - Array of available port numbers
 */
export async function getMultipleAvailablePorts(count: number, startPort: number = 3001): Promise<number[]> {
    const ports: number[] = [];
    let currentPort = startPort;

    for (let i = 0; i < count; i++) {
        const availablePort = await getAvailablePort(currentPort);
        ports.push(availablePort);
        currentPort = availablePort + 1; // Start next search from next port
    }

    return ports;
}

export default {
    getAvailablePort,
    isPortAvailable,
    getMultipleAvailablePorts
};
