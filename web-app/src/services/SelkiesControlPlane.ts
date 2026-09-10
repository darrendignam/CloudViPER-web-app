import { appLogger } from '../config/logger';
import { readIntEnv } from '../utility/envConfig';

export type SelkiesRole = 'controller' | 'viewer';

export interface SelkiesTokenPermissions {
    role: SelkiesRole;
    slot: number | null;
    mk_control?: boolean;
}

export type SelkiesTokenSet = Record<string, SelkiesTokenPermissions>;

export interface SelkiesTarget {
    host: string;
    masterToken: string;
    port?: number;
}

export const SELKIES_CONTROL_PORT = readIntEnv('SELKIES_CONTROL_PORT', 8083);
export const SELKIES_CONTROL_TIMEOUT_MS = readIntEnv('SELKIES_CONTROL_TIMEOUT_MS', 5000);

/**
 * Raised when the Selkies control plane rejects or fails to answer a request.
 * `statusCode` is present only when the container answered.
 */
export class SelkiesControlPlaneError extends Error {
    public readonly statusCode?: number;
    public readonly host: string;
    public readonly cause?: unknown;

    constructor(message: string, host: string, statusCode?: number, cause?: unknown) {
        super(message);
        this.name = 'SelkiesControlPlaneError';
        this.host = host;
        this.statusCode = statusCode;
        this.cause = cause;
    }
}

/**
 * Client for the Selkies in-container token control plane.
 *
 * The control plane listens only when the container was started with
 * SELKIES_MASTER_TOKEN, and it binds 0.0.0.0 inside the container, so its port
 * must never be published. A POST replaces the entire token set: tokens absent
 * from the new set have their live clients disconnected with close code 4002.
 */
export class SelkiesControlPlane {
    private endpoint(target: SelkiesTarget): string {
        return `http://${target.host}:${target.port ?? SELKIES_CONTROL_PORT}/tokens`;
    }

    /**
     * Replace the container's entire active token set.
     */
    async replaceTokens(target: SelkiesTarget, tokens: SelkiesTokenSet): Promise<void> {
        const url = this.endpoint(target);
        let response: Response;

        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${target.masterToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(tokens),
                signal: AbortSignal.timeout(SELKIES_CONTROL_TIMEOUT_MS)
            });
        } catch (error) {
            const reason = error instanceof Error && error.name === 'TimeoutError'
                ? `Control plane did not answer within ${SELKIES_CONTROL_TIMEOUT_MS}ms`
                : `Could not reach control plane: ${(error as Error).message}`;
            throw new SelkiesControlPlaneError(reason, target.host, undefined, error);
        }

        if (!response.ok) {
            throw new SelkiesControlPlaneError(
                `Control plane rejected token update with status ${response.status}`,
                target.host,
                response.status
            );
        }

        appLogger.info('Selkies token set replaced', {
            eventType: 'Selkies Tokens Replaced',
            host: target.host,
            tokenCount: Object.keys(tokens).length,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Drop every active token, disconnecting all live viewers.
     */
    async revokeAll(target: SelkiesTarget): Promise<void> {
        await this.replaceTokens(target, {});
    }

    /**
     * Register a single token as the container's only valid credential.
     */
    async grantSoleToken(
        target: SelkiesTarget,
        token: string,
        role: SelkiesRole = 'controller'
    ): Promise<void> {
        await this.replaceTokens(target, {
            [token]: { role, slot: null, mk_control: false }
        });
    }
}

const selkiesControlPlane = new SelkiesControlPlane();
export default selkiesControlPlane;
