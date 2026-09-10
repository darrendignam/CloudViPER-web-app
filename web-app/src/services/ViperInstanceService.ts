import { Request, Response } from 'express';
import path from 'path';
import { QueryTypes } from 'sequelize';
import db from '../models';
import { INSTANCE_CREDENTIAL_ATTRIBUTES } from '../models/viperinstance';
import helperFunctions from '../utility/helperFunctions';
import { getAvailablePort } from '../utility/portManager';
import { appLogger } from '../config/logger';
import { UserRole } from '../types/UserRole';
import { readAndProcessScript, validateRequiredScripts } from '../utility/scriptManager';
import containerService from './ContainerService';
import selkiesControlPlane, { SelkiesRole } from './SelkiesControlPlane';
import dotenv from 'dotenv';

dotenv.config();

const DOMAIN_NAME = process.env.DOMAIN_NAME || 'cloudviper.org';
const VIPER_IMAGE = process.env.VIPER_IMAGE || 'ghcr.io/darrendignam/opf-cloud-viper:2.0.0-alpha';
const TEST_CORPUS_HOST_PATH = process.env.TEST_CORPUS_HOST_PATH
  || '/var/viper-docker-project/volumes/test-corpus/test-root/corpora';

// Interface for the user type used in service routes
export interface ServiceUser {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  team?: string;
  invitedById?: number;
}

// Docker's inspect output carries the container's full environment, which holds
// SELKIES_MASTER_TOKEN. That token mints desktop access through the control
// plane, so the values are replaced with a marker before the payload is
// serialised anywhere. Variable names are kept, since they are useful and not
// sensitive.
function redactContainerEnvironment(dockerInspect: any): any {
  const environment = dockerInspect?.Config?.Env;

  if (!Array.isArray(environment)) {
    return dockerInspect;
  }

  return {
    ...dockerInspect,
    Config: {
      ...dockerInspect.Config,
      Env: environment.map((entry: string) => `${String(entry).split('=')[0]}=[redacted]`)
    }
  };
}

/**
 * ViperInstanceService - Handles operations related to Viper instances
 */
class ViperInstanceService {
  
  /**
   * Creates a new Viper instance
   */
  async createInstance(user: ServiceUser): Promise<any> {
    const ownerId = user.id;
    const instanceUUID = helperFunctions.generateRandomString(12);
    const masterToken = helperFunctions.generateSessionToken();
    const statusKey = helperFunctions.generateRandomString(12);
    const instanceURL = `${instanceUUID}.${process.env.APP_HOST}`;
    const containerName = `viper-cloud-${instanceUUID}`;
    
    appLogger.info('Starting instance creation', {
      eventType: 'Instance Creation Started',
      userId: user.id,
      userEmail: user.email,
      userRole: user.role,
      instanceUUID,
      containerName,
      timestamp: new Date().toISOString()
    });

    const envVars = [
      "VIRTUAL_PORT=3000",
      "VIRTUAL_HOST=" + instanceURL,
      "LETSENCRYPT_HOST=" + instanceURL,
      "LETSENCRYPT_EMAIL=sysadmin@openpreservation.org",
      "SELKIES_MASTER_TOKEN=" + masterToken,
      "SELKIES_ENABLE_SHARING=false",
      "SELKIES_ENABLE_COLLAB=false",
      "SELKIES_ENABLE_SHARED=false",
      "TITLE=ViPER",
      "PUID=1000",
      "PGID=1000",
      "ACME_PRE_HOOK=curl " + (process.env.SERVICE_URL || (process.env.NODE_ENV === 'production' ? 
          `http://cloud-viper-gui-app:3000` : 
          `http://localhost:3000`)) + "/service/set-status-instance/"+statusKey+"/begin_cert",
      "ACME_POST_HOOK=curl " + (process.env.SERVICE_URL || (process.env.NODE_ENV === 'production' ? 
          `http://cloud-viper-gui-app:3000` : 
          `http://localhost:3000`)) + "/service/set-status-instance/"+statusKey+"/active",
    ];
    
    appLogger.info('Container environment prepared', {
      eventType: 'Container Env Prepared',
      instanceUUID,
      variables: envVars.map((entry) => entry.split('=')[0]),
      timestamp: new Date().toISOString()
    });

    try {
      // Find an available port for development, production uses reverse proxy
      const availablePort = process.env.NODE_ENV === 'dev' ? await getAvailablePort(3010) : 3000;

      const containerOptions: any = {
        Image: VIPER_IMAGE,
        name: containerName,
        HostConfig: {
          ShmSize: 1024 * 1024 * 1024,
          Binds: [`${TEST_CORPUS_HOST_PATH}:/config/test-corpus:ro`],
          ...(process.env.NODE_ENV === 'dev' && { PortBindings: { 
            '3000/tcp': [{ HostPort: `${availablePort}` }],
            '3001/tcp': [] // Empty binding to prevent null value
          } })
        },
        ExposedPorts: { '3000/tcp': {} },
        NetworkingConfig: {
          EndpointsConfig: {
            'cloud-viper-net': {},
            ...(process.env.NODE_ENV === 'prod' && { 'ingress-proxy': {} }),
            ...(process.env.NODE_ENV === 'production' && { 'ingress-proxy': {} })
          }
        },
        Env: envVars,
      };

      const container = await containerService.createContainer(containerOptions);
      await container.start();

      appLogger.info('Container created and started successfully', {
        eventType: 'Container Created',
        instanceUUID,
        containerName,
        containerId: container.id,
        userId: user.id,
        userEmail: user.email,
        userRole: user.role,
        instanceURL,
        timestamp: new Date().toISOString()
      });

      // Create database entry immediately after container starts successfully
      const newViperInstance = await db.ViperInstance.create({
        uuid: instanceUUID,
        dockerid: container.id,
        name: containerName,
        url: instanceURL,
        masterToken: masterToken,
        statusKey: statusKey,
        owner: ownerId,
        status: 'created',
        logs: [{ timestamp: new Date(), message: "Created" }],
      });

      appLogger.info('ViPER instance database entry created', {
        eventType: 'Database Entry Created',
        instanceId: newViperInstance.id,
        instanceUUID,
        containerId: container.id,
        userId: user.id,
        userEmail: user.email,
        userRole: user.role,
        timestamp: new Date().toISOString()
      });

      // In development mode, simulate ACME hook completion since SSL certs won't be issued
      if (process.env.NODE_ENV === 'dev') {
        this.simulateDevCertProcess(instanceUUID, newViperInstance);
      }

      // Setup monitoring and security (non-critical - don't fail instance creation if these fail)
      try {
        await this.setupContainerSecurityAndMonitoring(container, instanceUUID, statusKey);
      } catch (monitoringError) {
        // Log monitoring setup failure but don't fail the instance creation
        appLogger.warn('Monitoring setup failed - instance created but monitoring may not work', {
          eventType: 'Monitoring Setup Failed',
          instanceUUID,
          containerId: container.id,
          error: (monitoringError as Error).message,
          userId: user.id,
          timestamp: new Date().toISOString()
        });
      }

      appLogger.info('ViPER instance created successfully', {
        eventType: 'Instance Creation Complete',
        instanceId: newViperInstance.id,
        instanceUUID,
        containerId: container.id,
        userId: user.id,
        userEmail: user.email,
        userRole: user.role,
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        container: {
          id: container.id,
          uuid: instanceUUID,
          url: instanceURL,
          status: 'created'
        },
        message: 'ViPER instance created successfully'
      };
    } catch (err) {
      const error = err as Error;
      
      appLogger.error('Container creation failed', {
        eventType: 'Container Creation Failed',
        error: error.message,
        stack: error.stack,
        userId: user.id,
        userEmail: user.email,
        userRole: user.role,
        instanceUUID,
        timestamp: new Date().toISOString()
      });
      
      throw error;
    }
  }

  /**
   * Simulates the ACME certificate process in development mode
   */
  private async simulateDevCertProcess(instanceUUID: string, instance: any): Promise<void> {
    setTimeout(async () => {
      try {
        // Simulate the begin_cert status first
        await db.ViperInstance.update(
          { 
            status: 'begin_cert',
            logs: [...(instance.logs || []), { 
              timestamp: new Date(), 
              message: "Certificate process started (simulated)" 
            }]
          },
          { where: { uuid: instanceUUID } }
        );

        appLogger.info('Dev mode: Certificate process started (simulated)', {
          eventType: 'Dev Status Update',
          instanceUUID,
          status: 'begin_cert',
          timestamp: new Date().toISOString()
        });

        // Wait a bit more then set to active
        setTimeout(async () => {
          try {
            const updatedInstance = await db.ViperInstance.findOne({ where: { uuid: instanceUUID } });
            if (updatedInstance) {
              await updatedInstance.update({
                status: 'active',
                logs: [...(updatedInstance.logs || []), { 
                  timestamp: new Date(), 
                  message: "Instance activated (simulated ACME completion)" 
                }]
              });

              appLogger.info('Dev mode: Instance activated (simulated)', {
                eventType: 'Dev Status Update',
                instanceUUID,
                status: 'active',
                timestamp: new Date().toISOString()
              });
            }
          } catch (activateError) {
            appLogger.warn('Failed to activate instance in dev mode', {
              eventType: 'Dev Status Update Error',
              instanceUUID,
              error: (activateError as Error).message,
              timestamp: new Date().toISOString()
            });
          }
        }, 10000); // Wait 10 seconds then activate
      } catch (certError) {
        appLogger.warn('Failed to start cert process in dev mode', {
          eventType: 'Dev Status Update Error',
          instanceUUID,
          error: (certError as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }, 5000); // Wait 5 seconds then start cert process
  }

  /**
   * Setup security and monitoring for a container
   */
  private async setupContainerSecurityAndMonitoring(container: any, instanceUUID: string, statusKey: string): Promise<void> {
    // Validate required scripts exist
    const scriptValidation = validateRequiredScripts();
    if (!scriptValidation.valid) {
      throw new Error(`Missing required scripts: ${scriptValidation.missing.join(', ')}`);
    }

    // Remove sudo access (security hardening)
    await this.removeSudoAccess(container, instanceUUID);
    
    // Install monitoring dependencies
    await this.installMonitoringDependencies(container, instanceUUID);
    
    // Setup monitoring scripts and service
    await this.setupMonitoringScripts(container, instanceUUID, statusKey);
    
    // Create desktop shortcut for test corpus
    await this.createTestCorpusShortcut(container, instanceUUID);
  }

  /**
   * Removes sudo access from the container user for security
   */
  private async removeSudoAccess(container: any, instanceUUID: string): Promise<void> {
    try {
      // ViPER 2.0 no longer ships /etc/sudoers.d/abc and sudo already prompts for
      // a password, so only the group membership is left to strip. The image also
      // places abc in the docker group; that is inert while no socket is mounted,
      // and instance containers must never mount one.
      await containerService.execInContainer(container.id, ['gpasswd', '-d', 'abc', 'sudo']);
      
      appLogger.info('User removed from sudo group successfully', {
        eventType: 'Security Hardening',
        instanceUUID,
        containerId: container.id,
        action: 'sudo_group_removal',
        timestamp: new Date().toISOString()
      });
    } catch (execErr) { 
      appLogger.warn('Failed to complete sudo access removal', {
        eventType: 'Security Hardening Warning',
        instanceUUID,
        containerId: container.id,
        error: (execErr as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Installs dependencies needed for monitoring
   */
  private async installMonitoringDependencies(container: any, instanceUUID: string): Promise<void> {
    try {
      // Update package lists
      await containerService.execInContainer(container.id, ['apt-get', 'update']);
      
      // scrot captures the monitoring screenshots, bc computes the memory
      // percentage; bash cannot do the fractional division. xdotool and curl are
      // also used by the monitor but already ship in the ViPER 2.0 image. Ask the
      // image to carry these two as well and this whole step can go.
      await containerService.execInContainer(container.id,
        ['apt-get', 'install', '-y', 'scrot', 'bc']
      );
      
      appLogger.info('Monitoring dependencies installed', {
        eventType: 'Monitoring Setup',
        instanceUUID,
        containerId: container.id,
        action: 'dependencies_installed',
        timestamp: new Date().toISOString()
      });
    } catch (execErr) { 
      appLogger.warn('Failed to install monitoring dependencies', {
        eventType: 'Monitoring Setup Warning',
        instanceUUID,
        containerId: container.id,
        error: (execErr as Error).message,
        timestamp: new Date().toISOString()
      });
      throw execErr;
    }
  }

  /**
   * Sets up monitoring scripts and services in the container
   */
  private async setupMonitoringScripts(container: any, instanceUUID: string, statusKey: string): Promise<void> {
    const serviceUrl = process.env.SERVICE_URL || (process.env.NODE_ENV === 'production' ? 
      `http://cloud-viper-gui-app:3000` : `http://localhost:3000`);

    try {
      // Get the monitoring script with variables substituted
      const monitoringScript = readAndProcessScript('viper-monitor.sh', {
        INSTANCE_UUID: instanceUUID,
        SERVICE_URL: serviceUrl,
        DOMAIN_NAME,
        STATUS_KEY: statusKey
      });

      // Create config directory
      await containerService.execInContainer(container.id, ['mkdir', '-p', '/config/.config']);
      
      // Create the monitoring script
      await this.createFileInContainer(container, '/config/.config/viper-monitor.sh', monitoringScript);
      
      // Set executable permissions
      await containerService.execInContainer(container.id, ['chmod', '544', '/config/.config/viper-monitor.sh']);
      
      // Set ownership
      await containerService.execInContainer(container.id, ['chown', 'abc:abc', '/config/.config/viper-monitor.sh']);
      
      appLogger.info('Monitoring script created and made executable', {
        eventType: 'Monitoring Setup',
        instanceUUID,
        containerId: container.id,
        action: 'script_created',
        timestamp: new Date().toISOString()
      });

      // No systemd unit is written. Init in the LinuxServer images is s6-svscan
      // and /run/systemd/system does not exist, so a user unit would never be
      // read. The XDG autostart entry below is what starts the monitor, and MATE
      // honours it from abc's home at /config/.config/autostart.

      // Create autostart entry
      const autostartEntry = readAndProcessScript('viper-monitor.desktop', {
        INSTANCE_UUID: instanceUUID,
        SERVICE_URL: serviceUrl,
        DOMAIN_NAME,
        STATUS_KEY: statusKey
      });

      // Create autostart directory
      await containerService.execInContainer(container.id, ['mkdir', '-p', '/config/.config/autostart']);
      
      // Create desktop entry
      await this.createFileInContainer(container, '/config/.config/autostart/viper-monitor.desktop', autostartEntry);
      
      // Set ownership
      await containerService.execInContainer(container.id, ['chown', '-R', 'abc:abc', '/config/.config']);
      
      // Set permissions
      await containerService.execInContainer(container.id, ['chmod', '444', '/config/.config/autostart/viper-monitor.desktop']);
      
      appLogger.info('XFCE autostart entry created for monitoring', {
        eventType: 'Monitoring Setup',
        instanceUUID,
        containerId: container.id,
        action: 'autostart_created',
        timestamp: new Date().toISOString()
      });

      // Start the monitoring script
      try {
        await containerService.execInContainer(container.id, 
          ['su', 'abc', '-c', 'cd /config/.config && nohup ./viper-monitor.sh > /tmp/viper-monitor.log 2>&1 &']
        );
        
        // Give it time to start
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Check if script is running
        const { output } = await containerService.execInContainer(container.id, ['ps', 'aux']);
        const viperProcesses = output.split('\n').filter(line => line.includes('viper-monitor'));
        
        if (viperProcesses.length > 0) {
          appLogger.info('Monitoring script started successfully', {
            eventType: 'Monitoring Running',
            instanceUUID,
            containerId: container.id,
            timestamp: new Date().toISOString()
          });
        } else {
          appLogger.warn('Monitoring script may not be running', {
            eventType: 'Monitoring Warning',
            instanceUUID,
            containerId: container.id,
            timestamp: new Date().toISOString()
          });
        }
      } catch (startError) {
        appLogger.warn('Failed to start monitoring script directly', {
          eventType: 'Monitoring Start Error',
          instanceUUID,
          containerId: container.id,
          error: (startError as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    } catch (setupError) {
      appLogger.warn('Failed to setup monitoring scripts', {
        eventType: 'Monitoring Setup Error',
        instanceUUID,
        containerId: container.id,
        error: (setupError as Error).message,
        timestamp: new Date().toISOString()
      });
      throw setupError;
    }
  }

  /**
   * Creates a test corpus shortcut on the desktop
   */
  private async createTestCorpusShortcut(container: any, instanceUUID: string): Promise<void> {
    try {
      await containerService.execInContainer(container.id, ['mkdir', '-p', '/config/Desktop']);

      // A symlink rather than a .desktop launcher: Caja refuses to open a
      // launcher it has not been told to trust, and that trust flag is per-user
      // metadata which ViPER's own post-install sets before this code runs. A
      // symlink opens on double click with no flag and accepts dropped files.
      //
      // Created as abc rather than created as root and chowned: chown -h on a
      // symlink is silently a no-op here, which would leave it owned by root
      // while ViPER's own desktop links are owned by abc.
      await containerService.execInContainer(container.id,
        ['ln', '-sfn', '/config/test-corpus', '/config/Desktop/Test Corpus'],
        { User: 'abc' }
      );

      appLogger.info('Test corpus desktop shortcut created', {
        eventType: 'Container Setup',
        instanceUUID,
        containerId: container.id,
        action: 'desktop_shortcut_created',
        timestamp: new Date().toISOString()
      });
    } catch (shortcutErr) {
      appLogger.warn('Failed to create desktop shortcut', {
        eventType: 'Container Setup Warning',
        instanceUUID,
        containerId: container.id,
        error: (shortcutErr as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Helper to create a file with content in a container
   */
  private async createFileInContainer(container: any, filePath: string, content: string): Promise<void> {
    const exec = await container.exec({
      AttachStdout: true, 
      AttachStderr: true,
      Cmd: ['bash', '-c', `cat > ${filePath}`],
      AttachStdin: true
    });
    
    const stream = await exec.start({ hijack: true, stdin: true });
    stream.write(content);
    stream.end();
    
    return new Promise((resolve) => {
      stream.on('end', resolve);
    });
  }

  /**
   * Gets information about a Viper instance
   */
  async inspectInstance(dockerId: string): Promise<any> {
    try {
      // Find the instance in the database
      const instance = await db.ViperInstance.findOne({
        where: { dockerid: dockerId },
        attributes: { exclude: INSTANCE_CREDENTIAL_ATTRIBUTES }
      });
      if (!instance) {
        throw new Error('Instance not found');
      }

      // Get container info from Docker
      const container = containerService.getContainer(dockerId);
      const dockerInspect = redactContainerEnvironment(await container.inspect());

      // Calculate operational hours
      const createdAt = instance.createdAt ? new Date(instance.createdAt) : new Date();
      const now = new Date();
      const operationalHours = ((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60)).toFixed(2);

      return {
        instance,
        operationalHours,
        dockerInspect
      };
    } catch (error) {
      appLogger.error('Error inspecting container', {
        eventType: 'Container Inspect Error',
        dockerId,
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  /**
   * Terminates a Viper instance
   */
  /**
   * Mint a fresh Selkies session token and register it as the instance's only
   * valid credential. Any previously issued link stops working, so relaunching
   * revokes the old one by construction.
   */
  async grantInstanceAccess(instance: any, role: SelkiesRole = 'controller'): Promise<string> {
    if (!instance.masterToken) {
      throw new Error('Instance has no master token - it predates Selkies support and must be recreated');
    }

    const sessionToken = helperFunctions.generateSessionToken();

    await selkiesControlPlane.grantSoleToken(
      { host: instance.name, masterToken: instance.masterToken },
      sessionToken,
      role
    );

    appLogger.info('Instance access granted', {
      eventType: 'Instance Access Granted',
      instanceId: instance.id,
      instanceUUID: instance.uuid,
      role,
      timestamp: new Date().toISOString()
    });

    return sessionToken;
  }

  /**
   * Drop every active token, disconnecting anyone currently viewing.
   * Best effort: a container that is already gone cannot be reached, and that
   * is not a failure of the caller's operation.
   */
  async revokeInstanceAccess(instance: any): Promise<void> {
    if (!instance.masterToken) {
      return;
    }

    try {
      await selkiesControlPlane.revokeAll({ host: instance.name, masterToken: instance.masterToken });

      appLogger.info('Instance access revoked', {
        eventType: 'Instance Access Revoked',
        instanceId: instance.id,
        instanceUUID: instance.uuid,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      appLogger.warn('Could not revoke instance access - container may already be gone', {
        eventType: 'Instance Access Revoke Warning',
        instanceId: instance.id,
        instanceUUID: instance.uuid,
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  }

  async terminateInstance(containerId: string, user: ServiceUser): Promise<any> {
    try {
      // Get instance from database
      const instance = await db.ViperInstance.findOne({ where: { dockerid: containerId } });
      
      if (!instance) {
        throw new Error('Instance not found');
      }

      // Check if user has permission to terminate the instance
      if (user.role !== UserRole.ADMIN && user.id !== instance.owner) {
        throw new Error('Unauthorized - can only terminate own instances');
      }

      appLogger.info('Starting instance termination', {
        eventType: 'Instance Termination Started',
        userId: user.id,
        userRole: user.role,
        instanceId: instance.id,
        containerId,
        timestamp: new Date().toISOString()
      });

      // Set instance status to deleting
      await instance.update({
        status: 'deleted',
        logs: [...(instance.logs || []), { 
          timestamp: new Date(), 
          message: "User requested termination" 
        }]
      });

      await this.revokeInstanceAccess(instance);

      try {
        // Stop and remove container
        const container = containerService.getContainer(containerId);
        await container.stop({ t: 5 });
        await container.remove({ force: true });
        
        appLogger.info('Container stopped and removed', {
          eventType: 'Container Removed',
          userId: user.id,
          userRole: user.role,
          instanceId: instance.id,
          containerId,
          timestamp: new Date().toISOString()
        });
      } catch (containerError) {
        // Log but don't fail if container already removed
        appLogger.warn('Error removing container - may already be removed', {
          eventType: 'Container Remove Warning',
          error: (containerError as Error).message,
          instanceId: instance.id,
          containerId,
          timestamp: new Date().toISOString()
        });
      }

      return { success: true, message: 'Instance terminated successfully' };
    } catch (error) {
      appLogger.error('Error terminating instance', {
        eventType: 'Instance Termination Error',
        error: (error as Error).message,
        containerId,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }
}

// Export a singleton instance
const viperInstanceService = new ViperInstanceService();
export default viperInstanceService;