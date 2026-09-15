jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

const mockContainerService = {
    info: jest.fn(),
    listContainers: jest.fn(),
    containerStats: jest.fn()
};

jest.mock('../../../services/ContainerService', () => ({
    __esModule: true,
    default: mockContainerService
}));

jest.mock('../../../models', () => ({
    ViperInstance: { findAll: jest.fn() },
    User: { findByPk: jest.fn() },
    ContainerImage: { findAll: jest.fn() },
    Team: { findByPk: jest.fn() },
    sequelize: { query: jest.fn() }
}));

import db from '../../../models';
import systemStatsService, { cpuPercentFromSample } from '../../../services/SystemStatsService';
import { CLOUDVIPER_INSTANCE_LABEL } from '../../../services/ViperInstanceService';

/** A sample shaped like Docker's, with the deltas the calculation needs. */
function sample(overrides: Record<string, any> = {}) {
    return {
        cpu_stats: {
            cpu_usage: { total_usage: 2_000_000_000 },
            system_cpu_usage: 100_000_000_000,
            online_cpus: 2
        },
        precpu_stats: {
            cpu_usage: { total_usage: 1_000_000_000 },
            system_cpu_usage: 98_000_000_000
        },
        memory_stats: { usage: 500 * 1024 ** 2, limit: 4 * 1024 ** 3 },
        ...overrides
    };
}

describe('cpuPercentFromSample', () => {
    it('should compute a percentage from the delta between two cumulative counters', () => {
        // Docker never reports a percentage; it only exists as a delta. Here
        // the container used 1e9ns while the system advanced 2e9ns across 2
        // cores, so it had half of one core, which is 50% of one and 100% when
        // expressed against a single core's worth of capacity.
        expect(cpuPercentFromSample(sample(), 2)).toBe(100);
    });

    it('should scale by the number of cores Docker reports', () => {
        const oneCore = sample({
            cpu_stats: {
                cpu_usage: { total_usage: 2_000_000_000 },
                system_cpu_usage: 100_000_000_000,
                online_cpus: 1
            }
        });

        expect(cpuPercentFromSample(oneCore, 1)).toBe(50);
    });

    it('should answer null on a first sample, not zero', () => {
        // A container sampled for the first time has no previous reading. Zero
        // would be a claim about its CPU use; null says the figure is not known
        // yet, which is the truth.
        const first = sample({ precpu_stats: { cpu_usage: { total_usage: 0 } } });

        expect(cpuPercentFromSample(first, 2)).toBeNull();
    });

    it('should answer null rather than divide by zero', () => {
        const stalled = sample({
            precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 100_000_000_000 }
        });

        expect(cpuPercentFromSample(stalled, 2)).toBeNull();
    });

    it('should answer null on a malformed sample', () => {
        expect(cpuPercentFromSample(null, 2)).toBeNull();
        expect(cpuPercentFromSample({}, 2)).toBeNull();
    });

    it('should fall back to the host core count when Docker omits online_cpus', () => {
        const noCores = sample({
            cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 100_000_000_000 }
        });

        expect(cpuPercentFromSample(noCores, 4)).toBe(200);
    });
});

describe('hostStats', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockContainerService.info.mockResolvedValue({ NCPU: 2, Containers: 5, ContainersRunning: 4 });
    });

    it('should report core count and container counts from Docker', async () => {
        const stats = await systemStatsService.hostStats();

        expect(stats.cpuCount).toBe(2);
        expect(stats.containers).toEqual({ total: 5, running: 4 });
    });

    it('should express load against core count', async () => {
        const stats = await systemStatsService.hostStats();

        // A load of N on N cores is 100%. Reporting raw load alone is a figure
        // nobody can interpret without knowing the core count.
        if (stats.loadAverage.length) {
            expect(stats.loadPercent).toBeCloseTo((stats.loadAverage[0] / 2) * 100, 1);
        }
    });

    it('should still answer when Docker cannot be reached', async () => {
        // The dashboard asking about host health is exactly when the daemon
        // might be unavailable, so this must degrade rather than throw.
        mockContainerService.info.mockRejectedValue(new Error('socket missing'));

        const stats = await systemStatsService.hostStats();

        expect(stats.containers).toBeNull();
        expect(stats.cpuCount).toBe(0);
        expect(stats.loadPercent).toBeNull();
    });

    it('should read host memory, not the container total', async () => {
        const stats = await systemStatsService.hostStats();

        expect(stats.memory).not.toBeNull();
        expect(stats.memory!.totalBytes).toBeGreaterThan(0);
        expect(stats.memory!.usedBytes).toBe(stats.memory!.totalBytes - stats.memory!.availableBytes);
    });
});

describe('instanceStats', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should ask Docker only for containers this service owns', async () => {
        // Scoped by the ownership label, so the database and the app itself
        // never appear next to the desktops an admin is trying to read.
        mockContainerService.listContainers.mockResolvedValue([]);

        await systemStatsService.instanceStats(2);

        expect(mockContainerService.listContainers).toHaveBeenCalledWith({
            filters: { label: [CLOUDVIPER_INSTANCE_LABEL] }
        });
    });

    it('should report per-instance cpu and memory', async () => {
        mockContainerService.listContainers.mockResolvedValue([
            { Id: 'abc', Names: ['/viper-cloud-inst1'], Labels: { [CLOUDVIPER_INSTANCE_LABEL]: 'inst1' } }
        ]);
        mockContainerService.containerStats.mockResolvedValue(sample());

        const stats = await systemStatsService.instanceStats(2);

        expect(stats).toHaveLength(1);
        expect(stats[0].name).toBe('viper-cloud-inst1');
        expect(stats[0].uuid).toBe('inst1');
        expect(stats[0].cpuPercent).toBe(100);
        expect(stats[0].memoryPercent).toBeCloseTo(12.2, 0);
    });

    it('should survive a container that stops mid-sample', async () => {
        // Listing and sampling are two calls; a desktop terminated between them
        // is ordinary, not an error worth failing the whole dashboard for.
        mockContainerService.listContainers.mockResolvedValue([
            { Id: 'gone', Names: ['/viper-cloud-gone'], Labels: { [CLOUDVIPER_INSTANCE_LABEL]: 'gone' } }
        ]);
        mockContainerService.containerStats.mockRejectedValue(new Error('no such container'));

        const stats = await systemStatsService.instanceStats(2);

        expect(stats).toHaveLength(1);
        expect(stats[0].cpuPercent).toBeNull();
    });

    it('should list the heaviest instance first', async () => {
        mockContainerService.listContainers.mockResolvedValue([
            { Id: 'a', Names: ['/viper-cloud-small'], Labels: { [CLOUDVIPER_INSTANCE_LABEL]: 'small' } },
            { Id: 'b', Names: ['/viper-cloud-big'], Labels: { [CLOUDVIPER_INSTANCE_LABEL]: 'big' } }
        ]);
        mockContainerService.containerStats.mockImplementation(async (id: string) =>
            sample({ memory_stats: { usage: id === 'b' ? 2 * 1024 ** 3 : 100 * 1024 ** 2, limit: 4 * 1024 ** 3 } })
        );

        const stats = await systemStatsService.instanceStats(2);

        expect(stats.map(s => s.name)).toEqual(['viper-cloud-big', 'viper-cloud-small']);
    });

    it('should return nothing when Docker cannot be listed', async () => {
        mockContainerService.listContainers.mockRejectedValue(new Error('daemon down'));

        await expect(systemStatsService.instanceStats(2)).resolves.toEqual([]);
    });
});

describe('who each desktop belongs to', () => {
    /**
     * A runaway desktop is a person having a bad time, and the container name
     * does not say which person. An administrator with a room in front of them
     * needs to match "my ViPER has gone mad" to a row without cross-referencing
     * anything.
     */
    const mockDb = db as unknown as { ViperInstance: { findAll: jest.Mock } };

    function container(id: string, uuid: string) {
        return { Id: id, Names: ['/viper-cloud-' + uuid], Labels: { [CLOUDVIPER_INSTANCE_LABEL]: uuid } };
    }

    function row(uuid: string, owner: any) {
        return { uuid, ownerUser: owner };
    }

    beforeEach(() => {
        jest.clearAllMocks();
        mockContainerService.containerStats.mockResolvedValue(sample());
    });

    it('should name the person and their email', async () => {
        mockContainerService.listContainers.mockResolvedValue([container('abc', 'inst1')]);
        mockDb.ViperInstance.findAll.mockResolvedValue([
            row('inst1', { id: 7, username: 'jsmith', email: 'john@example.org', firstName: 'John', lastName: 'Smith' })
        ]);

        const stats = await systemStatsService.instanceStats(2);

        expect(stats[0].owner).toEqual({
            id: 7, username: 'jsmith', email: 'john@example.org', displayName: 'John Smith'
        });
    });

    it('should fall back to the username when no name is recorded', async () => {
        mockContainerService.listContainers.mockResolvedValue([container('abc', 'inst1')]);
        mockDb.ViperInstance.findAll.mockResolvedValue([
            row('inst1', { id: 3, username: 'workshop7', email: 'w7@x.org', firstName: null, lastName: null })
        ]);

        const stats = await systemStatsService.instanceStats(2);

        expect(stats[0].owner!.displayName).toBe('workshop7');
    });

    it('should carry the docker id, so the panel can act on what it shows', async () => {
        mockContainerService.listContainers.mockResolvedValue([container('deadbeef', 'inst1')]);
        mockDb.ViperInstance.findAll.mockResolvedValue([]);

        const stats = await systemStatsService.instanceStats(2);

        expect(stats[0].dockerId).toBe('deadbeef');
    });

    it('should ask the database once for the whole list, not once per desktop', async () => {
        // This runs on the stats interval for every open dashboard, so a query
        // per container multiplies by both.
        mockContainerService.listContainers.mockResolvedValue([
            container('a', 'one'), container('b', 'two'), container('c', 'three')
        ]);
        mockDb.ViperInstance.findAll.mockResolvedValue([]);

        await systemStatsService.instanceStats(2);

        expect(mockDb.ViperInstance.findAll).toHaveBeenCalledTimes(1);
        // The call count alone would pass a query that asked about one desktop
        // and left the rest unnamed, so assert it asked about all of them.
        expect(mockDb.ViperInstance.findAll).toHaveBeenCalledWith(
            expect.objectContaining({ where: { uuid: ['one', 'two', 'three'] } })
        );
    });

    it('should leave the owner null for a container with no row', async () => {
        // Real for a few seconds either side of creation and teardown.
        mockContainerService.listContainers.mockResolvedValue([container('abc', 'orphan')]);
        mockDb.ViperInstance.findAll.mockResolvedValue([]);

        const stats = await systemStatsService.instanceStats(2);

        expect(stats[0].owner).toBeNull();
    });

    it('should still report the figures when the owner lookup fails', async () => {
        // The numbers are the point of the panel. Losing the names is worse
        // than losing nothing, but far better than losing the load reading.
        mockContainerService.listContainers.mockResolvedValue([container('abc', 'inst1')]);
        mockDb.ViperInstance.findAll.mockRejectedValue(new Error('database is away'));

        const stats = await systemStatsService.instanceStats(2);

        expect(stats).toHaveLength(1);
        expect(stats[0].cpuPercent).toBe(100);
        expect(stats[0].owner).toBeNull();
    });

    it('should not query at all when nothing is running', async () => {
        mockContainerService.listContainers.mockResolvedValue([]);

        await systemStatsService.instanceStats(2);

        expect(mockDb.ViperInstance.findAll).not.toHaveBeenCalled();
    });
});
