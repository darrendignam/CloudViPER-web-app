import { Op } from 'sequelize';
import db from '../models';
import { INSTANCE_CREDENTIAL_ATTRIBUTES } from '../models/viperinstance';
import helperFunctions from '../utility/helperFunctions';
import { readIntEnv } from '../utility/envConfig';
import { redactContainerInspect } from '../utility/redaction';
import { getMultipleAvailablePorts } from '../utility/portManager';
import { appLogger } from '../config/logger';
import { UserRole } from '../types/UserRole';
import { readAndProcessScript, validateRequiredScripts } from '../utility/scriptManager';
import containerService from './ContainerService';
import selkiesControlPlane, { SelkiesRole, SELKIES_CONTROL_PORT } from './SelkiesControlPlane';
import containerImageService from './ContainerImageService';
import { validateEnvVars, validateVolumes, validateResourceLimits, toDockerBinds, toDockerEnv, toDockerResources } from './InstanceCustomisation';


const DOMAIN_NAME = process.env.DOMAIN_NAME || 'cloudviper.org';
// Applied to every container this service creates. Teardown of a container with
// no database row requires it, so a stray or hostile id cannot reach the
// orchestrator's own container, MySQL, or anything else on the host.
export const CLOUDVIPER_INSTANCE_LABEL = 'org.openpreservation.cloudviper.instance';

// Derived from the same setting the control plane client dials, so the two
// cannot drift: a published port that nothing connects to is silent.
const SELKIES_CONTROL_PORT_SPEC = `${SELKIES_CONTROL_PORT}/tcp`;

// The Docker network Traefik watches. Instances join it in production so the
// proxy can see them; in development the app runs on the host and reaches
// containers through published ports instead.
const INGRESS_NETWORK = process.env.INGRESS_NETWORK || 'cloudviper_ingress';

// Traefik's certificate resolver, as named in traefik.yml. It resolves a
// wildcard for the instance domain, so a desktop is reachable the moment
// Traefik sees the container: there is no per-instance ACME exchange, which is
// what the old nginx-proxy path needed its ACME_PRE_HOOK and ACME_POST_HOOK for.
const TRAEFIK_CERT_RESOLVER = process.env.TRAEFIK_CERT_RESOLVER || 'letsencrypt';

// Grace period before an instance is called active, covering Traefik's provider
// refresh. Not a certificate wait: the wildcard is issued long before any
// instance exists.
const INSTANCE_ACTIVATION_DELAY_MS = readIntEnv('INSTANCE_ACTIVATION_DELAY_MS', 5000);

// Traefik reads routing from container labels rather than from environment
// variables, which is the whole difference between this and the nginx-proxy
// arrangement it replaced.
function traefikRoutingLabels(containerName: string, instanceURL: string): Record<string, string> {
  return {
    'traefik.enable': 'true',
    [`traefik.http.routers.${containerName}.rule`]: `Host(\`${instanceURL}\`)`,
    [`traefik.http.routers.${containerName}.entrypoints`]: 'websecure',
    [`traefik.http.routers.${containerName}.tls`]: 'true',
    [`traefik.http.routers.${containerName}.tls.certresolver`]: TRAEFIK_CERT_RESOLVER,
    [`traefik.http.services.${containerName}.loadbalancer.server.port`]: '3000',
    'traefik.docker.network': INGRESS_NETWORK
  };
}

// Interface for the user type used in service routes
export interface ServiceUser {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  teamId?: number | null;
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

/**
 * ViperInstanceService - Handles operations related to Viper instances
 */
/**
 * What a launch may be told to do beyond "start one for me".
 *
 * Everything here except buildMode is a system administrator's privilege, and
 * all of it is validated by the same rules a saved image is, so an override
 * changes what a desktop is given without changing what a desktop may reach.
 */
/**
 * How many instances a role may own at once. -1 is unlimited.
 *
 * Lives here rather than beside the route because two gates now consult it: the
 * caller's own limit, and the limit of whoever an administrator is launching on
 * behalf of. Two copies of this would drift.
 */
export function getInstanceLimit(role: UserRole): number {
    switch (role) {
        case UserRole.TESTING:
        case UserRole.MEMBER:
            return 1;
        case UserRole.TEAM_LEADER:
            return 5; // Team leaders can have more instances
        case UserRole.TEAM_ADMIN:
            return 10; // Team admins can have more instances
        case UserRole.SUBSCRIBER:
            return 10; // or unlimited, depending on business rules
        case UserRole.ADMIN:
            return -1; // unlimited
        default:
            return 0;
    }
}

export interface CreateInstanceOptions {
  buildMode?: boolean;
  /** Launch on someone else's behalf, so it is waiting when they log in. */
  ownerId?: number | null;
  /** Merged over the image's own, per name. */
  envOverrides?: Record<string, unknown> | null;
  /** Replaces the image's list outright when given. Omit to keep the image's. */
  volumeOverrides?: unknown;
  cpuLimit?: number | null;
  memoryLimitMb?: number | null;
}

class ViperInstanceService {
  
  /**
   * Creates a new Viper instance
   */
  /**
   * Create an instance.
   *
   * `buildMode` produces an instance that keeps sudo, so a system admin can
   * customise it and commit the result as a new image. It is deliberately a
   * separate path rather than a switch on the normal one: every other instance
   * stays hardened, and which kind this is stays visible on the row.
   */
  /**
   * Who the instance belongs to.
   *
   * Defaults to whoever asked. An administrator may name someone else, which is
   * how fifteen desktops come to be running before fifteen people arrive, and
   * the target is read from the database rather than trusted from the request
   * because their role and team decide which image they resolve to.
   */
  private async resolveOwner(user: ServiceUser, ownerId?: number | null): Promise<ServiceUser> {
    if (ownerId === undefined || ownerId === null || ownerId === user.id) {
      return user;
    }

    const target = await db.User.findByPk(ownerId);

    if (!target) {
      throw new Error('There is no user with that id to own the instance');
    }

    return {
      id: target.id,
      username: target.username,
      email: target.email,
      role: target.role,
      teamId: target.teamId ?? null
    } as ServiceUser;
  }

  async createInstance(
    user: ServiceUser,
    requestedImageId?: number | null,
    options: CreateInstanceOptions = {}
  ): Promise<any> {
    const instanceUUID = helperFunctions.generateRandomString(12);
    const masterToken = helperFunctions.generateSessionToken();
    const statusKey = helperFunctions.generateRandomString(12);
    const instanceURL = `${instanceUUID}.${process.env.APP_HOST}`;
    const containerName = `viper-cloud-${instanceUUID}`;

    const buildMode = options.buildMode === true;

    if (buildMode && user.role !== UserRole.ADMIN) {
      throw new Error('Only system administrators can create build instances');
    }

    // Everything below is a system administrator's privilege. A member's launch
    // is entirely decided by the image their team was given, which is the point:
    // they get a working desktop without being handed the means to reconfigure
    // one.
    const overriding = options.envOverrides !== undefined
      || options.volumeOverrides !== undefined
      || (options.ownerId !== undefined && options.ownerId !== null);

    if (overriding && user.role !== UserRole.ADMIN) {
      throw new Error('Only system administrators can override an instance at launch');
    }

    const owner = await this.resolveOwner(user, options.ownerId);

    // The target's own limit applies, not the administrator's. Without this a
    // slip while pre-creating a room's worth of desktops gives one person three
    // and another none, and nothing complains until the day.
    if (owner.id !== user.id) {
      const limit = getInstanceLimit(owner.role);

      if (limit !== -1) {
        const held = await db.ViperInstance.count({ where: { owner: owner.id } });

        if (held >= limit) {
          throw new Error(
            `${owner.username} already has ${held} instance${held === 1 ? '' : 's'}, ` +
            `which is the limit for a ${owner.role} account`);
        }
      }
    }

    const image = await containerImageService.resolveImageForUser(owner, requestedImageId);

    // Re-validated at launch rather than trusted from the row. What was legal
    // when it was saved may not be now: a directory can be deleted, replaced by
    // a symlink, or moved outside the shared root, and the row would still hold
    // the path that used to be fine.
    //
    // Overrides are validated by the same rules, not waved through for being an
    // admin's. An administrator may change what a desktop is given; they may not
    // hand it a variable the platform owns or a path outside the shared root,
    // because that would breach the boundary between one desktop and another
    // rather than merely configure this one.
    const envOverrides = validateEnvVars(options.envOverrides);
    const customEnv = { ...validateEnvVars(image.envVars), ...envOverrides };

    const customVolumes = options.volumeOverrides === undefined
      ? validateVolumes(image.volumes)
      : validateVolumes(options.volumeOverrides);

    const resourceLimits = validateResourceLimits({
        cpuLimit: options.cpuLimit ?? image.cpuLimit,
        memoryLimitMb: options.memoryLimitMb ?? image.memoryLimitMb
    });

    const ownerId = owner.id;

    appLogger.info('Starting instance creation', {
      eventType: 'Instance Creation Started',
      image: image.reference,
      imageOrigin: image.origin,
      buildMode,
      extraEnvVars: Object.keys(customEnv),
      // Names only. The values are why this matters: one of them is usually an
      // API key, and a log is the last place it should end up.
      overriddenEnvVars: Object.keys(envOverrides),
      volumesOverridden: options.volumeOverrides !== undefined,
      ownerId,
      launchedOnBehalf: ownerId !== user.id,
      extraVolumes: customVolumes.map((mount) => `${mount.hostPath} -> ${mount.containerPath}`),
      cpuLimit: resourceLimits.cpuLimit,
      memoryLimitMb: resourceLimits.memoryLimitMb,
      userId: user.id,
      userEmail: user.email,
      userRole: user.role,
      instanceUUID,
      containerName,
      timestamp: new Date().toISOString()
    });

    const envVars = [
      "SELKIES_MASTER_TOKEN=" + masterToken,
      "SELKIES_ENABLE_SHARING=false",
      "SELKIES_ENABLE_COLLAB=false",
      "SELKIES_ENABLE_SHARED=false",
      "TITLE=ViPER",
      "PUID=1000",
      "PGID=1000",
      // Image extras last only in the sense of being appended; the reserved
      // names above can never appear here, because validateEnvVars refuses
      // them outright rather than letting a later entry win a race with
      // whatever Docker does about duplicates.
      ...toDockerEnv(customEnv),
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
      // In development the app runs on the host, so the container name does not
      // resolve and the control plane has to be reachable through a published
      // port, as the web port already is. Never published in production.
      //
      // The control port binds the loopback address only. Docker defaults to
      // 0.0.0.0 and its iptables rules bypass a host firewall, which on a shared
      // network would offer /tokens to anyone who can reach the machine.
      // controlPlaneTarget dials 127.0.0.1 and nothing else.
      const [webPort, devControlPort] = isDev ? await getMultipleAvailablePorts(2, 3010) : [3000, undefined];
      const devPorts = isDev ? { web: webPort, control: devControlPort! } : null;

      const containerOptions: any = {
        Image: image.reference,
        name: containerName,
        HostConfig: {
          ShmSize: 1024 * 1024 * 1024,
          // Without these one desktop can exhaust the host and end every other
          // desktop on it. The ceiling is what keeps a bad job to one person.
          ...toDockerResources(resourceLimits),
          // Shared folders come from the image's configuration now. The old
          // hardcoded corpus bind was v1's version of this feature: a fixed
          // path that on this appliance was empty, giving every desktop an icon
          // that led nowhere.
          Binds: toDockerBinds(customVolumes),
          ...(isDev && { PortBindings: {
            '3000/tcp': [{ HostPort: `${webPort}` }],
            '3001/tcp': [], // Empty binding to prevent null value
            [SELKIES_CONTROL_PORT_SPEC]: [{ HostIp: '127.0.0.1', HostPort: `${devControlPort}` }]
          } })
        },
        Labels: {
          // Ownership first. isCloudViPERInstance refuses to tear down any
          // container without this, so it must survive alongside the routing
          // labels rather than be replaced by them.
          [CLOUDVIPER_INSTANCE_LABEL]: instanceUUID,
          ...traefikRoutingLabels(containerName, instanceURL)
        },
        ExposedPorts: { '3000/tcp': {}, ...(isDev && { [SELKIES_CONTROL_PORT_SPEC]: {} }) },
        NetworkingConfig: {
          EndpointsConfig: {
            'cloud-viper-net': {},
            ...(process.env.NODE_ENV === 'prod' && { [INGRESS_NETWORK]: {} }),
            ...(process.env.NODE_ENV === 'production' && { [INGRESS_NETWORK]: {} })
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
        imageId: image.imageId,
        imageReference: image.reference,
        isBuildInstance: buildMode,
        devPorts,
        statusKey: statusKey,
        owner: ownerId,
        // Null when someone launched their own, so the column reads as "an
        // administrator did this for them" rather than being noise on every row.
        createdById: ownerId === user.id ? null : user.id,
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

      // An instance used to be promoted to 'active' by the proxy's ACME_POST_HOOK
      // once a certificate had been issued for its subdomain. Traefik serves a
      // wildcard, so no certificate is issued per instance and nothing calls
      // back. The promotion has to happen here instead.
      if (process.env.NODE_ENV === 'dev') {
        this.simulateDevCertProcess(instanceUUID, newViperInstance);
      } else {
        this.activateOnceRouted(instanceUUID, newViperInstance, container.id);
      }

      // Setup monitoring and security (non-critical - don't fail instance creation if these fail)
      try {
        await this.setupContainerSecurityAndMonitoring(container, instanceUUID, statusKey, buildMode, customVolumes);
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
   * Promote an instance to 'active' once Traefik has had time to see it.
   *
   * Traefik's Docker provider picks up a new container within its watch
   * interval, and the wildcard certificate already exists, so there is nothing
   * to wait for beyond that. The delay is a short grace period, not a
   * certificate exchange.
   *
   * The container is re-checked before promotion rather than promoted blindly:
   * one that died during start would otherwise be advertised as ready, and the
   * launch page would frame a desktop that was never coming.
   */
  private activateOnceRouted(instanceUUID: string, instance: any, containerId: string): void {
    setTimeout(async () => {
      try {
        const details = await containerService.inspectContainer(containerId);

        if (!details?.State?.Running) {
          await instance.update({
            status: 'error',
            logs: [...(instance.logs || []), {
              timestamp: new Date(),
              message: `Container stopped before it could be routed (${details?.State?.Status ?? 'unknown'})`
            }]
          });

          appLogger.error('Instance container was not running when it should have been routed', {
            eventType: 'Instance Activation Failed',
            instanceUUID,
            containerId,
            state: details?.State?.Status ?? 'unknown',
            timestamp: new Date().toISOString()
          });
          return;
        }

        await instance.update({
          status: 'active',
          logs: [...(instance.logs || []), {
            timestamp: new Date(),
            message: 'Instance active, routed by Traefik under the wildcard certificate'
          }]
        });

        appLogger.info('Instance activated', {
          eventType: 'Instance Activated',
          instanceUUID,
          containerId,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        appLogger.error('Could not activate instance', {
          eventType: 'Instance Activation Failed',
          instanceUUID,
          containerId,
          error: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }, INSTANCE_ACTIVATION_DELAY_MS);
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
  private async setupContainerSecurityAndMonitoring(
    container: any,
    instanceUUID: string,
    statusKey: string,
    buildMode = false,
    volumes: Array<{ containerPath: string }> = []
  ): Promise<void> {
    // Validate required scripts exist
    const scriptValidation = validateRequiredScripts();
    if (!scriptValidation.valid) {
      throw new Error(`Missing required scripts: ${scriptValidation.missing.join(', ')}`);
    }

    // A build instance exists so an admin can install and configure things
    // inside it, which needs sudo. Every other instance is stripped of it.
    if (buildMode) {
      appLogger.warn('Build instance keeps sudo access', {
        eventType: 'Build Instance Privileged',
        instanceUUID,
        containerId: container.id,
        timestamp: new Date().toISOString()
      });
    } else {
      await this.removeSudoAccess(container, instanceUUID);
    }
    
    // Install monitoring dependencies
    await this.installMonitoringDependencies(container, instanceUUID);
    
    // Setup monitoring scripts and service
    await this.setupMonitoringScripts(container, instanceUUID, statusKey);
    
    await this.createMountShortcuts(container, instanceUUID, volumes);
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
   * Put a desktop icon on each shared folder given to this instance.
   *
   * Without one the files are present but unfound: they sit in the home
   * directory, and somebody at a workshop will not think to go looking there.
   */
  private async createMountShortcuts(
    container: any,
    instanceUUID: string,
    volumes: Array<{ containerPath: string }>
  ): Promise<void> {
    if (volumes.length === 0) {
      return;
    }

    try {
      // Both as abc. Creating the directory as root would leave it root owned
      // and the symlink step, which runs as abc, would fail on a fresh volume.
      await this.execChecked(container.id, ['mkdir', '-p', '/config/Desktop'], { User: 'abc' });

      for (const mount of volumes) {
        // The name the administrator chose for the destination is the name on
        // the desktop, so what someone sees matches what was configured.
        const label = mount.containerPath.split('/').filter(Boolean).pop();

        if (!label) continue;

        // A symlink rather than a .desktop launcher: Caja refuses to open a
        // launcher it has not been told to trust, and that trust flag is
        // per-user metadata which ViPER's own post-install sets before this code
        // runs. A symlink opens on double click with no flag and accepts
        // dropped files.
        //
        // Created as abc rather than created as root and chowned: chown -h on a
        // symlink is silently a no-op here, which would leave it owned by root
        // while ViPER's own desktop links are owned by abc.
        await this.execChecked(container.id,
          ['ln', '-sfn', mount.containerPath, `/config/Desktop/${label}`],
          { User: 'abc' }
        );
      }

      appLogger.info('Desktop shortcuts created for shared files', {
        eventType: 'Container Setup',
        instanceUUID,
        containerId: container.id,
        shortcuts: volumes.map((mount) => mount.containerPath),
        timestamp: new Date().toISOString()
      });
    } catch (shortcutErr) {
      // Not fatal. The files are mounted and reachable from the home directory
      // either way; only the icon is missing.
      appLogger.warn('Failed to create desktop shortcuts', {
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
      const dockerInspect = redactContainerInspect(await container.inspect());

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
   * Mint a fresh Selkies session token and add it to the instance's live set.
   *
   * Tokens accumulate rather than replace: a team leader looking in must not
   * eject the owner mid-session. Earlier links therefore keep working until they
   * age out after SESSION_TOKEN_TTL_MS or are pushed past
   * MAX_ACTIVE_SESSION_TOKENS. Relaunching does not revoke anything; only
   * revokeInstanceAccess does.
   */
  async grantInstanceAccess(instance: any, role: SelkiesRole = 'controller', userId?: number): Promise<string> {
    if (!instance.masterToken) {
      throw new Error('Instance has no master token - it predates Selkies support and must be recreated');
    }

    const sessionToken = helperFunctions.generateSessionToken();
    const issued = {
      ...prunedSessionTokens(instance.sessionTokens),
      [sessionToken]: {
        role,
        slot: null,
        mk_control: false,
        issuedAt: new Date().toISOString(),
        // Recorded so logout can drop this user's tokens without disturbing
        // anyone else's. Without it the only options are revoking everything,
        // which ejects an observing team leader, or revoking nothing.
        userId: userId ?? null
      }
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
   * Withdraw one user's desktop credentials without touching their containers.
   *
   * Logging out ends access, not work. A long running job keeps going in the
   * container's X session, which does not depend on anyone watching it; the
   * user signs back in, launches again, and a fresh token is minted. Stopping
   * the container here would throw that work away.
   *
   * Only this user's tokens go. A team leader watching the same desktop keeps
   * theirs, which is the same reason grantInstanceAccess adds rather than
   * replaces.
   */
  async revokeUserSessions(userId: number): Promise<number> {
    if (!userId) {
      return 0;
    }

    // Tokens live inside a JSON column, so the holder cannot be expressed as a
    // WHERE clause portably. The candidate set is every live instance, which is
    // small: instances are per user and short lived.
    const instances = await db.ViperInstance.findAll({
      where: { status: { [Op.ne]: 'deleted' } }
    });

    let revokedFrom = 0;

    for (const instance of instances) {
      const tokens = instance.sessionTokens || {};
      const remaining = Object.fromEntries(
        Object.entries(tokens).filter(([, permissions]: [string, any]) => permissions?.userId !== userId)
      );

      if (Object.keys(remaining).length === Object.keys(tokens).length) {
        continue;
      }

      try {
        await selkiesControlPlane.replaceTokens(
          controlPlaneTarget(instance),
          toControlPlaneTokenSet(remaining)
        );
        await instance.update({ sessionTokens: remaining });
        revokedFrom += 1;
      } catch (error) {
        // The container may be stopped or gone. The row still has to lose the
        // token, or logging out would leave a credential recorded as live.
        appLogger.warn('Could not reach container to revoke session on logout', {
          eventType: 'Logout Revoke Warning',
          instanceId: instance.id,
          instanceUUID: instance.uuid,
          userId,
          error: (error as Error).message,
          timestamp: new Date().toISOString()
        });
        await instance.update({ sessionTokens: remaining });
      }
    }

    if (revokedFrom > 0) {
      appLogger.info('Desktop sessions revoked on logout', {
        eventType: 'Logout Sessions Revoked',
        userId,
        instanceCount: revokedFrom,
        timestamp: new Date().toISOString()
      });
    }

    return revokedFrom;
  }

  /**
   * Run a command in a container and fail loudly on a non-zero exit.
   * execInContainer resolves with an exitCode that callers routinely ignore, so
   * a permission error or a missing binary otherwise passes for success.
   */
  private async execChecked(containerId: string, command: string[], options?: any): Promise<string> {
    const { output, exitCode } = await containerService.execInContainer(containerId, command, options);

    if (exitCode !== 0) {
      const reason = exitCode < 0 ? 'no exit code reported' : `exit ${exitCode}`;
      throw new Error(`Command failed (${reason}): ${command.join(' ')} :: ${output.trim()}`);
    }

    return output;
  }

  /**
   * Confirm a container carries this service's instance label. Anything the
   * service did not create, or that cannot be inspected, is refused.
   */
  private async isCloudViPERInstance(containerId: string): Promise<boolean> {
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
      const message = (removeError as Error).message || '';

      // Already gone is the outcome this was asking for, so it counts as
      // success. Two terminations of the same instance race constantly in
      // practice: a click in the dashboard and a scripted call, or an impatient
      // user clicking twice because the button gave no feedback. The loser used
      // to report "could not be removed" about a container that had in fact
      // just been removed, which reads as a failure needing attention.
      if (/no such container|404/i.test(message)) {
        appLogger.info('Container was already gone', {
          eventType: 'Container Already Removed',
          instanceId,
          containerId,
          timestamp: new Date().toISOString()
        });
        return true;
      }

      appLogger.warn('Container removal failed', {
        eventType: 'Container Remove Failed',
        error: message,
        instanceId,
        containerId,
        timestamp: new Date().toISOString()
      });
      return false;
    }
  }

  /**
   * Terminates a Viper instance
   */
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
        if (!(await this.isCloudViPERInstance(containerId))) {
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

      const removed = await this.removeContainer(containerId, instance.id);

      // The row is already marked deleted, so a container Docker refused to
      // remove is invisible to the orphan reclaim path: findOne still returns a
      // row. Saying so here is the only chance the caller gets to notice.
      return removed
        ? { success: true, message: 'Instance terminated successfully' }
        : { success: false, message: 'Instance marked terminated, but its container could not be removed' };
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