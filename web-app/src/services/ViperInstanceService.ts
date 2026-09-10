import db from '../models';
import { INSTANCE_CREDENTIAL_ATTRIBUTES } from '../models/viperinstance';
import helperFunctions from '../utility/helperFunctions';
import { readIntEnv } from '../utility/envConfig';
import { getAvailablePort } from '../utility/portManager';
import { appLogger } from '../config/logger';
import { UserRole } from '../types/UserRole';
import { readAndProcessScript, validateRequiredScripts } from '../utility/scriptManager';
import containerService from './ContainerService';
import selkiesControlPlane, { SelkiesRole } from './SelkiesControlPlane';
import dotenv from 'dotenv';

dotenv.config();

const DOMAIN_NAME = process.env.DOMAIN_NAME || 'cloudviper.org';
// Applied to every container this service creates. Teardown of a container with
// no database row requires it, so a stray or hostile id cannot reach the
// orchestrator's own container, MySQL, or anything else on the host.
export const CLOUDVIPER_INSTANCE_LABEL = 'org.openpreservation.cloudviper.instance';

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

// Session tokens outlive nothing but the container, so they are bounded here
// rather than accumulating for the life of the instance. A desktop session that
// has not been reopened within the window is assumed done with.
const SESSION_TOKEN_TTL_MS = readIntEnv('SESSION_TOKEN_TTL_MS', 12 * 60 * 60 * 1000);
const MAX_ACTIVE_SESSION_TOKENS = 8;

function prunedSessionTokens(tokens: Record<string, any> | undefined | null): Record<string, any> {
  const entries = Object.entries(tokens || {});
  const cutoff = Date.now() - SESSION_TOKEN_TTL_MS;

  return Object.fromEntries(
    entries
      .filter(([, permissions]) => {
        const issuedAt = Date.parse(permissions?.issuedAt ?? '');
        return Number.isFinite(issuedAt) && issuedAt >= cutoff;
      })
      .sort(([, a], [, b]) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt))
      .slice(0, MAX_ACTIVE_SESSION_TOKENS - 1)
  );
}

// issuedAt is bookkeeping of ours; the control plane rejects unknown fields.
function toControlPlaneTokenSet(tokens: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(tokens).map(([token, permissions]) => [
      token,
      { role: permissions.role, slot: permissions.slot ?? null, mk_control: permissions.mk_control ?? false }
    ])
  );
}

// A container is addressed by name on the Docker network in production, and
// through its published port in development, where the app runs on the host and
// that name does not resolve.
function controlPlaneTarget(instance: any) {
  const devControlPort = instance.devPorts?.control;

  return devControlPort
    ? { host: '127.0.0.1', masterToken: instance.masterToken, port: devControlPort }
    : { host: instance.name, masterToken: instance.masterToken };
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
      const isDev = process.env.NODE_ENV === 'dev';
      const availablePort = isDev ? await getAvailablePort(3010) : 3000;
      // In development the app runs on the host, so the container name does not
      // resolve and the control plane has to be reachable through a published
      // port like the web port. Never published in production.
      const devControlPort = isDev ? await getAvailablePort(availablePort + 1) : undefined;
      const devPorts = isDev ? { web: availablePort, control: devControlPort! } : null;

      const containerOptions: any = {
        Image: VIPER_IMAGE,
        name: containerName,
        HostConfig: {
          ShmSize: 1024 * 1024 * 1024,
          Binds: [`${TEST_CORPUS_HOST_PATH}:/config/test-corpus:ro`],
          ...(isDev && { PortBindings: {
            '3000/tcp': [{ HostPort: `${availablePort}` }],
            '3001/tcp': [], // Empty binding to prevent null value
            '8083/tcp': [{ HostPort: `${devControlPort}` }]
          } })
        },
        Labels: { [CLOUDVIPER_INSTANCE_LABEL]: instanceUUID },
        ExposedPorts: { '3000/tcp': {}, ...(isDev && { '8083/tcp': {} }) },
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
        devPorts,
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
      // Both as abc. Creating the directory as root would leave it root owned
      // and the symlink step, which runs as abc, would fail on a fresh volume.
      await this.execChecked(container.id, ['mkdir', '-p', '/config/Desktop'], { User: 'abc' });

      // A symlink rather than a .desktop launcher: Caja refuses to open a
      // launcher it has not been told to trust, and that trust flag is per-user
      // metadata which ViPER's own post-install sets before this code runs. A
      // symlink opens on double click with no flag and accepts dropped files.
      //
      // Created as abc rather than created as root and chowned: chown -h on a
      // symlink is silently a no-op here, which would leave it owned by root
      // while ViPER's own desktop links are owned by abc.
      await this.execChecked(container.id,
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
    const issued = {
      ...prunedSessionTokens(instance.sessionTokens),
      [sessionToken]: { role, slot: null, mk_control: false, issuedAt: new Date().toISOString() }
    };

    // The control plane replaces its entire set, so every still-valid token has
    // to be sent again. Sending only the new one would disconnect whoever is
    // already in the desktop, which for a team leader looking in would mean
    // ejecting the owner mid-session.
    await selkiesControlPlane.replaceTokens(
      controlPlaneTarget(instance),
      toControlPlaneTokenSet(issued)
    );

    await instance.update({ sessionTokens: issued });

    appLogger.info('Instance access granted', {
      eventType: 'Instance Access Granted',
      instanceId: instance.id,
      instanceUUID: instance.uuid,
      role,
      activeTokens: Object.keys(issued).length,
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
      await selkiesControlPlane.revokeAll(controlPlaneTarget(instance));

      if (typeof instance.update === 'function') {
        await instance.update({ sessionTokens: {} });
      }

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

  /**
   * Run a command in a container and fail loudly on a non-zero exit.
   * execInContainer resolves with an exitCode that callers routinely ignore, so
   * a permission error or a missing binary otherwise passes for success.
   */
  private async execChecked(containerId: string, command: string[], options?: any): Promise<string> {
    const { output, exitCode } = await containerService.execInContainer(containerId, command, options);

    if (exitCode !== 0) {
      throw new Error(`Command failed (exit ${exitCode}): ${command.join(' ')} :: ${output.trim()}`);
    }

    return output;
  }

  /**
   * Confirm a container carries this service's instance label. Anything the
   * service did not create, or that cannot be inspected, is refused.
   */
  private async isCloudViperInstance(containerId: string): Promise<boolean> {
    try {
      const container = containerService.getContainer(containerId);
      const details = await container.inspect();
      return Boolean(details?.Config?.Labels?.[CLOUDVIPER_INSTANCE_LABEL]);
    } catch (error) {
      appLogger.warn('Could not verify container ownership', {
        eventType: 'Container Ownership Check Failed',
        containerId,
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
      return false;
    }
  }

  /**
   * Stop and remove a container. A container that has already gone is not an
   * error: the caller's goal is that it no longer runs.
   */
  private async removeContainer(containerId: string, instanceId?: number): Promise<boolean> {
    const container = containerService.getContainer(containerId);

    // A stop that fails must not skip the remove. Docker rejects stop on a
    // container that has already exited, which is the usual state of the
    // orphans this path exists to reclaim, and remove with force stops a
    // running container by itself.
    try {
      await container.stop({ t: 5 });
    } catch (stopError) {
      appLogger.info('Container did not need stopping', {
        eventType: 'Container Stop Skipped',
        reason: (stopError as Error).message,
        instanceId,
        containerId,
        timestamp: new Date().toISOString()
      });
    }

    try {
      await container.remove({ force: true });

      appLogger.info('Container removed', {
        eventType: 'Container Removed',
        instanceId,
        containerId,
        timestamp: new Date().toISOString()
      });
      return true;
    } catch (removeError) {
      appLogger.warn('Container removal failed', {
        eventType: 'Container Remove Failed',
        error: (removeError as Error).message,
        instanceId,
        containerId,
        timestamp: new Date().toISOString()
      });
      return false;
    }
  }

  async terminateInstance(containerId: string, user: ServiceUser): Promise<any> {
    try {
      // Get instance from database
      const instance = await db.ViperInstance.findOne({ where: { dockerid: containerId } });

      // A container with no database row is an orphan, usually a create that
      // failed after the container started. Leaving it running strands host
      // resources with nothing tracking them, so it is still torn down. Only an
      // admin may do so: without a row there is no owner to check against.
      if (!instance) {
        if (user.role !== UserRole.ADMIN) {
          throw new Error('Instance not found');
        }

        // Without a database row there is nothing tying this id to CloudViPER,
        // so the container must identify itself. The route only checks that the
        // id is ten characters or more, and names like cloud-viper-gui-app and
        // cloud-viper-mysqldb clear that easily.
        if (!(await this.isCloudViperInstance(containerId))) {
          throw new Error('Instance not found');
        }

        appLogger.warn('Terminating orphaned container with no database row', {
          eventType: 'Orphan Container Termination',
          containerId,
          userId: user.id,
          timestamp: new Date().toISOString()
        });

        const removed = await this.removeContainer(containerId);
        return {
          success: removed,
          message: removed ? 'Orphaned container removed' : 'Orphaned container could not be removed'
        };
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

      await this.removeContainer(containerId, instance.id);

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