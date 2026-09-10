import Docker from 'dockerode';
import { appLogger } from '../config/logger';
import { redactContainerOptions } from '../utility/redaction';

// Returned when Docker never reports a settled exit code. Negative so it can
// never be mistaken for a real one; every real exit code is 0 or above.
const UNKNOWN_EXIT_CODE = -1;
const EXEC_SETTLE_TIMEOUT_MS = 2000;
const EXEC_SETTLE_POLL_MS = 50;

// Extend the typings to fix the return type of listContainers
declare module 'dockerode' {
  interface Docker {
    listContainers(options?: any): Promise<Docker.ContainerInfo[]>;
  }
}


/**
 * ContainerService Interface - designed to be implementation agnostic
 * This will make future transition to Kubernetes easier
 */
export interface IContainerService {
  // Core operations
  createContainer(options: any): Promise<any>;
  startContainer(containerId: string): Promise<void>;
  stopContainer(containerId: string): Promise<void>;
  removeContainer(containerId: string): Promise<void>;
  
  // Container information
  inspectContainer(containerId: string): Promise<any>;
  listContainers(options?: any): Promise<any[]>;
  
  // Container execution
  execInContainer(containerId: string, command: string[], options?: any): Promise<{
    output: string;
    exitCode: number;
  }>;

  // Utility method to get container
  getContainer(containerId: string): any;

  // Docker ping
  ping(): Promise<void>;
}

/**
 * Docker Implementation of ContainerService
 */
export class DockerContainerService implements IContainerService {
  private docker: Docker;
  
  constructor() {
    // Docker initialization with socket path
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
  }
  async ping(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (error) {
      appLogger.error('Error pinging Docker daemon', {
        eventType: 'Docker Ping Error',
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async createContainer(options: any): Promise<any> {
    try {
      const container = await this.docker.createContainer(options);
      return container;
    } catch (error) {
      appLogger.error('Error creating Docker container', {
        eventType: 'Container Creation Error',
        error: (error as Error).message,
        options: redactContainerOptions(options),
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async startContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.start();
    } catch (error) {
      appLogger.error('Error starting Docker container', {
        eventType: 'Container Start Error',
        containerId,
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async stopContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 10 }); // Stop with 10 second timeout
    } catch (error) {
      appLogger.error('Error stopping Docker container', {
        eventType: 'Container Stop Error',
        containerId,
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async removeContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.remove({ force: true });
    } catch (error) {
      appLogger.error('Error removing Docker container', {
        eventType: 'Container Remove Error',
        containerId,
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async inspectContainer(containerId: string): Promise<any> {
    try {
      const container = this.docker.getContainer(containerId);
      return await container.inspect();
    } catch (error) {
      appLogger.error('Error inspecting Docker container', {
        eventType: 'Container Inspect Error',
        containerId,
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async listContainers(options?: any): Promise<any[]> {
    try {
      // Using a type assertion to work around typing issues
      return (this.docker as any).listContainers(options || {}) || [];
    } catch (error) {
      appLogger.error('Error listing Docker containers', {
        eventType: 'Container List Error',
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  /**
   * Poll an exec until Docker stops reporting it as running.
   *
   * The output stream can end a moment before the daemon settles the exec, and
   * an inspect in that window returns Running true with a null ExitCode. Reading
   * that as an exit code turns a failed command into a successful one.
   */
  private async awaitExecExit(exec: any): Promise<any> {
    const deadline = Date.now() + EXEC_SETTLE_TIMEOUT_MS;
    let inspectData = await exec.inspect();

    while (inspectData?.Running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, EXEC_SETTLE_POLL_MS));
      inspectData = await exec.inspect();
    }

    return inspectData;
  }

  async execInContainer(
    containerId: string,
    command: string[],
    options?: any
  ): Promise<{ output: string; exitCode: number }> {
    try {
      const container = this.docker.getContainer(containerId);
      const execOptions = {
        AttachStdout: true,
        AttachStderr: true,
        Cmd: command,
        ...(options || {}),
      };
      
      const exec = await container.exec(execOptions);
      const stream = await exec.start({ hijack: true, stdin: true });
      
      let output = '';
      await new Promise((resolve) => {
        stream.on('data', (data: any) => {
          output += data.toString();
        });
        stream.on('end', resolve);
      });
      
      const inspectData = await this.awaitExecExit(exec);
      // ExitCode is null while the exec is still running, and `|| 0` would read
      // that as success. UNKNOWN_EXIT_CODE keeps it distinguishable from a
      // genuine 0 so execChecked can refuse it.
      const exitCode = inspectData.ExitCode ?? UNKNOWN_EXIT_CODE;
      
      return { output, exitCode };
    } catch (error) {
      appLogger.error('Error executing command in Docker container', {
        eventType: 'Container Exec Error',
        containerId,
        command,
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  getContainer(containerId: string): any {
    return this.docker.getContainer(containerId);
  }
}

/**
 * Factory function to create the appropriate container service
 * In the future, this could return different implementations based on configuration
 */
export function createContainerService(): IContainerService {
  // Future enhancement: Choose between Docker and Kubernetes based on config
  return new DockerContainerService();
}

// Default export as a singleton instance
const containerService = createContainerService();
export default containerService;