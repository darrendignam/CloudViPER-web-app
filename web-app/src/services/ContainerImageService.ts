import db from '../models';
import { ImageSource, ImageStatus } from '../models/containerimage';
import containerService from './ContainerService';
import { UserRole } from '../types/UserRole';
import { appLogger } from '../config/logger';
import type { ServiceUser } from './ViperInstanceService';

/**
 * The image every deployment falls back to when nothing else is configured.
 * VIPER_IMAGE remains the rung above it, so an installation that never touches
 * the pool behaves exactly as it did before images were manageable.
 */
export const FALLBACK_VIPER_IMAGE = process.env.VIPER_IMAGE
    || 'ghcr.io/darrendignam/opf-cloud-viper:2.0.0-alpha';

/**
 * Images that must never be offered as a ViPER desktop, nor removed through the
 * pool UI.
 *
 * Choosing one of these as a desktop only breaks that instance. Deleting one
 * takes the whole platform down with it, which is the case this list really
 * exists for. Matching is a case-insensitive substring test against the
 * repository, which is blunt on purpose: a pattern that is easy to read and
 * verify beats one that is clever and wrong.
 */
const BUILT_IN_BLOCKLIST = [
    'cloudviper-web-app',
    'viper-cloud-web-gui',
    'mysql',
    'mariadb',
    'nginx-proxy',
    'acme-companion'
];

export function imageBlocklist(): string[] {
    const configured = (process.env.IMAGE_BLOCKLIST || '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);

    return [...BUILT_IN_BLOCKLIST, ...configured];
}

export function isBlockedImage(reference: string): boolean {
    const haystack = String(reference || '').toLowerCase();
    return imageBlocklist().some((pattern) => haystack.includes(pattern));
}

/**
 * Roles allowed to pick an image at launch. Everyone else silently receives
 * whatever their team or the system has been set to use, which is the point of
 * having a default at all.
 */
const ROLES_THAT_MAY_CHOOSE = [UserRole.ADMIN, UserRole.TEAM_ADMIN, UserRole.TEAM_LEADER];

export function mayChooseImage(user: Pick<ServiceUser, 'role'>): boolean {
    return ROLES_THAT_MAY_CHOOSE.includes(user.role);
}

export interface ResolvedImage {
    reference: string;
    imageId: number | null;
    /** Which rung of the chain answered, for the log and for support. */
    origin: 'explicit' | 'team' | 'global' | 'environment';
    /** Extra environment and mounts configured on the pool entry, if any. */
    envVars: Record<string, string>;
    volumes: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>;
}

export class ContainerImageService {
    /**
     * Decide which image an instance should be built from.
     *
     * explicit choice -> team default -> global default -> environment
     *
     * A rung is skipped rather than fatal when it names something unusable: an
     * image that failed to pull, or one that has since been blocklisted, must
     * not stop a user launching a desktop. An explicit choice is the exception,
     * because silently giving someone a different image than the one they
     * picked is worse than telling them no.
     */
    async resolveImageForUser(user: ServiceUser, requestedImageId?: number | null): Promise<ResolvedImage> {
        if (requestedImageId) {
            const chosen = await this.requireLaunchableImage(requestedImageId, user);
            return { reference: chosen.reference, imageId: chosen.id!, origin: 'explicit', envVars: chosen.envVars || {}, volumes: chosen.volumes || [] };
        }

        const teamDefault = await this.teamDefaultImage(user);
        if (teamDefault) {
            return { reference: teamDefault.reference, imageId: teamDefault.id!, origin: 'team', envVars: teamDefault.envVars || {}, volumes: teamDefault.volumes || [] };
        }

        const globalDefault = await this.globalDefaultImage();
        if (globalDefault) {
            return { reference: globalDefault.reference, imageId: globalDefault.id!, origin: 'global', envVars: globalDefault.envVars || {}, volumes: globalDefault.volumes || [] };
        }

        // The environment fallback is not a pool entry, so there is nothing
        // configured against it.
        return { reference: FALLBACK_VIPER_IMAGE, imageId: null, origin: 'environment', envVars: {}, volumes: [] };
    }

    /**
     * Fetch an explicitly requested image, refusing anything the caller may not
     * have or that cannot be launched.
     */
    private async requireLaunchableImage(imageId: number, user: ServiceUser): Promise<any> {
        if (!mayChooseImage(user)) {
            throw new Error('Your role cannot choose an instance image');
        }

        const image = await db.ContainerImage.findByPk(imageId);

        if (!image) {
            throw new Error('The requested image does not exist');
        }

        if (image.status !== ImageStatus.AVAILABLE) {
            throw new Error(`The requested image is not ready to launch (status: ${image.status})`);
        }

        if (isBlockedImage(image.reference)) {
            throw new Error('The requested image is blocked from use as a desktop');
        }

        return image;
    }

    async teamDefaultImage(user: ServiceUser): Promise<any | null> {
        if (!user.teamId) {
            return null;
        }

        const team = await db.Team.findByPk(user.teamId);

        if (!team?.defaultImageId) {
            return null;
        }

        return this.usableImageOrNull(team.defaultImageId, 'team default');
    }

    async globalDefaultImage(): Promise<any | null> {
        const image = await db.ContainerImage.findOne({ where: { isGlobalDefault: true } });

        if (!image) {
            return null;
        }

        return this.usableImageOrNull(image.id!, 'global default');
    }

    private async usableImageOrNull(imageId: number, describedAs: string): Promise<any | null> {
        const image = await db.ContainerImage.findByPk(imageId);

        if (!image || image.status !== ImageStatus.AVAILABLE || isBlockedImage(image.reference)) {
            appLogger.warn('Configured default image is not usable, falling through', {
                eventType: 'Image Default Unusable',
                describedAs,
                imageId,
                status: image?.status ?? 'missing',
                timestamp: new Date().toISOString()
            });
            return null;
        }

        return image;
    }

    /**
     * Promote one image to the system default, demoting whatever held it.
     * Two rows claiming to be the default is a state nothing downstream could
     * resolve, so this is the only supported way to set it.
     */
    async setGlobalDefault(imageId: number): Promise<any> {
        const image = await db.ContainerImage.findByPk(imageId);

        if (!image) {
            throw new Error('The requested image does not exist');
        }

        if (image.status !== ImageStatus.AVAILABLE) {
            throw new Error(`Cannot make an image the default before it is available (status: ${image.status})`);
        }

        if (isBlockedImage(image.reference)) {
            throw new Error('That image is blocked from use as a desktop');
        }

        await db.ContainerImage.update({ isGlobalDefault: false }, { where: { isGlobalDefault: true } });
        await image.update({ isGlobalDefault: true });

        appLogger.info('Global default image set', {
            eventType: 'Image Global Default Set',
            imageId,
            reference: image.reference,
            timestamp: new Date().toISOString()
        });

        return image;
    }

    async setTeamDefault(teamId: number, imageId: number | null): Promise<any> {
        const team = await db.Team.findByPk(teamId);

        if (!team) {
            throw new Error('The requested team does not exist');
        }

        if (imageId === null) {
            await team.update({ defaultImageId: null });
            return team;
        }

        const image = await db.ContainerImage.findByPk(imageId);

        if (!image) {
            throw new Error('The requested image does not exist');
        }

        if (image.status !== ImageStatus.AVAILABLE) {
            throw new Error(`Cannot make an image the default before it is available (status: ${image.status})`);
        }

        if (isBlockedImage(image.reference)) {
            throw new Error('That image is blocked from use as a desktop');
        }

        await team.update({ defaultImageId: imageId });

        appLogger.info('Team default image set', {
            eventType: 'Image Team Default Set',
            teamId,
            imageId,
            reference: image.reference,
            timestamp: new Date().toISOString()
        });

        return team;
    }

    /**
     * Register a reference and pull it in the background.
     *
     * The row is created immediately as PENDING and returned, because a ViPER
     * image is gigabytes and an HTTP request cannot be held open for it. The
     * caller polls the row; the pull moves it to AVAILABLE or FAILED.
     */
    async addImageFromRegistry(input: {
        reference: string;
        name: string;
        description?: string | null;
        createdById?: number | null;
        metadata?: Record<string, any> | null;
    }): Promise<any> {
        const reference = String(input.reference || '').trim();

        if (!isValidReference(reference)) {
            throw new Error('That does not look like a container image reference');
        }

        if (isBlockedImage(reference)) {
            throw new Error('That image is blocked from use as a desktop');
        }

        const existing = await db.ContainerImage.findOne({ where: { reference } });
        if (existing) {
            throw new Error('That image is already in the pool');
        }

        const image = await db.ContainerImage.create({
            reference,
            name: String(input.name || reference).trim(),
            description: input.description ?? null,
            source: ImageSource.REGISTRY,
            status: ImageStatus.PENDING,
            createdById: input.createdById ?? null,
            metadata: input.metadata ?? {}
        });

        // Not awaited: the pull outlives the request that started it. Failures
        // are recorded on the row, which is the only place the caller looks.
        void this.performPull(image);

        return image;
    }

    /**
     * Carry out the pull and record the outcome on the row.
     * Never throws: nothing is waiting on it, so an escaping rejection would
     * only become an unhandled one.
     */
    async performPull(image: any): Promise<void> {
        try {
            await containerService.pullImage(image.reference);
            const details = await containerService.inspectImage(image.reference);

            await image.update({
                status: ImageStatus.AVAILABLE,
                statusMessage: null,
                digest: details?.Id ?? null,
                sizeBytes: details?.Size ?? null
            });

            appLogger.info('Pool image is ready', {
                eventType: 'Image Available',
                imageId: image.id,
                reference: image.reference,
                sizeBytes: details?.Size ?? null,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            const message = (error as Error).message;

            await image.update({ status: ImageStatus.FAILED, statusMessage: message });

            appLogger.error('Pool image pull failed', {
                eventType: 'Image Pull Failed',
                imageId: image.id,
                reference: image.reference,
                error: message,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Remove an image from the pool, and from the host unless something else
     * still needs it.
     *
     * A commit-built image exists nowhere but this appliance, so deleting one
     * destroys it. That is the caller's decision to make, but it must be made
     * knowingly, which is what `force` represents.
     */
    async removeImage(imageId: number, options: { force?: boolean } = {}): Promise<void> {
        const image = await db.ContainerImage.findByPk(imageId);

        if (!image) {
            throw new Error('The requested image does not exist');
        }

        if (isBlockedImage(image.reference)) {
            throw new Error('That image underpins the platform and cannot be removed here');
        }

        if (image.isGlobalDefault) {
            throw new Error('Set a different global default before removing this image');
        }

        const dependentTeams = await db.Team.count({ where: { defaultImageId: imageId } });
        if (dependentTeams > 0) {
            throw new Error(`${dependentTeams} team(s) still use this image as their default`);
        }

        if (!image.isRecoverableAfterDeletion() && !options.force) {
            throw new Error('This image was built here and exists nowhere else. Confirm to delete it permanently');
        }

        await image.destroy();

        try {
            await containerService.removeImage(image.reference);
        } catch (error) {
            // The row is gone either way. A layer still in use by a running
            // container is Docker's business, not a reason to resurrect a pool
            // entry the operator asked to remove.
            appLogger.warn('Pool entry removed but the image is still on the host', {
                eventType: 'Image Host Removal Failed',
                imageId,
                reference: image.reference,
                error: (error as Error).message,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Images present on the host that are not already pooled, for the "add from
     * this appliance" screen. Blocked entries never appear: this is the list
     * from which someone chooses what to delete as well as what to add.
     */
    async hostImagesAvailableToAdd(): Promise<any[]> {
        return (await this.hostImages()).filter((entry: any) => !entry.inPool && !entry.blocked);
    }

    /**
     * Everything on the host, annotated with why it can or cannot be acted on.
     *
     * Shows blocked and in-use images rather than hiding them, because an
     * administrator looking at disk usage needs to see what is occupying it. The
     * flags say what may be done; filtering them out would only make the same
     * images look like they had vanished.
     */
    async hostImages(): Promise<any[]> {
        const [onHost, pooled, running] = await Promise.all([
            containerService.listImages(),
            db.ContainerImage.findAll({ attributes: ['reference'] }),
            containerService.listContainers({ all: true }).catch(() => [])
        ]);

        const alreadyPooled = new Set(pooled.map((entry: any) => entry.reference));
        // An image backing any container, running or stopped, cannot be removed
        // by Docker, so saying so up front beats a daemon error after the click.
        const inUse = new Set((running || []).map((container: any) => container.Image));

        return onHost
            .flatMap((entry: any) => (entry.RepoTags || []).map((tag: string) => ({
                reference: tag,
                sizeBytes: entry.Size,
                createdAt: entry.Created ? new Date(entry.Created * 1000) : null,
                inPool: alreadyPooled.has(tag),
                blocked: isBlockedImage(tag),
                inUse: inUse.has(tag)
            })))
            .filter((entry: any) => entry.reference !== '<none>:<none>')
            .sort((a: any, b: any) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    }

    /**
     * Delete an image from the host that is not in the pool.
     *
     * Pool entries go through removeImage instead, which has its own guards
     * about defaults and teams. This is for the rest: base images, old
     * releases, anything occupying disk.
     *
     * Refusing rather than forcing is deliberate. A ViPER image is around ten
     * gigabytes and pulling it again is minutes, so a deletion that is merely
     * inconvenient at the wrong moment is worth making hard to do by accident.
     */
    async removeHostImage(reference: string): Promise<void> {
        const target = (await this.hostImages()).find((entry: any) => entry.reference === reference);

        if (!target) {
            throw new Error('That image is not on this host');
        }

        if (target.blocked) {
            throw new Error('That image underpins the platform and cannot be removed here');
        }

        if (target.inPool) {
            throw new Error('That image is in the pool. Remove the pool entry instead, which checks whether anything still depends on it');
        }

        if (target.inUse) {
            throw new Error('A container is still using that image. Remove the container first');
        }

        await containerService.removeImage(reference);

        appLogger.warn('Host image deleted', {
            eventType: 'Host Image Deleted',
            reference,
            sizeBytes: target.sizeBytes,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Turn a running build instance into a pool image.
     *
     * Three things have to happen and the order matters:
     *
     * 1. Promote, optionally. Anything meant to reach every user has to move
     *    from /config, which is one person's home directory, into /defaults,
     *    which the image seeds every new /config from.
     * 2. Reset /config. A committed image otherwise carries the builder's
     *    files, shell history and browser session to everyone who launches it.
     *    This also resets the desktop of the instance being committed, which is
     *    why build instances are disposable by design.
     * 3. Commit, neutralising SELKIES_MASTER_TOKEN.
     *
     * Step 3 is not optional. `docker commit` captures the container's
     * environment, and the environment holds the token that mints desktop
     * access through the control plane. It cannot be stripped by supplying a
     * filtered Env, because the daemon merges the container's own environment
     * back over anything supplied; a `changes` directive is what actually
     * replaces the value.
     */
    async commitInstanceToImage(instance: any, options: {
        name: string;
        tag?: string;
        description?: string | null;
        promoteDesktop?: boolean;
        createdById?: number | null;
        metadata?: Record<string, any> | null;
    }): Promise<any> {
        if (!instance?.dockerid) {
            throw new Error('That instance has no container to commit');
        }

        const repository = toRepositoryName(options.name);
        const tag = (options.tag || 'latest').trim();
        const reference = `${repository}:${tag}`;

        if (!isValidReference(reference)) {
            throw new Error('That name and tag do not make a usable image reference');
        }

        if (isBlockedImage(reference)) {
            throw new Error('That name collides with an image the platform depends on');
        }

        if (await db.ContainerImage.findOne({ where: { reference } })) {
            throw new Error('An image with that name and tag is already in the pool');
        }

        if (options.promoteDesktop) {
            await this.promoteDesktopToDefaults(instance.dockerid);
        }

        await this.resetConfigDirectory(instance.dockerid);

        await containerService.commitContainer(instance.dockerid, {
            repo: repository,
            tag,
            comment: `CloudViPER image from instance ${instance.uuid}`,
            pause: true,
            // A string, not an array: dockerode JSON-encodes an array into the
            // query and the daemon rejects it with "ENV is not a valid change
            // command".
            changes: `ENV SELKIES_MASTER_TOKEN=${NEUTRALISED_TOKEN_VALUE}`
        });

        const details = await containerService.inspectImage(reference);

        const image = await db.ContainerImage.create({
            reference,
            name: String(options.name).trim(),
            description: options.description ?? null,
            source: ImageSource.COMMIT,
            status: ImageStatus.AVAILABLE,
            digest: details?.Id ?? null,
            sizeBytes: details?.Size ?? null,
            createdById: options.createdById ?? null,
            builtFromInstanceId: instance.id ?? null,
            metadata: {
                ...(options.metadata || {}),
                builtFromImage: instance.imageReference ?? null,
                builtAt: new Date().toISOString(),
                desktopPromoted: options.promoteDesktop === true
            }
        });

        appLogger.info('Instance committed to a pool image', {
            eventType: 'Image Committed',
            imageId: image.id,
            reference,
            instanceUUID: instance.uuid,
            promoted: options.promoteDesktop === true,
            timestamp: new Date().toISOString()
        });

        return image;
    }

    /**
     * Copy the builder's desktop configuration into the image defaults.
     *
     * These are exactly the files the image's own init seeds a fresh /config
     * from, so promoting them is what makes a customised desktop reach every
     * user rather than dying with the /config reset that follows.
     */
    private async promoteDesktopToDefaults(containerId: string): Promise<void> {
        for (const { from, to } of PROMOTABLE_DESKTOP_FILES) {
            // Absent files are normal: a builder who changed the menu but not
            // autostart should not have the save fail over the one they left
            // alone.
            const { exitCode } = await containerService.execInContainer(containerId, [
                'bash', '-lc', `[ -f "${from}" ] && cp -f "${from}" "${to}" || true`
            ]);

            if (exitCode !== 0) {
                throw new Error(`Could not promote ${from} into the image defaults`);
            }
        }

        appLogger.info('Desktop configuration promoted to image defaults', {
            eventType: 'Image Desktop Promoted',
            containerId,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Empty the builder's home directory, dotfiles included, leaving the
     * directory itself in place with its ownership intact.
     */
    private async resetConfigDirectory(containerId: string): Promise<void> {
        // Mount points are skipped rather than deleted. An image's shared
        // folders are bind-mounted read-only under /config, so a plain
        // recursive delete fails with "Device or resource busy" and takes the
        // whole commit with it. A bind mount's contents come from the host and
        // are never part of the image anyway, so leaving the empty directory is
        // both the only option and the correct one.
        const { exitCode, output } = await containerService.execInContainer(containerId, [
            'bash', '-lc',
            'status=0; ' +
            'for entry in /config/* /config/.[!.]* /config/..?*; do ' +
            '  [ -e "$entry" ] || continue; ' +
            '  if mountpoint -q "$entry" 2>/dev/null || grep -qF " ${entry} " /proc/mounts; then continue; fi; ' +
            '  rm -rf "$entry" || status=1; ' +
            'done; ' +
            'chown abc:abc /config || status=1; ' +
            'exit $status'
        ]);

        if (exitCode !== 0) {
            throw new Error(`Could not reset /config before committing: ${output.trim()}`);
        }

        appLogger.info('Reset /config before commit', {
            eventType: 'Image Config Reset',
            containerId,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Images a caller may pick from. The pool is the allowlist: nothing reaches
     * a launch screen that an administrator did not deliberately add.
     */
    async launchableImages(): Promise<any[]> {
        const images = await db.ContainerImage.findAll({
            where: { status: ImageStatus.AVAILABLE },
            order: [['name', 'ASC']]
        });

        return images.filter((image: any) => !isBlockedImage(image.reference));
    }
}

/**
 * A registry reference: an optional host, a repository path, and an optional
 * tag or digest. Deliberately permissive about hosts, since an operator may run
 * their own registry, and deliberately strict about shell metacharacters, which
 * have no business in a reference and every business in an injection attempt.
 */
const REFERENCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*(\/[a-zA-Z0-9._-]+)*(:[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})?$/;

/**
 * What SELKIES_MASTER_TOKEN is set to in a committed image. Not empty: an empty
 * master token risks Selkies deciding it is unset and starting without secure
 * mode, which would be a worse outcome than a stale one. CloudViPER passes a
 * fresh token on every launch, so nothing ever runs with this value.
 */
export const NEUTRALISED_TOKEN_VALUE = 'neutralised-by-cloudviper';

/**
 * The files the image's init seeds a new /config from. Promoting means writing
 * the builder's version back over these, so the mapping has to mirror the init
 * script exactly or a promoted desktop silently fails to appear.
 */
const PROMOTABLE_DESKTOP_FILES = [
    { from: '/config/.config/openbox/autostart', to: '/defaults/autostart' },
    { from: '/config/.config/openbox/menu.xml', to: '/defaults/menu.xml' },
    { from: '/config/.config/labwc/autostart', to: '/defaults/autostart_wayland' },
    { from: '/config/.config/labwc/menu.xml', to: '/defaults/menu_wayland.xml' },
    { from: '/config/.config/labwc/rc.xml', to: '/defaults/labwc.xml' }
];

/** Docker repository names are lowercase and a limited alphabet. */
export function toRepositoryName(name: string): string {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-._]+|[-._]+$/g, '');
}

export function isValidReference(reference: string): boolean {
    const trimmed = String(reference || '').trim();
    return trimmed.length > 0 && trimmed.length <= 255 && REFERENCE_PATTERN.test(trimmed);
}

const containerImageService = new ContainerImageService();
export default containerImageService;
