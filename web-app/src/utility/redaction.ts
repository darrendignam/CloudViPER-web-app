/**
 * Strip secrets out of Docker structures before they reach a log.
 *
 * Container environments carry SELKIES_MASTER_TOKEN, which mints desktop access
 * through the control plane. appLogger writes to a rotated file with 14 day
 * retention that /service/logs/app serves to admins, so an environment logged
 * once stays readable long after the request that logged it.
 *
 * Variable names survive: they are useful for diagnosis and are not sensitive.
 */

const REDACTED = '[redacted]';

export function redactEnvironmentValues(entries: unknown): unknown {
    if (!Array.isArray(entries)) {
        return entries;
    }

    return entries.map((entry: unknown) => `${String(entry).split('=')[0]}=${REDACTED}`);
}

/**
 * Redact the Env of a container create/update options object, where the
 * environment sits at the top level.
 */
export function redactContainerOptions(options: any): any {
    if (!options || typeof options !== 'object') {
        return options;
    }

    return { ...options, Env: redactEnvironmentValues(options.Env) };
}

/**
 * Redact the Env of a container inspect result, where the environment sits
 * under Config.
 */
export function redactContainerInspect(dockerInspect: any): any {
    if (!dockerInspect?.Config) {
        return dockerInspect;
    }

    return {
        ...dockerInspect,
        Config: {
            ...dockerInspect.Config,
            Env: redactEnvironmentValues(dockerInspect.Config.Env)
        }
    };
}
