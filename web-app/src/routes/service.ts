import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { QueryTypes, Op } from 'sequelize';
import db from '../models';
import { INSTANCE_CREDENTIAL_ATTRIBUTES } from '../models/viperinstance';
import { SelkiesRole } from '../services/SelkiesControlPlane';
import { readIntEnv } from '../utility/envConfig';
import { appLogger } from '../config/logger';
import { UserRole } from '../types/UserRole';
import containerService from '../services/ContainerService';
import viperInstanceService from '../services/ViperInstanceService';
import systemStatsService from '../services/SystemStatsService';


const router = express.Router();

// Short by design: the readiness probe is polled from the launch page while a
// container starts, so a slow answer is as good as a miss.
const INSTANCE_PROBE_TIMEOUT_MS = readIntEnv('INSTANCE_PROBE_TIMEOUT_MS', 3000);

// How often the dashboard feed pushes. Each tick samples every instance
// container, so this is a real cost on the host, not just on the client.
const DASHBOARD_STREAM_INTERVAL_MS = readIntEnv('DASHBOARD_STREAM_INTERVAL_MS', 5000);
// Using containerService instead of direct Docker instance
// const docker = new Docker({ socketPath: '/var/run/docker.sock' }); // Keep for compatibility with existing code

/*
ROLES:
- user: nothing
- testing: can run one viper
- member: can run one viper  
- subscriber: pays for use
- admin: viper and user management

Note: These roles are now defined as an enum in ../types/UserRole.ts
*/

interface ServiceUser {
    id: number;
    username: string;
    email: string;
    role: UserRole;
    teamId?: number | null;
    invitedById?: number;
}

/**
 * Everything a page needs about the signed-in user. The team association has to
 * be loaded explicitly or userToJson reports no team, which reads as "you are
 * in no team" rather than as a missing include.
 */
const VIEW_USER_INCLUDE = [
    { model: db.User, as: 'invitedBy', attributes: ['id', 'username', 'email'] },
    { model: db.Team, as: 'team', attributes: ['id', 'name'] }
];

function userToJson(_user: any) {
    return {
        id: _user.id,
        username: _user.username,
        email: _user.email,
        role: _user.role,
        teamId: _user.teamId ?? null,
        team: _user.team ? _user.team.name : null,
        invitedById: _user.invitedById,
        invitedBy: _user.invitedBy ? {
            id: _user.invitedBy.id,
            username: _user.invitedBy.username,
            email: _user.invitedBy.email
        } : undefined
    };
}

// Credentials plus the large JSON columns, which are dropped for payload size
// rather than secrecy.
const INSTANCE_HIDDEN_ATTRIBUTES = [...INSTANCE_CREDENTIAL_ATTRIBUTES, 'lastScreenshot', 'activityHistory'];

// Helper function to check user permissions
function checkUserPermission(user: ServiceUser | undefined, requiredRole: UserRole | UserRole[], resourceOwnerId?: number): {
    authorized: boolean;
    reason?: string;
} {
    if (!user) {
        return { authorized: false, reason: 'Authentication required' };
    }

    const requiredRoles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    
    // Admin has access to everything
    if (user.role === UserRole.ADMIN) {
        return { authorized: true };
    }

    // Check if user has required role
    if (!requiredRoles.includes(user.role)) {
        return { authorized: false, reason: `Insufficient permissions. Required: ${requiredRoles.join(' or ')}` };
    }

    // Check resource ownership if specified
    if (resourceOwnerId !== undefined && user.id !== resourceOwnerId) {
        return { authorized: false, reason: 'Can only access own resources' };
    }

    return { authorized: true };
}

// Helper function to get instance limits by role
function getInstanceLimit(role: UserRole): number {
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

// Helper function to authenticate monitoring endpoints using statusKey
async function authenticateMonitoringRequest(instanceUUID: string, providedStatusKey: string): Promise<{
    authorized: boolean;
    instance?: any;
    reason?: string;
}> {
    if (!providedStatusKey || typeof providedStatusKey !== 'string' || providedStatusKey.length < 8) {
        return { authorized: false, reason: 'Invalid or missing statusKey' };
    }

    try {
        const instance = await db.ViperInstance.findOne({
            where: { uuid: instanceUUID }
        });

        if (!instance) {
            return { authorized: false, reason: 'Instance not found' };
        }

        if (instance.statusKey !== providedStatusKey) {
            appLogger.warn('Invalid statusKey used for monitoring endpoint', {
                eventType: 'Invalid StatusKey Authentication',
                instanceUUID,
                providedStatusKey: providedStatusKey.substring(0, 4) + '****', // Log only first 4 chars for security
                timestamp: new Date().toISOString()
            });
            return { authorized: false, reason: 'Invalid statusKey authentication' };
        }

        return { authorized: true, instance };
    } catch (error) {
        appLogger.error('Error during monitoring authentication', {
            eventType: 'Monitoring Authentication Error',
            instanceUUID,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        return { authorized: false, reason: 'Authentication system error' };
    }
}

/* GET home page. */
router.get('/', (req: Request, res: Response) => {
    const user = req.user as ServiceUser | undefined;
    if (user) {
        switch (user.role) {
            case UserRole.ADMIN:
                res.redirect('/service/admin');
                break;
            case UserRole.TEAM_ADMIN:
                res.redirect('/service/team-admin');
                break;
            case UserRole.TEAM_LEADER:
                res.redirect('/service/team-leader');
                break;
            case UserRole.SUBSCRIBER:
                res.redirect('/service/member'); // Subscribers use member view for now
                break;
            case UserRole.TESTING:
                res.redirect('/service/testing');
                break;
            case UserRole.MEMBER:
                res.redirect('/service/member');
                break;

            default:
                res.redirect('/account');
        }
    } else {
        res.redirect('/account/login');
    }
});

router.get('/admin', (req: Request, res: Response) => {
    const user = req.user as ServiceUser | undefined;
    const permissionCheck = checkUserPermission(user, UserRole.ADMIN);
    
    if (!permissionCheck.authorized) {
        appLogger.warn('Unauthorized admin access attempt', {
            eventType: 'Unauthorized Access',
            userId: user?.id || 'unknown',
            userRole: user?.role || 'unknown',
            endpoint: '/service/admin',
            reason: permissionCheck.reason,
            ipAddress: req.ip,
            timestamp: new Date().toISOString()
        });
        res.redirect('/service');
        return;
    }
    
    res.render('service_admin', { user: userToJson(user!) });
});

router.get('/testing', (req: Request, res: Response) => {
    const user = req.user as ServiceUser | undefined;
    const permissionCheck = checkUserPermission(user, UserRole.TESTING);
    
    if (!permissionCheck.authorized) {
        appLogger.warn('Unauthorized testing access attempt', {
            eventType: 'Unauthorized Access',
            userId: user?.id || 'unknown',
            userRole: user?.role || 'unknown',
            endpoint: '/service/testing',
            reason: permissionCheck.reason,
            ipAddress: req.ip,
            timestamp: new Date().toISOString()
        });
        res.redirect('/service');
        return;
    }
    
    res.render('service_testing', { user: userToJson(user!) });
});

router.get('/member', async (req: Request, res: Response) => {
    const user = req.user as ServiceUser | undefined;
    const permissionCheck = checkUserPermission(user, UserRole.MEMBER);
    
    if (!permissionCheck.authorized) {
        appLogger.warn('Unauthorized member access attempt', {
            eventType: 'Unauthorized Access',
            userId: user?.id || 'unknown',
            userRole: user?.role || 'unknown',
            endpoint: '/service/member',
            reason: permissionCheck.reason,
            ipAddress: req.ip,
            timestamp: new Date().toISOString()
        });
        res.redirect('/service');
        return;
    }
    
    // Fetch full user data with inviter information
    try {
        const fullUser = await db.User.findByPk(user!.id, { include: VIEW_USER_INCLUDE });
        
        res.render('service_member', { user: userToJson(fullUser || user!) });
    } catch (error) {
        appLogger.error('Could not load full user data for member page', {
            eventType: 'Member Page Data Error',
            userId: user!.id,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        res.render('service_member', { user: userToJson(user!) });
    }
});

router.get('/team-admin', async (req: Request, res: Response) => {
    const user = req.user as ServiceUser | undefined;
    const permissionCheck = checkUserPermission(user, UserRole.TEAM_ADMIN);
    
    if (!permissionCheck.authorized) {
        appLogger.warn('Unauthorized team admin access attempt', {
            eventType: 'Unauthorized Access',
            userId: user?.id || 'unknown',
            userRole: user?.role || 'unknown',
            endpoint: '/service/team-admin',
            reason: permissionCheck.reason,
            ipAddress: req.ip,
            timestamp: new Date().toISOString()
        });
        res.redirect('/service');
        return;
    }
    
    // Fetch full user data with inviter information
    try {
        const fullUser = await db.User.findByPk(user!.id, { include: VIEW_USER_INCLUDE });
        
        res.render('service_team_admin', { user: userToJson(fullUser || user!) });
    } catch (error) {
        appLogger.error('Error fetching full user data:', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
        res.render('service_team_admin', { user: userToJson(user!) });
    }
});

router.get('/team-leader', async (req: Request, res: Response) => {
    const user = req.user as ServiceUser | undefined;
    const permissionCheck = checkUserPermission(user, UserRole.TEAM_LEADER);
    
    if (!permissionCheck.authorized) {
        appLogger.warn('Unauthorized team leader access attempt', {
            eventType: 'Unauthorized Access',
            userId: user?.id || 'unknown',
            userRole: user?.role || 'unknown',
            endpoint: '/service/team-leader',
            reason: permissionCheck.reason,
            ipAddress: req.ip,
            timestamp: new Date().toISOString()
        });
        res.redirect('/service');
        return;
    }
    
    // Fetch full user data with inviter information
    try {
        const fullUser = await db.User.findByPk(user!.id, { include: VIEW_USER_INCLUDE });
        
        res.render('service_team_leader', { user: userToJson(fullUser || user!) });
    } catch (error) {
        appLogger.error('Error fetching full user data:', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
        res.render('service_team_leader', { user: userToJson(user!) });
    }
});

router.post('/new-instance', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const permissionCheck = checkUserPermission(user, [UserRole.TESTING, UserRole.MEMBER, UserRole.SUBSCRIBER, UserRole.ADMIN]);

    if (!permissionCheck.authorized) {
        appLogger.warn('Unauthorized instance creation attempt', {
            eventType: 'Unauthorized Access',
            userId: user?.id || 'unknown',
            userRole: user?.role || 'unknown',
            endpoint: '/service/new-instance',
            reason: permissionCheck.reason,
            ipAddress: req.ip,
            timestamp: new Date().toISOString()
        });
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
    }

    // Check instance limits based on user role
    const instanceLimit = getInstanceLimit(user!.role);
    if (instanceLimit > 0) { // -1 means unlimited
        try {
            const existingInstances = await db.ViperInstance.count({
                where: { owner: user!.id }
            });
            
            if (existingInstances >= instanceLimit) {
                appLogger.warn('Instance limit exceeded', {
                    eventType: 'Instance Limit Exceeded',
                    userId: user!.id,
                    userRole: user!.role,
                    existingInstances,
                    limit: instanceLimit,
                    timestamp: new Date().toISOString()
                });
                res.status(429).json({ 
                    error: 'Instance limit reached', 
                    message: `Your ${user!.role} account is limited to ${instanceLimit} active instance${instanceLimit > 1 ? 's' : ''}. Please terminate existing instances before creating new ones.`,
                    existingInstances,
                    limit: instanceLimit
                });
                return;
            }
        } catch (dbError) {
            appLogger.error('Error checking instance limits', {
                eventType: 'Database Error',
                userId: user!.id,
                error: (dbError as Error).message,
                timestamp: new Date().toISOString()
            });
            res.status(500).json({ error: 'Database error checking instance limits' });
            return;
        }
    }

    try {
        // Use the ViperInstanceService to create the instance
        // An image choice and build mode are both refused inside the service
        // for roles that may not use them, so they are passed straight through
        // rather than being pre-filtered into a silent default here.
        const requestedImageId = req.body?.imageId ? Number(req.body.imageId) : null;
        const buildMode = req.body?.buildMode === true;

        const result = await viperInstanceService.createInstance(user!, requestedImageId, { buildMode });
        res.json(result);
    } catch (err) {
        const error = err as Error;
        
        appLogger.error('Container creation failed', {
            eventType: 'Container Creation Failed',
            error: error.message,
            stack: error.stack,
            userId: user!.id,
            userEmail: user!.email,
            userRole: user!.role,
            timestamp: new Date().toISOString()
        });
        
        // Log to database as well
        try {
            await db.Log.create({
                eventType: 'Error',
                message: 'Error creating or starting container',
                eventDescription: error.toString(),
                userId: user!.id,
                createdAt: new Date(),
            });
        } catch (logError) {
            appLogger.error('Failed to log error to database:', { error: (logError as Error)?.message ?? String(logError), timestamp: new Date().toISOString() });
        }
        
        res.status(500).json({ 
            error: 'Error creating or starting container',
            message: 'An error occurred while creating your ViPER instance. Please try again or contact support.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

router.get('/viperinstances', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    try {
        let instances;
        
        if (user.role === UserRole.ADMIN) {
            // Admin can see all instances with optimized query - exclude heavy JSON fields
            instances = await db.ViperInstance.findAll({
                attributes: {
                    exclude: INSTANCE_HIDDEN_ATTRIBUTES // Exclude heavy JSON fields
                },
                include: [
                    {
                        model: db.User,
                        as: 'ownerUser',
                        attributes: ['id', 'username', 'email', 'firstName', 'lastName']
                    },
                    {
                        model: db.Screenshot,
                        as: 'screenshots',
                        attributes: ['id', 'capturedAt', 'receivedAt'],
                        limit: 1,
                        order: [['createdAt', 'DESC']],
                        required: false
                    },
                    {
                        model: db.Activity,
                        as: 'activities',
                        attributes: ['id', 'activityScore', 'reportedAt', 'receivedAt'],
                        limit: 1,
                        order: [['createdAt', 'DESC']],
                        required: false
                    }
                ],
                order: [['createdAt', 'DESC']] // Most recent first
            });
            
            // appLogger.info('Admin accessed all instances', {
            //     eventType: 'Instance List Access',
            //     userId: user.id,
            //     userRole: user.role,
            //     instanceCount: instances.length,
            //     timestamp: new Date().toISOString()
            // });
        } else if (user.role === UserRole.TEAM_ADMIN || user.role === UserRole.TEAM_LEADER) {
            // Team admins and leaders see all instances for their team
            if (!user.teamId) {
                res.status(403).json({ error: 'You must be in a team to view team instances' });
                return;
            }
            const teamUsers = await db.User.findAll({
                where: { teamId: user.teamId },
                attributes: ['id']
            });
            const teamUserIds = teamUsers.map(u => u.id);
            instances = await db.ViperInstance.findAll({
                where: { owner: teamUserIds },
                attributes: { exclude: INSTANCE_HIDDEN_ATTRIBUTES },
                include: [
                    { model: db.User, as: 'ownerUser', attributes: ['id', 'username', 'email', 'firstName', 'lastName'] },
                    { model: db.Screenshot, as: 'screenshots', attributes: ['id', 'capturedAt', 'receivedAt'], limit: 1, order: [['createdAt', 'DESC']], required: false },
                    { model: db.Activity, as: 'activities', attributes: ['id', 'activityScore', 'reportedAt', 'receivedAt'], limit: 1, order: [['createdAt', 'DESC']], required: false }
                ],
                order: [['createdAt', 'DESC']]
            });
            appLogger.info('Team admin/leader accessed team instances', {
                eventType: 'Team Instance List Access',
                userId: user.id,
                userRole: user.role,
                teamId: user.teamId,
                instanceCount: instances.length,
                timestamp: new Date().toISOString()
            });
        } else {
            // Non-admin users can only see their own instances
            const permissionCheck = checkUserPermission(user, [UserRole.TESTING, UserRole.MEMBER, UserRole.SUBSCRIBER]);
            
            if (!permissionCheck.authorized) {
                appLogger.warn('Unauthorized instance list access', {
                    eventType: 'Unauthorized Access',
                    userId: user.id,
                    userRole: user.role,
                    reason: permissionCheck.reason,
                    timestamp: new Date().toISOString()
                });
                res.status(403).json({ error: permissionCheck.reason });
                return;
            }

            instances = await db.ViperInstance.findAll({
                where: { owner: user.id },
                attributes: {
                    exclude: INSTANCE_HIDDEN_ATTRIBUTES // Exclude heavy JSON fields
                },
                include: [
                    {
                        model: db.User,
                        as: 'ownerUser',
                        attributes: ['id', 'username', 'email', 'firstName', 'lastName']
                    },
                    {
                        model: db.Screenshot,
                        as: 'screenshots',
                        attributes: ['id', 'capturedAt', 'receivedAt'],
                        limit: 1,
                        order: [['createdAt', 'DESC']],
                        required: false
                    },
                    {
                        model: db.Activity,
                        as: 'activities',
                        attributes: ['id', 'activityScore', 'reportedAt', 'receivedAt'],
                        limit: 1,
                        order: [['createdAt', 'DESC']],
                        required: false
                    }
                ],
                order: [['createdAt', 'DESC']]
            });
            
            appLogger.info('User accessed own instances', {
                eventType: 'Instance List Access',
                userId: user.id,
                userRole: user.role,
                instanceCount: instances.length,
                timestamp: new Date().toISOString()
            });
        }

        // Add additional metadata to instances
        const enrichedInstances = instances.map(instance => {
            const instanceData = instance.toJSON() as any;
            return {
                ...instanceData,
                operationalHours: instance.createdAt ? 
                    ((new Date().getTime() - new Date(instance.createdAt).getTime()) / (1000 * 60 * 60)).toFixed(2) : 
                    'Unknown',
                canTerminate: user.role === UserRole.ADMIN || instance.owner === user.id,
                // Add summary data from related tables
                hasRecentScreenshot: instanceData.screenshots && instanceData.screenshots.length > 0,
                lastScreenshotAt: instanceData.screenshots && instanceData.screenshots.length > 0 ? 
                    instanceData.screenshots[0].capturedAt : null,
                hasRecentActivity: instanceData.activities && instanceData.activities.length > 0,
                lastActivityScore: instanceData.activities && instanceData.activities.length > 0 ? 
                    instanceData.activities[0].activityScore : 0,
                lastActivityAt: instanceData.activities && instanceData.activities.length > 0 ? 
                    instanceData.activities[0].reportedAt : null
            };
        });

        res.json({
            instances: enrichedInstances,
            total: enrichedInstances.length,
            userRole: user.role,
            canCreateNew: getInstanceLimit(user.role) === -1 || // Unlimited
                await db.ViperInstance.count({ where: { owner: user.id } }) < getInstanceLimit(user.role)
        });

    } catch (error) {
        const err = error as Error;
        
        appLogger.error('Error retrieving viper instances', {
            eventType: 'Instance List Error',
            userId: user.id,
            userRole: user.role,
            error: err.message,
            stack: err.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ 
            error: 'Error retrieving viper instances',
            message: 'Failed to load instance list. Please try again.'
        });
    }
});

router.post('/terminate-instance/:containerId', async (req: Request, res: Response): Promise<void> => {
    const containerID = req.params.containerId;
    const user = req.user as ServiceUser | undefined;
    
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    // Input validation
    if (!containerID || typeof containerID !== 'string' || containerID.length < 10) {
        appLogger.warn('Invalid container ID provided', {
            eventType: 'Invalid Container ID',
            containerId: containerID,
            userId: user.id,
            timestamp: new Date().toISOString()
        });
        res.status(400).json({ error: 'Invalid container ID provided' });
        return;
    }

    appLogger.info('Container termination requested', {
        eventType: 'Container Termination Request',
        containerId: containerID,
        userId: user.id,
        userEmail: user.email,
        userRole: user.role,
        timestamp: new Date().toISOString()
    });

    try {
        // Use ViperInstanceService to terminate the instance
        const result = await viperInstanceService.terminateInstance(containerID, user);

        if (!result.success) {
            res.status(500).json({ success: false, error: result.message });
            return;
        }

        res.json({
            success: true,
            message: result.message
        });
    } catch (error) {
        appLogger.error('Error during termination', {
            eventType: 'Termination Error',
            containerId: containerID,
            error: (error as Error).message,
            userId: user.id,
            timestamp: new Date().toISOString()
        });

        // Check if it's a permission error
        if ((error as Error).message.includes('Unauthorized')) {
            res.status(403).json({ error: (error as Error).message });
        } 
        // Check if it's a not found error
        else if ((error as Error).message.includes('not found')) {
            res.status(404).json({ error: (error as Error).message });
        }
        // Otherwise it's a server error
        else {
            res.status(500).json({
                error: 'Error during termination',
                message: 'Failed to terminate instance'
            });
        }
    }
});

/**
 * Where a browser should reach this desktop. Production routes by wildcard
 * subdomain through the proxy; development has no proxy and no DNS entry, so it
 * uses the host port the container published.
 */
function instanceBaseUrl(instance: any): string {
    const devWebPort = instance.devPorts?.web;

    if (devWebPort) {
        return `http://localhost:${devWebPort}`;
    }

    const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    return `${scheme}://${instance.url}`;
}

/**
 * Resolve an instance the caller is allowed to reach, or explain why not.
 * Owners, their team admins and leaders, and system admins all qualify, which
 * matches the rules already applied to the monitoring endpoints.
 */
async function resolveAccessibleInstance(user: ServiceUser | undefined, instanceUUID: string): Promise<{
    instance?: any;
    status?: number;
    error?: string;
    role?: SelkiesRole;
}> {
    if (!user) {
        return { status: 401, error: 'Authentication required' };
    }

    const instance = await db.ViperInstance.findOne({ where: { uuid: instanceUUID } });

    if (!instance) {
        return { status: 404, error: 'Instance not found' };
    }

    // Only the owner and a system admin drive the desktop. A team lead looking
    // in gets a view: they supervise the session, they do not take the keyboard
    // off the person using it.
    if (user.role === UserRole.ADMIN || user.id === instance.owner) {
        return { instance, role: 'controller' };
    }

    // A null teamId is not a team, and SQL will not match it against another
    // null, so two teamless users can no longer reach each other's desktops.
    // That used to need an explicit guard against the 'none' sentinel, and a
    // path that forgot it handed over a controller token rather than a view.
    if ((user.role === UserRole.TEAM_ADMIN || user.role === UserRole.TEAM_LEADER) && user.teamId) {
        const owner = await db.User.findByPk(instance.owner);
        if (owner && owner.teamId === user.teamId) {
            return { instance, role: 'viewer' };
        }
    }

    return { status: 403, error: 'Unauthorized - can only view own or team instances' };
}

/**
 * Open a desktop. Mints a fresh Selkies session token and frames the desktop so
 * the token stays out of the address bar, browser history and any copied URL.
 *
 * The new token joins the container's live set rather than replacing it, so a
 * previously issued link keeps working until it ages out. Revocation is an
 * explicit act: see revokeInstanceAccess.
 */
router.get('/launch/:instanceUUID', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const { instanceUUID } = req.params;

    try {
        const access = await resolveAccessibleInstance(user, instanceUUID);

        if (!access.instance) {
            appLogger.warn('Instance launch denied', {
                eventType: 'Instance Launch Denied',
                instanceUUID,
                userId: user?.id ?? null,
                reason: access.error,
                timestamp: new Date().toISOString()
            });
            res.status(access.status!).json({ error: access.error });
            return;
        }

        // The page itself mints nothing. It renders a shell that asks for a
        // token over POST, so a cross-site link cannot cause a mint, and a mint
        // replaces the control plane's token set.
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.render('service_launch', {
            user: userToJson(user!),
            instanceName: access.instance.name,
            instanceUUID: access.instance.uuid
        });
    } catch (error) {
        appLogger.error('Instance launch failed', {
            eventType: 'Instance Launch Error',
            instanceUUID,
            userId: user?.id ?? null,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        res.status(502).json({ error: 'Could not prepare the instance for launch' });
    }
});

/**
 * Mint a session token for a desktop and return the URL to frame.
 *
 * POST rather than GET because it changes state: a mint replaces the control
 * plane's token set. With sameSite 'lax' on the session cookie, a cross-site
 * page cannot reach this as the signed-in user.
 */
router.post('/launch/:instanceUUID/token', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const { instanceUUID } = req.params;

    try {
        const access = await resolveAccessibleInstance(user, instanceUUID);

        if (!access.instance) {
            appLogger.warn('Instance token request denied', {
                eventType: 'Instance Token Denied',
                instanceUUID,
                userId: user?.id ?? null,
                reason: access.error,
                timestamp: new Date().toISOString()
            });
            res.status(access.status!).json({ error: access.error });
            return;
        }

        const sessionToken = await viperInstanceService.grantInstanceAccess(access.instance, access.role, user?.id);

        res.setHeader('Referrer-Policy', 'no-referrer');
        res.json({
            url: `${instanceBaseUrl(access.instance)}/?token=${encodeURIComponent(sessionToken)}`,
            role: access.role
        });
    } catch (error) {
        appLogger.error('Instance token mint failed', {
            eventType: 'Instance Token Error',
            instanceUUID,
            userId: user?.id ?? null,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        res.status(502).json({ error: 'Could not prepare the instance for launch' });
    }
});

/**
 * Report whether the desktop is actually serving yet.
 *
 * The browser cannot answer this for itself. A cross-origin probe has to be
 * no-cors, which yields an opaque response that resolves on a 502 as readily as
 * on a 200, so the page would call a proxy error "Connected". The app can see
 * the real status, and this endpoint is same-origin, so the page can read it.
 *
 * Reachable means the instance answered below 500. A 401 or 403 still proves
 * the desktop is up; Selkies authenticates over the WebSocket, not here.
 */
router.get('/launch/:instanceUUID/ready', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const { instanceUUID } = req.params;

    let access;

    try {
        access = await resolveAccessibleInstance(user, instanceUUID);
    } catch (error) {
        appLogger.error('Instance readiness check failed', {
            eventType: 'Instance Probe Error',
            instanceUUID,
            userId: user?.id ?? null,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        res.status(500).json({ error: 'Could not check this instance' });
        return;
    }

    if (!access.instance) {
        res.status(access.status!).json({ error: access.error });
        return;
    }

    try {
        const response = await fetch(instanceBaseUrl(access.instance), {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(INSTANCE_PROBE_TIMEOUT_MS)
        });

        res.json({ reachable: response.status < 500, status: response.status });
    } catch (error) {
        // A refused connection or a timeout is the normal answer while the
        // container is still starting, so this is not logged as an error.
        appLogger.debug('Instance readiness probe did not connect', {
            eventType: 'Instance Probe Miss',
            instanceUUID,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        res.json({ reachable: false });
    }
});

/**
 * The instances a user may see, scoped by role.
 *
 * Extracted so the live feed and the REST route cannot disagree. They were
 * about to be two copies of the same rule, and a feed that showed a different
 * set from the page it feeds is a disclosure bug waiting to be written.
 *
 * Admins see everything; team admins and leaders see their team's; everyone
 * else sees their own. A user with no team sees only their own, because a null
 * teamId matches nobody, including other teamless users.
 */
const INSTANCE_LIST_INCLUDE = (): any[] => [
    { model: db.User, as: 'ownerUser', attributes: ['id', 'username', 'email', 'firstName', 'lastName'] },
    { model: db.Screenshot, as: 'screenshots', attributes: ['id', 'capturedAt', 'receivedAt'], limit: 1, order: [['createdAt', 'DESC']], required: false },
    { model: db.Activity, as: 'activities', attributes: ['id', 'activityScore', 'reportedAt', 'receivedAt'], limit: 1, order: [['createdAt', 'DESC']], required: false }
];

async function listInstancesFor(user: ServiceUser): Promise<any[]> {
    const common = {
        attributes: { exclude: INSTANCE_HIDDEN_ATTRIBUTES },
        include: INSTANCE_LIST_INCLUDE(),
        order: [['createdAt', 'DESC']] as any
    };

    if (user.role === UserRole.ADMIN) {
        return db.ViperInstance.findAll(common);
    }

    if ((user.role === UserRole.TEAM_ADMIN || user.role === UserRole.TEAM_LEADER) && user.teamId) {
        const teamUsers = await db.User.findAll({ where: { teamId: user.teamId }, attributes: ['id'] });
        return db.ViperInstance.findAll({ ...common, where: { owner: teamUsers.map((u: any) => u.id) } });
    }

    return db.ViperInstance.findAll({ ...common, where: { owner: user.id } });
}

/**
 * Live dashboard feed.
 *
 * Replaces six-second polling. Server-sent events rather than WebSockets
 * because the traffic is entirely one way: the browser never tells the server
 * anything over this channel, and EventSource reconnects by itself, which a
 * raw WebSocket does not.
 *
 * Each client holds an open socket for as long as its dashboard is open, so
 * the interval is per-connection and cleared on close. Forgetting that is how
 * a page refresh becomes a permanent leak of one timer per visit.
 */
router.get('/events', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const permissionCheck = checkUserPermission(user, [
        UserRole.TESTING, UserRole.MEMBER, UserRole.SUBSCRIBER,
        UserRole.TEAM_LEADER, UserRole.TEAM_ADMIN, UserRole.ADMIN
    ]);

    if (!permissionCheck.authorized) {
        res.status(user ? 403 : 401).json({ error: permissionCheck.reason });
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        // Traefik does not buffer, but a proxy added later might, and a buffered
        // event stream is a stream that never arrives.
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    // Only system admins see host telemetry; everyone else gets their own
    // instance list and nothing about the machine it runs on.
    const includeStats = user!.role === UserRole.ADMIN;

    let closed = false;

    const send = (event: string, payload: unknown) => {
        if (closed) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const tick = async () => {
        if (closed) return;

        try {
            const instances = await listInstancesFor(user!);
            send('instances', instances);

            if (includeStats) {
                send('stats', await systemStatsService.collect());
            }
        } catch (error) {
            // Reported on the stream rather than by closing it: a transient
            // database blip should not make every dashboard reconnect at once.
            send('feed-error', { message: (error as Error).message });
        }
    };

    send('hello', { interval: DASHBOARD_STREAM_INTERVAL_MS, stats: includeStats });
    await tick();

    const timer = setInterval(tick, DASHBOARD_STREAM_INTERVAL_MS);
    // Comment frames keep intermediaries from treating a quiet stream as dead.
    const heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 20000);

    req.on('close', () => {
        closed = true;
        clearInterval(timer);
        clearInterval(heartbeat);
    });
});

/**
 * Ownership check for the reverse proxy's auth_request directive. Returns no
 * body: nginx only reads the status. 2xx admits the request, 401 and 403 deny.
 *
 * NOT WIRED, deliberately. An instance is served from <uuid>.<domain> while the
 * session cookie is host-only for the app's own domain, so an auth_request
 * subrequest for a desktop carries no cookie and this would answer 401 for
 * everyone, the owner included.
 *
 * Making it work needs `domain: '.<domain>'` on the session cookie, which then
 * sends that cookie to every instance subdomain, which is to say into the ViPER
 * containers themselves. Users have a shell in there. That trades a Selkies
 * token scoped to one desktop for a session cookie scoped to the whole account,
 * which is a worse position than the one this was meant to improve.
 *
 * Kept because access control belongs at the proxy eventually, but that needs a
 * credential that is not the session cookie: a signed per-instance cookie set on
 * the instance's own host at launch would do it. Until then the Selkies session
 * token is what guards a desktop.
 */
router.get('/auth/instance/:instanceUUID', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const { instanceUUID } = req.params;

    try {
        const access = await resolveAccessibleInstance(user, instanceUUID);

        if (!access.instance) {
            res.status(access.status === 404 ? 403 : access.status!).end();
            return;
        }

        res.status(200).end();
    } catch (error) {
        appLogger.error('Instance auth check failed', {
            eventType: 'Instance Auth Check Error',
            instanceUUID,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        res.status(403).end();
    }
});



router.get('/set-status-instance/:statuskey/:status', async (req: Request, res: Response): Promise<void> => {
    const statuskey = req.params.statuskey;
    const status = req.params.status;

    // Input validation
    if (!statuskey || typeof statuskey !== 'string' || statuskey.length < 8) {
        appLogger.warn('Invalid status key provided', {
            eventType: 'Invalid Status Key',
            statuskey,
            ipAddress: req.ip,
            timestamp: new Date().toISOString()
        });
        res.status(400).json({ error: 'Invalid status key' });
        return;
    }

    // Validate status values
    const validStatuses = ['created', 'starting', 'begin_cert', 'active', 'stopping', 'stopped', 'error'];
    if (!status || !validStatuses.includes(status)) {
        appLogger.warn('Invalid status value provided', {
            eventType: 'Invalid Status Value',
            statuskey,
            status,
            validStatuses,
            ipAddress: req.ip,
            timestamp: new Date().toISOString()
        });
        res.status(400).json({ 
            error: 'Invalid status value',
            validStatuses 
        });
        return;
    }

    appLogger.info('Instance status update requested', {
        eventType: 'Status Update Request',
        statuskey,
        status,
        ipAddress: req.ip,
        timestamp: new Date().toISOString()
    });

    try {
        const instance = await db.ViperInstance.findOne({
            where: { statusKey: statuskey }
        });

        if (!instance) {
            appLogger.warn('Instance not found for status update', {
                eventType: 'Instance Not Found',
                statuskey,
                status,
                timestamp: new Date().toISOString()
            });
            res.status(404).json({ error: 'Instance not found' });
            return;
        }

        // Add new log entry with timestamp
        const newLogEntry = { 
            timestamp: new Date(), 
            message: `Status changed to: ${status}`,
            previousStatus: instance.status
        };

        const updatedLogs = [...(instance.logs || []), newLogEntry];

        await instance.update({
            status: status,
            logs: updatedLogs,
            updatedAt: new Date()
        });

        appLogger.info('Instance status updated successfully', {
            eventType: 'Status Update Complete',
            instanceId: instance.id,
            instanceUUID: instance.uuid,
            statuskey,
            previousStatus: instance.status,
            newStatus: status,
            timestamp: new Date().toISOString()
        });

        res.json({
            success: true,
            message: 'Status updated successfully',
            instance: {
                id: instance.id,
                uuid: instance.uuid,
                previousStatus: instance.status,
                newStatus: status,
                updatedAt: new Date()
            }
        });

    } catch (error) {
        const err = error as Error;
        
        appLogger.error('Error updating instance status', {
            eventType: 'Status Update Error',
            statuskey,
            status,
            error: err.message,
            stack: err.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: 'Database error',
            message: 'Failed to update instance status'
        });
    }
});

// Get detailed Docker inspect data for an instance (admin only)
router.get('/viperinstance/:dockerid/inspect', async (req: Request, res: Response) => {
    const user = req.user as ServiceUser | undefined;
    
    if (!user || user.role !== UserRole.ADMIN) {
        res.status(403).send({ message: 'Admin access required' });
        return;
    }

    try {
        const { dockerid } = req.params;
        
        // Use ViperInstanceService to get instance details
        const result = await viperInstanceService.inspectInstance(dockerid);
        res.json(result);
    } catch (error) {
        appLogger.error('Error retrieving instance details', {
            eventType: 'Instance Inspect Error',
            dockerId: req.params.dockerid,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        
        // Check if it's a not found error
        if ((error as Error).message.includes('not found')) {
            res.status(404).send({ message: 'Instance not found' });
        } else {
            res.status(500).send({ 
                message: 'Error retrieving instance details', 
                error: (error as Error).message 
            });
        }
    }
});

// Helper function to read and parse log files
const readLogFile = (logType: string, date?: string): Promise<any[]> => {
    return new Promise((resolve, reject) => {
        const logsDir = path.join(__dirname, '../../logs');
        const logDate = date || new Date().toISOString().split('T')[0];
        const fileName = `${logType}-${logDate}.log`;
        const filePath = path.join(logsDir, fileName);

        if (!fs.existsSync(filePath)) {
            resolve([]);
            return;
        }

        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                reject(err);
                return;
            }

            try {
                const lines = data.trim().split('\n').filter(line => line.length > 0);
                
                if (logType === 'session' || logType === 'app') {
                    // Parse JSON logs
                    const parsedLogs = lines.map((line, index) => {
                        try {
                            return JSON.parse(line);
                        } catch (parseErr) {
                            return {
                                error: 'Failed to parse log entry',
                                rawLine: line,
                                lineNumber: index + 1
                            };
                        }
                    });
                    resolve(parsedLogs);
                } else {
                    // Plain text logs (SQL)
                    const parsedLogs = lines.map((line, index) => ({
                        lineNumber: index + 1,
                        content: line,
                        timestamp: line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/) ? 
                                  line.split(' - ')[0] : null
                    }));
                    resolve(parsedLogs);
                }
            } catch (parseError) {
                reject(parseError);
            }
        });
    });
};

// Get session logs (admin only)
router.get('/logs/session', async (req: Request, res: Response) => {
    const user = req.user as ServiceUser | undefined;
    
    if (!user || user.role !== UserRole.ADMIN) {
        res.status(403).send({ message: 'Admin access required' });
        return;
    }

    try {
        const { date, limit = '50', offset = '0' } = req.query;
        const logs = await readLogFile('session', date as string);
        
        // Apply pagination
        const startIndex = parseInt(offset as string);
        const endIndex = startIndex + parseInt(limit as string);
        const paginatedLogs = logs.slice(startIndex, endIndex);
        
        res.json({
            logs: paginatedLogs,
            total: logs.length,
            hasMore: endIndex < logs.length,
            date: date || new Date().toISOString().split('T')[0]
        });
    } catch (error) {
        appLogger.error('Error reading session logs:', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
        res.status(500).send({ message: 'Error reading session logs', error });
    }
});

// Get SQL logs (admin only)
router.get('/logs/sql', async (req: Request, res: Response) => {
    const user = req.user as ServiceUser | undefined;
    
    if (!user || user.role !== UserRole.ADMIN) {
        res.status(403).send({ message: 'Admin access required' });
        return;
    }

    try {
        const { date, limit = '50', offset = '0' } = req.query;
        const logs = await readLogFile('sql', date as string);
        
        // Apply pagination
        const startIndex = parseInt(offset as string);
        const endIndex = startIndex + parseInt(limit as string);
        const paginatedLogs = logs.slice(startIndex, endIndex);
        
        res.json({
            logs: paginatedLogs,
            total: logs.length,
            hasMore: endIndex < logs.length,
            date: date || new Date().toISOString().split('T')[0]
        });
    } catch (error) {
        appLogger.error('Error reading SQL logs:', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
        res.status(500).send({ message: 'Error reading SQL logs', error });
    }
});

// Get application logs (admin only)
router.get('/logs/app', async (req: Request, res: Response) => {
    const user = req.user as ServiceUser | undefined;
    
    if (!user || user.role !== UserRole.ADMIN) {
        res.status(403).send({ message: 'Admin access required' });
        return;
    }

    try {
        const { date, limit = '50', offset = '0' } = req.query;
        const logs = await readLogFile('app', date as string);
        
        // Apply pagination
        const startIndex = parseInt(offset as string);
        const endIndex = startIndex + parseInt(limit as string);
        const paginatedLogs = logs.slice(startIndex, endIndex);
        
        res.json({
            logs: paginatedLogs,
            total: logs.length,
            hasMore: endIndex < logs.length,
            date: date || new Date().toISOString().split('T')[0]
        });
    } catch (error) {
        appLogger.error('Error reading application logs:', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
        res.status(500).send({ message: 'Error reading application logs', error });
    }
});

// Get available log dates (admin only)
router.get('/logs/dates', async (req: Request, res: Response) => {
    const user = req.user as ServiceUser | undefined;
    
    if (!user || user.role !== UserRole.ADMIN) {
        res.status(403).send({ message: 'Admin access required' });
        return;
    }

    try {
        const logsDir = path.join(__dirname, '../../logs');
        
        // Check if logs directory exists, if not create it
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        
        const files = fs.readdirSync(logsDir);
        
        const logDates = new Set<string>();
        const logTypes = ['session', 'sql', 'app'];
        
        files.forEach(file => {
            logTypes.forEach(type => {
                const regex = new RegExp(`^${type}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
                const match = file.match(regex);
                if (match) {
                    logDates.add(match[1]);
                }
            });
        });
        
        const sortedDates = Array.from(logDates).sort().reverse(); // Most recent first
        
        res.json({
            dates: sortedDates,
            types: logTypes
        });
    } catch (error) {
        appLogger.error('Error reading log directory:', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
        res.status(500).send({ message: 'Error reading log directory', error });
    }
});

// System health check endpoint
router.get('/health', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    
    // Basic health check available to all authenticated users
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    try {
        const healthData: any = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            environment: process.env.NODE_ENV || 'development'
        };

        // Database connectivity check
        try {
            await db.sequelize.authenticate();
            healthData.database = { status: 'connected' };
        } catch (dbError) {
            healthData.database = { status: 'error', message: (dbError as Error).message };
            healthData.status = 'degraded';
        }

        // Docker connectivity check (via containerService)
        try {
            await containerService.ping();
            healthData.docker = { status: 'connected' };
        } catch (dockerError) {
            healthData.docker = { status: 'error', message: (dockerError as Error).message };
            healthData.status = 'degraded';
        }

        // Admin users get additional statistics
        if (user.role === UserRole.ADMIN) {
            try {
                const [totalInstances, activeInstances, totalUsers] = await Promise.all([
                    db.ViperInstance.count(),
                    db.ViperInstance.count({ where: { status: 'active' } }),
                    db.User.count()
                ]);

                healthData.statistics = {
                    totalInstances,
                    activeInstances,
                    totalUsers,
                    memoryUsage: process.memoryUsage()
                };
            } catch (statsError) {
                healthData.statistics = { error: 'Failed to gather statistics' };
            }
        }

        const httpStatus = healthData.status === 'healthy' ? 200 : 503;
        res.status(httpStatus).json(healthData);

    } catch (error) {
        appLogger.error('Health check failed', {
            eventType: 'Health Check Error',
            userId: user.id,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            status: 'error',
            message: 'Health check failed',
            timestamp: new Date().toISOString()
        });
    }
});

// Instance usage statistics (admin only)
router.get('/statistics', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const permissionCheck = checkUserPermission(user, UserRole.ADMIN);
    
    if (!permissionCheck.authorized) {
        res.status(403).json({ error: permissionCheck.reason });
        return;
    }

    try {
        const [
            totalInstances,
            activeInstances,
            instancesByRole,
            instancesByStatus,
            recentInstances
        ] = await Promise.all([
            db.ViperInstance.count(),
            db.ViperInstance.count({ where: { status: 'active' } }),
            db.sequelize.query(`
                SELECT u.role, COUNT(v.id) as count 
                FROM Users u 
                LEFT JOIN ViperInstances v ON u.id = v.owner 
                GROUP BY u.role
            `, { type: QueryTypes.SELECT }),
            db.sequelize.query(`
                SELECT status, COUNT(*) as count 
                FROM ViperInstances 
                GROUP BY status
            `, { type: QueryTypes.SELECT }),
            db.ViperInstance.findAll({
                limit: 10,
                order: [['createdAt', 'DESC']],
                include: [{
                    model: db.User,
                    as: 'ownerUser',
                    attributes: ['username', 'email', 'role']
                }],
                attributes: ['id', 'uuid', 'status', 'createdAt', 'url']
            })
        ]);

        res.json({
            summary: {
                totalInstances,
                activeInstances,
                inactiveInstances: totalInstances - activeInstances
            },
            byRole: instancesByRole,
            byStatus: instancesByStatus,
            recentInstances: recentInstances.map(instance => ({
                ...instance.toJSON(),
                age: instance.createdAt ? 
                    Math.round((new Date().getTime() - new Date(instance.createdAt).getTime()) / (1000 * 60 * 60)) + ' hours' : 
                    'Unknown'
            })),
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        appLogger.error('Error generating statistics', {
            eventType: 'Statistics Error',
            userId: user!.id,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: 'Error generating statistics',
            message: 'Failed to gather system statistics'
        });
    }
});

// Screenshot upload endpoint - containers can send screenshots (requires statusKey authentication)
router.post('/screenshot/:instanceUUID', async (req: Request, res: Response): Promise<void> => {
    const { instanceUUID } = req.params;
    const { screenshot, timestamp, statusKey } = req.body;

    // Authenticate using statusKey
    const authResult = await authenticateMonitoringRequest(instanceUUID, statusKey);
    if (!authResult.authorized) {
        appLogger.warn('Unauthorized screenshot upload attempt', {
            eventType: 'Unauthorized Screenshot Upload',
            instanceUUID,
            reason: authResult.reason,
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
            timestamp: new Date().toISOString()
        });
        res.status(401).json({ error: 'Unauthorized', message: authResult.reason });
        return;
    }

    const instance = authResult.instance!;

    // Validate screenshot data
    if (!screenshot || typeof screenshot !== 'string') {
        appLogger.warn('Invalid screenshot data provided', {
            eventType: 'Invalid Screenshot Data',
            instanceUUID,
            screenshotType: typeof screenshot,
            timestamp: new Date().toISOString()
        });
        res.status(400).json({ error: 'Invalid screenshot data' });
        return;
    }

    try {
        // Store screenshot in dedicated Screenshot table
        await db.Screenshot.create({
            instanceId: instance.id!,
            instanceUUID,
            screenshotData: screenshot,
            capturedAt: timestamp ? new Date(timestamp) : new Date(),
            receivedAt: new Date()
        });

        // Clean up old screenshots - keep only the latest 10
        const screenshotsToDelete = await db.Screenshot.findAll({
            where: { instanceId: instance.id },
            order: [['createdAt', 'DESC']],
            offset: 10 // Skip the first 10 (most recent)
        });

        if (screenshotsToDelete.length > 0) {
            const idsToDelete = screenshotsToDelete.map(s => s.id!);
            await db.Screenshot.destroy({
                where: { id: idsToDelete }
            });
        }

        // Update instance activity timestamp
        await instance.update({
            lastActivity: new Date(),
            updatedAt: new Date()
        });

        appLogger.info('Authenticated screenshot received and stored', {
            eventType: 'Screenshot Received',
            instanceUUID,
            instanceId: instance.id,
            screenshotSize: screenshot ? screenshot.length : 0,
            timestamp: new Date().toISOString()
        });

        res.json({
            success: true,
            message: 'Screenshot received',
            instanceUUID
        });

    } catch (error) {
        appLogger.error('Error storing screenshot', {
            eventType: 'Screenshot Storage Error',
            instanceUUID,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: 'Error storing screenshot',
            message: 'Failed to process screenshot data'
        });
    }
});

// Activity report endpoint - containers can report user activity (requires statusKey authentication)
router.post('/activity/:instanceUUID', async (req: Request, res: Response): Promise<void> => {
    const { instanceUUID } = req.params;
    const { 
        mouseEvents: rawMouseEvents = 0, 
        keyboardEvents: rawKeyboardEvents = 0, 
        timestamp,
        windowActive = false,
        cpuUsage: rawCpuUsage = 0,
        memoryUsage: rawMemoryUsage = 0,
        statusKey
    } = req.body;

    // Authenticate using statusKey
    const authResult = await authenticateMonitoringRequest(instanceUUID, statusKey);
    if (!authResult.authorized) {
        appLogger.warn('Unauthorized activity report attempt', {
            eventType: 'Unauthorized Activity Report',
            instanceUUID,
            reason: authResult.reason,
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
            timestamp: new Date().toISOString()
        });
        res.status(401).json({ error: 'Unauthorized', message: authResult.reason });
        return;
    }

    const instance = authResult.instance!;

    // Ensure numeric values
    const mouseEvents = Number(rawMouseEvents) || 0;
    const keyboardEvents = Number(rawKeyboardEvents) || 0;
    const cpuUsage = Number(rawCpuUsage) || 0;
    const memoryUsage = Number(rawMemoryUsage) || 0;

    try {
        // Calculate activity score (mouse + keyboard events)
        const activityScore = mouseEvents + keyboardEvents;
        
        // 10-minute timeout logic: user is active if they have interacted in the last 10 minutes
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
        const hasRecentInteraction = activityScore > 0;
        
        let isActive = false;
        let lastInteractionTime = instance.lastActivity || new Date(0); // Default to epoch if null
        
        if (hasRecentInteraction) {
            // User just interacted - they are active and update last interaction time
            isActive = true;
            lastInteractionTime = new Date();
        } else {
            // No current interaction - check if last interaction was within 10 minutes
            isActive = lastInteractionTime > tenMinutesAgo;
        }

        // Store activity in dedicated Activity table
        await db.Activity.create({
            instanceId: instance.id!,
            instanceUUID,
            mouseEvents,
            keyboardEvents,
            windowActive,
            cpuUsage,
            memoryUsage,
            activityScore,
            reportedAt: timestamp ? new Date(timestamp) : new Date(),
            receivedAt: new Date()
        });

        // Clean up old activity records - keep only the latest 100
        const activitiesToDelete = await db.Activity.findAll({
            where: { instanceId: instance.id },
            order: [['createdAt', 'DESC']],
            offset: 100 // Skip the first 100 (most recent)
        });

        if (activitiesToDelete.length > 0) {
            const idsToDelete = activitiesToDelete.map(a => a.id!);
            await db.Activity.destroy({
                where: { id: idsToDelete }
            });
        }

        // Update instance activity summary
        await instance.update({
            lastActivity: hasRecentInteraction ? lastInteractionTime : instance.lastActivity, // Only update if user just interacted
            activityScore: activityScore,
            isUserActive: isActive,
            updatedAt: new Date()
        });

        appLogger.info('Authenticated activity report received', {
            eventType: 'Activity Report Received',
            instanceUUID,
            instanceId: instance.id,
            mouseEvents,
            keyboardEvents,
            windowActive,
            activityScore,
            hasRecentInteraction,
            isActive,
            lastInteractionTime: lastInteractionTime.toISOString(),
            tenMinuteTimeoutActive: !hasRecentInteraction && isActive,
            timestamp: new Date().toISOString()
        });

        res.json({
            success: true,
            message: 'Activity report received',
            instanceUUID,
            activityScore,
            isActive
        });

    } catch (error) {
        appLogger.error('Error storing activity report', {
            eventType: 'Activity Storage Error',
            instanceUUID,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: 'Error storing activity report',
            message: 'Failed to process activity data'
        });
    }
});

// Test endpoint for monitoring script debugging (no auth required)
router.get('/monitoring-test/:instanceUUID', async (req: Request, res: Response): Promise<void> => {
    const { instanceUUID } = req.params;
    
    try {
        const instance = await db.ViperInstance.findOne({
            where: { uuid: instanceUUID }
        });

        if (!instance) {
            res.status(404).json({ 
                error: 'Instance not found',
                instanceUUID,
                message: 'No instance found with this UUID'
            });
            return;
        }

        res.json({
            success: true,
            instanceUUID,
            message: 'Monitoring test endpoint - instance found',
            instance: {
                id: instance.id,
                uuid: instance.uuid,
                status: instance.status,
                lastActivity: instance.lastActivity,
                isUserActive: instance.isUserActive,
                activityScore: instance.activityScore
            },
            endpoints: {
                screenshot: `/service/screenshot/${instanceUUID}`,
                activity: `/service/activity/${instanceUUID}`,
                test: `/service/monitoring-test/${instanceUUID}`
            },
            testCurl: {
                activity: `curl -X POST '${req.protocol}://${req.get('host')}/service/activity/${instanceUUID}' -H 'Content-Type: application/json' -d '{"mouseEvents":1,"keyboardEvents":1,"windowActive":true,"cpuUsage":10,"memoryUsage":20}'`
            }
        });

    } catch (error) {
        res.status(500).json({
            error: 'Database error',
            message: (error as Error).message,
            instanceUUID
        });
    }
});

// Get latest screenshot for an instance (admin only)
router.get('/screenshot/:instanceUUID', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const { instanceUUID } = req.params;

    // Check permissions
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    try {
        const access = await resolveAccessibleInstance(user, instanceUUID);

        if (!access.instance) {
            res.status(access.status!).json({ error: access.error });
            return;
        }

        const instance = access.instance;

        // Get latest screenshot from Screenshot table
        const latestScreenshot = await db.Screenshot.findOne({
            where: { instanceId: instance.id },
            order: [['createdAt', 'DESC']]
        });

        if (!latestScreenshot) {
            res.status(404).json({ error: 'No screenshot available' });
            return;
        }

        res.json({
            success: true,
            screenshot: {
                id: latestScreenshot.id,
                instanceUUID: latestScreenshot.instanceUUID,
                screenshot: latestScreenshot.screenshotData,
                capturedAt: latestScreenshot.capturedAt,
                receivedAt: latestScreenshot.receivedAt
            },
            instanceUUID
        });

    } catch (error) {
        appLogger.error('Error retrieving screenshot', {
            eventType: 'Screenshot Retrieval Error',
            instanceUUID,
            userId: user.id,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: 'Error retrieving screenshot',
            message: 'Failed to get screenshot data'
        });
    }
});

// Get screenshot image data only (returns base64 image for direct use in img src)
router.get('/screenshot-image/:instanceUUID', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const { instanceUUID } = req.params;
    const { index = '0' } = req.query; // Allow specifying which screenshot by index

    // Check permissions
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    try {
        const access = await resolveAccessibleInstance(user, instanceUUID);

        if (!access.instance) {
            res.status(access.status!).json({ error: access.error });
            return;
        }

        const instance = access.instance;

        // Get screenshots from Screenshot table
        const screenshots = await db.Screenshot.findAll({
            where: { instanceId: instance.id },
            order: [['createdAt', 'DESC']],
            limit: 10
        });

        if (!screenshots || screenshots.length === 0) {
            res.status(404).json({ error: 'No screenshots available' });
            return;
        }

        const screenshotIndex = parseInt(index as string) || 0;
        const selectedScreenshot = screenshots[screenshotIndex];

        if (!selectedScreenshot) {
            res.status(404).json({ error: 'Screenshot index out of range' });
            return;
        }

        // Return just the base64 image data with proper content type
        const base64Data = selectedScreenshot.screenshotData;
        if (base64Data) {
            // Set proper headers for image response
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
            
            // Convert base64 to buffer and send
            const imageBuffer = Buffer.from(base64Data, 'base64');
            res.send(imageBuffer);
        } else {
            res.status(404).json({ error: 'Screenshot data not found' });
        }

    } catch (error) {
        appLogger.error('Error retrieving screenshot image', {
            eventType: 'Screenshot Image Retrieval Error',
            instanceUUID,
            userId: user.id,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ error: 'Error retrieving screenshot image' });
    }
});

// Get unique screenshots for carousel (detects duplicates)
router.get('/screenshots/:instanceUUID', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const { instanceUUID } = req.params;

    // Check permissions
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    try {
        const access = await resolveAccessibleInstance(user, instanceUUID);

        if (!access.instance) {
            res.status(access.status!).json({ error: access.error });
            return;
        }

        const instance = access.instance;

        // Get all screenshots from Screenshot table
        const allScreenshots = await db.Screenshot.findAll({
            where: { instanceId: instance.id },
            order: [['createdAt', 'DESC']],
            limit: 10,
            attributes: ['id', 'instanceUUID', 'capturedAt', 'receivedAt', 'screenshotData']
        });

        if (!allScreenshots || allScreenshots.length === 0) {
            res.json({
                success: true,
                screenshots: [],
                uniqueScreenshots: [],
                totalScreenshots: 0,
                uniqueCount: 0
            });
            return;
        }

        // Simple duplicate detection using image size and first few characters
        const uniqueScreenshots = [];
        const seenHashes = new Set();

        for (let i = 0; i < allScreenshots.length; i++) {
            const screenshot = allScreenshots[i];
            const imageData = screenshot.screenshotData;
            if (imageData) {
                // Create a simple hash from image size and first 100 characters
                const simpleHash = `${imageData.length}-${imageData.substring(0, 100)}`;
                
                if (!seenHashes.has(simpleHash)) {
                    seenHashes.add(simpleHash);
                    uniqueScreenshots.push({
                        id: screenshot.id,
                        instanceUUID: screenshot.instanceUUID,
                        capturedAt: screenshot.capturedAt,
                        receivedAt: screenshot.receivedAt,
                        index: i, // Use the actual index in the allScreenshots array
                        uniqueIndex: uniqueScreenshots.length, // Position in unique array
                        isLatest: uniqueScreenshots.length === 0
                    });
                }
            }
        }

        res.json({
            success: true,
            screenshots: allScreenshots.map((s, index) => ({
                id: s.id,
                instanceUUID: s.instanceUUID,
                capturedAt: s.capturedAt,
                receivedAt: s.receivedAt,
                index
            })),
            uniqueScreenshots,
            totalScreenshots: allScreenshots.length,
            uniqueCount: uniqueScreenshots.length,
            instanceUUID
        });

    } catch (error) {
        appLogger.error('Error retrieving screenshots list', {
            eventType: 'Screenshots List Error',
            instanceUUID,
            userId: user.id,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: 'Error retrieving screenshots',
            message: 'Failed to get screenshots data'
        });
    }
});

// Get activity history for an instance
router.get('/activity/:instanceUUID', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const { instanceUUID } = req.params;
    const { limit = '50' } = req.query;

    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    try {
        const access = await resolveAccessibleInstance(user, instanceUUID);

        if (!access.instance) {
            res.status(access.status!).json({ error: access.error });
            return;
        }

        const instance = access.instance;

        // Get activity history from Activity table
        const limitNum = parseInt(limit as string);
        const activityHistory = await db.Activity.findAll({
            where: { instanceId: instance.id },
            order: [['createdAt', 'DESC']],
            limit: limitNum
        });

        // Calculate activity summary
        const totalEvents = activityHistory.reduce((sum: number, activity) => 
            sum + activity.mouseEvents + activity.keyboardEvents, 0);
        
        // Ensure proper number conversion for decimal fields from database
        const avgCpuUsage = activityHistory.length > 0 ? 
            activityHistory.reduce((sum: number, activity) => {
                const cpuValue = parseFloat(activity.cpuUsage as any) || 0;
                return sum + cpuValue;
            }, 0) / activityHistory.length : 0;
        
        const avgMemoryUsage = activityHistory.length > 0 ? 
            activityHistory.reduce((sum: number, activity) => {
                const memoryValue = parseFloat(activity.memoryUsage as any) || 0;
                return sum + memoryValue;
            }, 0) / activityHistory.length : 0;

        res.json({
            success: true,
            instanceUUID,
            activityHistory: activityHistory.map(activity => ({
                id: activity.id,
                mouseEvents: activity.mouseEvents,
                keyboardEvents: activity.keyboardEvents,
                windowActive: activity.windowActive,
                cpuUsage: activity.cpuUsage,
                memoryUsage: activity.memoryUsage,
                activityScore: activity.activityScore,
                reportedAt: activity.reportedAt,
                receivedAt: activity.receivedAt
            })),
            summary: {
                totalEvents,
                avgCpuUsage: Math.round(avgCpuUsage * 100) / 100,
                avgMemoryUsage: Math.round(avgMemoryUsage * 100) / 100,
                lastActivity: instance.lastActivity,
                isUserActive: instance.isUserActive,
                currentScore: instance.activityScore || 0
            }
        });

    } catch (error) {
        appLogger.error('Error retrieving activity history', {
            eventType: 'Activity History Error',
            instanceUUID,
            userId: user.id,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: 'Error retrieving activity history',
            message: 'Failed to get activity data'
        });
    }
});

// Auto-shutdown inactive instances (admin endpoint)
router.post('/cleanup-inactive', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ServiceUser | undefined;
    const permissionCheck = checkUserPermission(user, UserRole.ADMIN);
    
    if (!permissionCheck.authorized) {
        res.status(403).json({ error: permissionCheck.reason });
        return;
    }

    try {
        const inactivityThreshold = 30 * 60 * 1000; // 30 minutes
        const now = new Date();
        const cutoffTime = new Date(now.getTime() - inactivityThreshold);

        // Find instances that are inactive and marked for shutdown
        const inactiveInstances = await db.ViperInstance.findAll({
            where: {
                status: 'inactive_pending_shutdown',
                lastActivity: {
                    [Op.lt]: cutoffTime
                }
            }
        });

        const shutdownResults = [];

        for (const instance of inactiveInstances) {
            try {
                // Stop and remove container
                await containerService.stopContainer(instance.dockerid);
                await containerService.removeContainer(instance.dockerid);
                
                // Update database
                await instance.update({
                    status: 'auto_shutdown',
                    updatedAt: new Date()
                });

                shutdownResults.push({
                    instanceUUID: instance.uuid,
                    containerId: instance.dockerid,
                    success: true
                });

                appLogger.info('Instance auto-shutdown completed', {
                    eventType: 'Auto Shutdown',
                    instanceUUID: instance.uuid,
                    instanceId: instance.id,
                    containerId: instance.dockerid,
                    reason: 'inactivity',
                    timestamp: new Date().toISOString()
                });

            } catch (shutdownError) {
                shutdownResults.push({
                    instanceUUID: instance.uuid,
                    containerId: instance.dockerid,
                    success: false,
                    error: (shutdownError as Error).message
                });

                appLogger.error('Failed to auto-shutdown instance', {
                    eventType: 'Auto Shutdown Error',
                    instanceUUID: instance.uuid,
                    error: (shutdownError as Error).message,
                    timestamp: new Date().toISOString()
                });
            }
        }

        res.json({
            success: true,
            message: 'Inactive instances cleanup completed',
            shutdownCount: shutdownResults.filter(r => r.success).length,
            results: shutdownResults
        });

    } catch (error) {
        appLogger.error('Error during inactive cleanup', {
            eventType: 'Cleanup Error',
            userId: user!.id,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: 'Error during cleanup',
            message: 'Failed to cleanup inactive instances'
        });
    }
});

export default router;