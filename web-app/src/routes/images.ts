import express, { Request, Response } from 'express';
import { Op } from 'sequelize';
import db from '../models';
import { appLogger } from '../config/logger';
import { UserRole } from '../types/UserRole';
import containerImageService, { mayChooseImage } from '../services/ContainerImageService';
import {
    validateEnvVars,
    validateVolumes,
    listShareableDirectories,
    INSTANCE_VOLUME_ROOT
} from '../services/InstanceCustomisation';

const router = express.Router();

interface ImageUser {
    id: number;
    username: string;
    email: string;
    role: UserRole;
    teamId?: number | null;
}

/**
 * Adding a reference makes this appliance pull and later run code from wherever
 * that reference points, so it is a system-admin power and nothing narrower.
 */
function requireAdmin(req: Request, res: Response): ImageUser | null {
    const user = req.user as ImageUser | undefined;

    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }

    if (user.role !== UserRole.ADMIN) {
        res.status(403).json({ error: 'Only system administrators can manage the image pool' });
        return null;
    }

    return user;
}

function requireImageChooser(req: Request, res: Response): ImageUser | null {
    const user = req.user as ImageUser | undefined;

    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }

    if (!mayChooseImage(user)) {
        res.status(403).json({ error: 'Your role cannot choose an instance image' });
        return null;
    }

    return user;
}

/** Rows reach the browser without the internals nobody outside needs. */
function imageToJson(image: any) {
    return {
        id: image.id,
        reference: image.reference,
        name: image.name,
        description: image.description,
        source: image.source,
        status: image.status,
        statusMessage: image.statusMessage,
        sizeBytes: image.sizeBytes === null || image.sizeBytes === undefined ? null : Number(image.sizeBytes),
        isGlobalDefault: Boolean(image.isGlobalDefault),
        builtFromInstanceId: image.builtFromInstanceId,
        metadata: image.metadata || {},
        envVars: image.envVars || {},
        volumes: image.volumes || [],
        createdAt: image.createdAt
    };
}

router.get('/', (req: Request, res: Response) => {
    const user = req.user as ImageUser | undefined;

    if (!user || !mayChooseImage(user)) {
        res.status(403).json({ error: 'Unauthorized' });
        return;
    }

    res.render('images_index', {
        user: { id: user.id, email: user.email, role: user.role, teamId: user.teamId ?? null }
    });
});

router.get('/api/pool', async (req: Request, res: Response): Promise<void> => {
    if (!requireImageChooser(req, res)) return;

    try {
        const images = await db.ContainerImage.findAll({ order: [['createdAt', 'DESC']] });
        res.json(images.map(imageToJson));
    } catch (error) {
        appLogger.error('Could not list the image pool', {
            eventType: 'Image Pool List Error',
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        res.status(500).json({ error: 'Could not list the image pool' });
    }
});

/** Images a launch screen may offer: available, pooled and not blocked. */
router.get('/api/launchable', async (req: Request, res: Response): Promise<void> => {
    if (!requireImageChooser(req, res)) return;

    try {
        const images = await containerImageService.launchableImages();
        res.json(images.map(imageToJson));
    } catch (error) {
        res.status(500).json({ error: 'Could not list launchable images' });
    }
});

/**
 * Everything on the host, annotated. Blocked and in-use images are included
 * rather than hidden, because this is also where an administrator goes to see
 * what is occupying disk, and an image that cannot be deleted still occupies it.
 */
router.get('/api/host', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;

    try {
        res.json(await containerImageService.hostImages());
    } catch (error) {
        appLogger.error('Could not list host images', {
            eventType: 'Host Image List Error',
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        res.status(500).json({ error: 'Could not reach Docker to list images on this host' });
    }
});

router.post('/api/pool', async (req: Request, res: Response): Promise<void> => {
    const user = requireAdmin(req, res);
    if (!user) return;

    try {
        const image = await containerImageService.addImageFromRegistry({
            reference: req.body.reference,
            name: req.body.name,
            description: req.body.description,
            createdById: user.id,
            metadata: req.body.metadata
        });

        appLogger.info('Image added to the pool', {
            eventType: 'Image Pool Add',
            imageId: image.id,
            reference: image.reference,
            userId: user.id,
            timestamp: new Date().toISOString()
        });

        // 202: the row exists, the bytes do not yet. The client polls the row.
        res.status(202).json(imageToJson(image));
    } catch (error) {
        res.status(400).json({ error: (error as Error).message });
    }
});

router.post('/api/pool/:imageId/default', async (req: Request, res: Response): Promise<void> => {
    const user = requireAdmin(req, res);
    if (!user) return;

    try {
        const image = await containerImageService.setGlobalDefault(Number(req.params.imageId));
        res.json(imageToJson(image));
    } catch (error) {
        res.status(400).json({ error: (error as Error).message });
    }
});

router.delete('/api/pool/:imageId', async (req: Request, res: Response): Promise<void> => {
    const user = requireAdmin(req, res);
    if (!user) return;

    try {
        await containerImageService.removeImage(Number(req.params.imageId), {
            force: req.body?.force === true
        });

        appLogger.warn('Image removed from the pool', {
            eventType: 'Image Pool Remove',
            imageId: req.params.imageId,
            userId: user.id,
            timestamp: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: (error as Error).message });
    }
});

/**
 * Set the default image for a team.
 *
 * A team admin may set their own team's default and no one else's, which is the
 * whole reason this is not simply admin-gated.
 */
router.put('/api/team/:teamId/default', async (req: Request, res: Response): Promise<void> => {
    const user = req.user as ImageUser | undefined;
    const teamId = Number(req.params.teamId);

    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    const isOwnTeamAdmin = user.role === UserRole.TEAM_ADMIN && user.teamId === teamId;

    if (user.role !== UserRole.ADMIN && !isOwnTeamAdmin) {
        res.status(403).json({ error: 'You can only set the default image for your own team' });
        return;
    }

    try {
        const imageId = req.body.imageId === null || req.body.imageId === undefined
            ? null
            : Number(req.body.imageId);

        const team = await containerImageService.setTeamDefault(teamId, imageId);

        res.json({ id: team.id, name: team.name, defaultImageId: team.defaultImageId });
    } catch (error) {
        res.status(400).json({ error: (error as Error).message });
    }
});

/**
 * Commit a build instance to a new pool image.
 *
 * System admins only, and only an instance created in build mode: those are the
 * ones that kept sudo, so those are the ones anyone had the means to customise.
 */
router.post('/api/commit/:instanceUUID', async (req: Request, res: Response): Promise<void> => {
    const user = requireAdmin(req, res);
    if (!user) return;

    const { instanceUUID } = req.params;

    try {
        const instance = await db.ViperInstance.findOne({ where: { uuid: instanceUUID } });

        if (!instance) {
            res.status(404).json({ error: 'That instance does not exist' });
            return;
        }

        if (!instance.isBuildInstance) {
            res.status(400).json({
                error: 'Only a build instance can be committed. Ordinary instances are hardened and are not customisable'
            });
            return;
        }

        if (!req.body?.name) {
            res.status(400).json({ error: 'A name is required' });
            return;
        }

        const image = await containerImageService.commitInstanceToImage(instance, {
            name: req.body.name,
            tag: req.body.tag,
            description: req.body.description,
            promoteDesktop: req.body.promoteDesktop === true,
            createdById: user.id,
            metadata: req.body.metadata
        });

        appLogger.info('Build instance committed', {
            eventType: 'Image Commit',
            instanceUUID,
            imageId: image.id,
            userId: user.id,
            timestamp: new Date().toISOString()
        });

        res.status(201).json(imageToJson(image));
    } catch (error) {
        appLogger.error('Could not commit the build instance', {
            eventType: 'Image Commit Error',
            instanceUUID,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        res.status(400).json({ error: (error as Error).message });
    }
});

/** Build instances an admin could commit, for the save screen. */
router.get('/api/build-instances', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;

    try {
        const instances = await db.ViperInstance.findAll({
            where: { isBuildInstance: true, status: { [Op.ne]: 'deleted' } },
            attributes: ['id', 'uuid', 'name', 'status', 'imageReference', 'createdAt'],
            order: [['createdAt', 'DESC']]
        });

        res.json(instances);
    } catch (error) {
        res.status(500).json({ error: 'Could not list build instances' });
    }
});

/**
 * Delete an image from the host that is not in the pool.
 *
 * Pool entries go through the pool route instead, which checks defaults and
 * team dependencies first. The service refuses anything blocked, pooled or
 * backing a container, so the failure arrives as a sentence rather than a
 * daemon error.
 */
router.delete('/api/host', async (req: Request, res: Response): Promise<void> => {
    const user = requireAdmin(req, res);
    if (!user) return;

    const reference = String(req.body?.reference || '').trim();

    if (!reference) {
        res.status(400).json({ error: 'A reference is required' });
        return;
    }

    try {
        await containerImageService.removeHostImage(reference);

        appLogger.warn('Host image deleted by an administrator', {
            eventType: 'Host Image Delete',
            reference,
            userId: user.id,
            timestamp: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: (error as Error).message });
    }
});

/**
 * Directories the appliance has been given to share.
 *
 * The interface offers these rather than a free-text path box, because typing a
 * path is how somebody mounts the database directory by accident. In a
 * self-hosted deployment this is where a mounted network share appears: mount
 * it on the host under the shared root and it shows up here.
 */
router.get('/api/shares', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;

    res.json({ root: INSTANCE_VOLUME_ROOT, directories: listShareableDirectories() });
});

/**
 * Configure the environment and mounts applied to every instance of one image.
 *
 * System admins only. Both halves are host access under a friendly name, so
 * neither is a team-level decision.
 */
router.put('/api/pool/:imageId/customisation', async (req: Request, res: Response): Promise<void> => {
    const user = requireAdmin(req, res);
    if (!user) return;

    try {
        const image = await db.ContainerImage.findByPk(Number(req.params.imageId));

        if (!image) {
            res.status(404).json({ error: 'That image is not in the pool' });
            return;
        }

        // Validated before it is stored and again at launch. Storing something
        // invalid would turn a mistake here into a failure much later, at the
        // moment somebody is trying to start a desktop.
        const envVars = validateEnvVars(req.body?.envVars);
        const volumes = validateVolumes(req.body?.volumes);

        await image.update({ envVars, volumes });

        appLogger.info('Image customisation updated', {
            eventType: 'Image Customisation Updated',
            imageId: image.id,
            reference: image.reference,
            envVarNames: Object.keys(envVars),
            mounts: volumes.map((mount) => `${mount.hostPath} -> ${mount.containerPath}${mount.readOnly ? ' (ro)' : ' (rw)'}`),
            userId: user.id,
            timestamp: new Date().toISOString()
        });

        res.json(imageToJson(image));
    } catch (error) {
        res.status(400).json({ error: (error as Error).message });
    }
});

export default router;
