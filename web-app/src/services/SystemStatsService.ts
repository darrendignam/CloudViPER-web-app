import fs from 'fs';
import db from '../models';
import { CLOUDVIPER_INSTANCE_LABEL } from './ViperInstanceService';
import containerService from './ContainerService';
import { appLogger } from '../config/logger';

/**
 * Host and per-instance telemetry for the admin dashboard.
 *
 * Two different questions, deliberately answered together: host figures say
 * whether the machine is about to fall over, per-instance figures say which
 * desktop is doing it. Either alone leaves an administrator guessing.
 */

/**
 * A bind mount from the host, so statvfs through it reports the host
 * filesystem rather than the container's own overlay, which would show the
 * image size and nothing useful about free space.
 */
const HOST_MOUNT_PATH = process.env.HOST_DISK_PROBE_PATH || '/usr/src/app/logs';

export interface HostStats {
    cpuCount: number;
    loadAverage: number[];
    /** Load relative to core count: 100% means as many runnable tasks as cores. */
    loadPercent: number | null;
    memory: { totalBytes: number; availableBytes: number; usedBytes: number; usedPercent: number } | null;
    disk: { totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number } | null;
    containers: { total: number; running: number } | null;
}

export interface InstanceStats {
    name: string;
    uuid: string | null;
    /** What a termination request needs, so the panel can act on what it shows. */
    dockerId: string;
    cpuPercent: number | null;
    memoryBytes: number | null;
    memoryPercent: number | null;
    /**
     * Who to go and talk to.
     *
     * A runaway desktop is a person having a bad time, and "viper-cloud-xpi04"
     * does not tell an administrator which person. Null when the container has
     * no row, which happens for a few seconds around creation and teardown.
     */
    owner: { id: number; username: string; email: string; displayName: string } | null;
}

export interface SystemStats {
    host: HostStats;
    instances: InstanceStats[];
    capturedAt: string;
}

/**
 * Read a size from /proc/meminfo, which is reported in kB.
 *
 * The container sees the host's meminfo, so these are host figures. MemAvailable
 * is used rather than MemFree because free memory on a busy host is nearly
 * always small and nearly always meaningless: the kernel spends it on cache it
 * will hand back on demand.
 */
function readMemInfo(): HostStats['memory'] {
    try {
        const raw = fs.readFileSync('/proc/meminfo', 'utf8');
        const field = (name: string): number | null => {
            const match = raw.match(new RegExp('^' + name + ':\\s+(\\d+) kB', 'm'));
            return match ? Number(match[1]) * 1024 : null;
        };

        const totalBytes = field('MemTotal');
        const availableBytes = field('MemAvailable');

        if (totalBytes === null || availableBytes === null || totalBytes === 0) {
            return null;
        }

        const usedBytes = totalBytes - availableBytes;
        return {
            totalBytes,
            availableBytes,
            usedBytes,
            usedPercent: Number(((usedBytes / totalBytes) * 100).toFixed(1))
        };
    } catch {
        return null;
    }
}

function readDisk(): HostStats['disk'] {
    try {
        const stats = fs.statfsSync(HOST_MOUNT_PATH);
        const totalBytes = stats.blocks * stats.bsize;
        // bavail, not bfree: the difference is the reserve only root may use,
        // which is not space anybody can actually fill.
        const freeBytes = stats.bavail * stats.bsize;

        if (!totalBytes) {
            return null;
        }

        const usedBytes = totalBytes - freeBytes;
        return {
            totalBytes,
            freeBytes,
            usedBytes,
            usedPercent: Number(((usedBytes / totalBytes) * 100).toFixed(1))
        };
    } catch {
        return null;
    }
}

/**
 * Turn one Docker stats sample into a CPU percentage.
 *
 * Docker reports cumulative counters, never a percentage, so the figure only
 * exists as a delta between two samples. A stream:false read carries the
 * previous sample in precpu_stats, which is what makes this possible from a
 * single call; on a container's very first sample there is no previous reading
 * and the honest answer is null rather than zero.
 */
export function cpuPercentFromSample(sample: any, cpuCount: number): number | null {
    const cpu = sample?.cpu_stats;
    const previous = sample?.precpu_stats;

    if (!cpu?.cpu_usage || !previous?.cpu_usage || previous.system_cpu_usage === undefined) {
        return null;
    }

    const cpuDelta = cpu.cpu_usage.total_usage - previous.cpu_usage.total_usage;
    const systemDelta = cpu.system_cpu_usage - previous.system_cpu_usage;

    if (systemDelta <= 0 || cpuDelta < 0) {
        return null;
    }

    const cores = cpu.online_cpus || cpuCount || 1;
    return Number(((cpuDelta / systemDelta) * cores * 100).toFixed(1));
}

export class SystemStatsService {
    async hostStats(): Promise<HostStats> {
        let cpuCount = 0;
        let containers: HostStats['containers'] = null;

        try {
            const info = await containerService.info();
            cpuCount = info?.NCPU || 0;
            containers = { total: info?.Containers ?? 0, running: info?.ContainersRunning ?? 0 };
        } catch (error) {
            appLogger.warn('Could not read Docker host info', {
                eventType: 'Host Stats Docker Unavailable',
                error: (error as Error).message,
                timestamp: new Date().toISOString()
            });
        }

        const loadAverage = (() => {
            try {
                return fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/).slice(0, 3).map(Number);
            } catch {
                return [];
            }
        })();

        return {
            cpuCount,
            loadAverage,
            loadPercent: loadAverage.length && cpuCount
                ? Number(((loadAverage[0] / cpuCount) * 100).toFixed(1))
                : null,
            memory: readMemInfo(),
            disk: readDisk(),
            containers
        };
    }

    /**
     * Per-instance figures, for containers this service created.
     *
     * Scoped by the ownership label rather than by name, so the platform's own
     * containers never appear here: an administrator looking for a runaway
     * desktop should not have to pick it out of a list containing the database.
     */
    async instanceStats(cpuCount: number): Promise<InstanceStats[]> {
        let running: any[] = [];

        try {
            running = await containerService.listContainers({
                filters: { label: [CLOUDVIPER_INSTANCE_LABEL] }
            });
        } catch (error) {
            appLogger.warn('Could not list instance containers for stats', {
                eventType: 'Instance Stats Unavailable',
                error: (error as Error).message,
                timestamp: new Date().toISOString()
            });
            return [];
        }

        // In parallel: a stats call takes a moment each, and a host with several
        // desktops would otherwise take longer to report than the interval it
        // reports on.
        const samples = await Promise.all(running.map(async (container: any) => {
            const name = (container.Names?.[0] || '').replace(/^\//, '');
            const uuid = container.Labels?.[CLOUDVIPER_INSTANCE_LABEL] ?? null;

            try {
                const sample = await containerService.containerStats(container.Id);
                const memoryBytes = sample?.memory_stats?.usage ?? null;
                const memoryLimit = sample?.memory_stats?.limit ?? null;

                return {
                    name,
                    uuid,
                    dockerId: container.Id,
                    cpuPercent: cpuPercentFromSample(sample, cpuCount),
                    memoryBytes,
                    memoryPercent: memoryBytes && memoryLimit
                        ? Number(((memoryBytes / memoryLimit) * 100).toFixed(1))
                        : null,
                    owner: null
                };
            } catch {
                // A container that stopped between listing and sampling is
                // ordinary, not an error worth reporting as one.
                return {
                    name, uuid, dockerId: container.Id,
                    cpuPercent: null, memoryBytes: null, memoryPercent: null, owner: null
                };
            }
        }));

        const withOwners = await this.attachOwners(samples);

        return withOwners.sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0));
    }

    /**
     * Put a person against each running desktop.
     *
     * One query for the whole list rather than one per desktop: this runs on the
     * stats interval with every dashboard open, so a query per container would
     * multiply by both.
     */
    private async attachOwners(samples: InstanceStats[]): Promise<InstanceStats[]> {
        const uuids = samples.map((sample) => sample.uuid).filter((uuid): uuid is string => Boolean(uuid));

        if (uuids.length === 0) {
            return samples;
        }

        let rows: any[] = [];

        try {
            rows = await db.ViperInstance.findAll({
                where: { uuid: uuids },
                attributes: ['uuid'],
                include: [{
                    model: db.User,
                    as: 'ownerUser',
                    attributes: ['id', 'username', 'email', 'firstName', 'lastName']
                }]
            });
        } catch (error) {
            // The figures are still useful without a name against them, so this
            // degrades rather than failing the whole stats tick.
            appLogger.warn('Could not attach owners to instance stats', {
                eventType: 'Instance Stats Owner Lookup Failed',
                error: (error as Error).message,
                timestamp: new Date().toISOString()
            });
            return samples;
        }

        const byUuid = new Map<string, any>();

        // Guarded rather than trusted: this runs on a timer behind every open
        // dashboard, so anything unexpected here would break the load reading
        // for everyone, which is the one part of the panel that must not fail.
        for (const row of Array.isArray(rows) ? rows : []) {
            if (row.ownerUser) byUuid.set(row.uuid, row.ownerUser);
        }

        return samples.map((sample) => {
            const person = sample.uuid ? byUuid.get(sample.uuid) : null;

            if (!person) return sample;

            const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();

            return {
                ...sample,
                owner: {
                    id: person.id,
                    username: person.username,
                    email: person.email,
                    // The name if there is one, the username if not: something a
                    // human can match to the person who just put their hand up.
                    displayName: fullName || person.username
                }
            };
        });
    }

    async collect(): Promise<SystemStats> {
        const host = await this.hostStats();
        const instances = await this.instanceStats(host.cpuCount);

        return { host, instances, capturedAt: new Date().toISOString() };
    }

    /** Instances as the dashboard lists them, shared by the stream and the REST route. */
    async instanceSummaries(): Promise<any[]> {
        return db.ViperInstance.findAll({
            attributes: ['id', 'uuid', 'name', 'status', 'owner', 'url', 'createdAt', 'isBuildInstance', 'imageReference', 'activityScore', 'isUserActive', 'lastActivity'],
            order: [['createdAt', 'DESC']]
        });
    }
}

const systemStatsService = new SystemStatsService();
export default systemStatsService;
