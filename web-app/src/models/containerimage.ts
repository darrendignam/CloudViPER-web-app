'use strict';

import { Model, DataTypes, Sequelize } from 'sequelize';

/**
 * How an image entered the pool.
 *
 * `registry` was pulled from a reference someone pasted in. `commit` was made
 * from a running instance on this appliance and exists nowhere else, which is
 * why deleting one is not recoverable by re-pulling.
 */
export enum ImageSource {
    REGISTRY = 'registry',
    COMMIT = 'commit'
}

/**
 * A pool entry is not usable the moment it is created. Pulling a ViPER image is
 * gigabytes and minutes, so the row exists while the bytes are still arriving
 * and only `AVAILABLE` may be launched.
 */
export enum ImageStatus {
    PENDING = 'pending',
    AVAILABLE = 'available',
    FAILED = 'failed'
}

export function isValidImageSource(value: string): value is ImageSource {
    return Object.values(ImageSource).includes(value as ImageSource);
}

export function isValidImageStatus(value: string): value is ImageStatus {
    return Object.values(ImageStatus).includes(value as ImageStatus);
}

interface ContainerImageAttributes {
    id?: number;
    reference: string;
    name: string;
    description?: string | null;
    source: ImageSource;
    status: ImageStatus;
    statusMessage?: string | null;
    digest?: string | null;
    sizeBytes?: number | null;
    isGlobalDefault?: boolean;
    createdById?: number | null;
    builtFromInstanceId?: number | null;
    metadata?: Record<string, any> | null;
    // Extra environment and mounts applied to every instance built from this
    // image. Both are validated before they are stored, in InstanceCustomisation,
    // because both are host access by another name.
    envVars?: Record<string, string> | null;
    volumes?: Array<{ hostPath: string; containerPath: string; readOnly: boolean }> | null;
    createdAt?: Date;
    updatedAt?: Date;
}

export default (sequelize: Sequelize) => {
    class ContainerImage extends Model<ContainerImageAttributes> implements ContainerImageAttributes {
        public id?: number;
        public reference!: string;
        public name!: string;
        public description?: string | null;
        public source!: ImageSource;
        public status!: ImageStatus;
        public statusMessage?: string | null;
        public digest?: string | null;
        public sizeBytes?: number | null;
        public isGlobalDefault?: boolean;
        public createdById?: number | null;
        public builtFromInstanceId?: number | null;
        public metadata?: Record<string, any> | null;
        public envVars?: Record<string, string> | null;
        public volumes?: Array<{ hostPath: string; containerPath: string; readOnly: boolean }> | null;
        public readonly createdAt!: Date;
        public readonly updatedAt!: Date;

        public isLaunchable(): boolean {
            return this.status === ImageStatus.AVAILABLE;
        }

        /**
         * An image built here by committing a running instance exists only on
         * this appliance, so removing it destroys it. One pulled from a
         * registry can always be pulled again.
         */
        public isRecoverableAfterDeletion(): boolean {
            return this.source === ImageSource.REGISTRY;
        }

        static associate(models: any) {
            ContainerImage.belongsTo(models.User, {
                foreignKey: 'createdById',
                as: 'createdBy'
            });

            ContainerImage.hasMany(models.Team, {
                foreignKey: 'defaultImageId',
                as: 'teamsDefaultingToThis'
            });
        }
    }

    ContainerImage.init(
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            reference: {
                type: DataTypes.STRING,
                allowNull: false,
                unique: true
            },
            name: { type: DataTypes.STRING, allowNull: false },
            description: { type: DataTypes.TEXT, allowNull: true },
            source: {
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: ImageSource.REGISTRY,
                validate: {
                    isValidSource(value: string) {
                        if (!isValidImageSource(value)) {
                            throw new Error(`Invalid image source: ${value}. Must be one of: ${Object.values(ImageSource).join(', ')}`);
                        }
                    }
                }
            },
            status: {
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: ImageStatus.PENDING,
                validate: {
                    isValidStatus(value: string) {
                        if (!isValidImageStatus(value)) {
                            throw new Error(`Invalid image status: ${value}. Must be one of: ${Object.values(ImageStatus).join(', ')}`);
                        }
                    }
                }
            },
            statusMessage: { type: DataTypes.TEXT, allowNull: true },
            digest: { type: DataTypes.STRING, allowNull: true },
            // A ViPER image is several gigabytes, past the 2^31 a plain INTEGER
            // holds, so this has to be BIGINT.
            sizeBytes: { type: DataTypes.BIGINT, allowNull: true },
            isGlobalDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            createdById: { type: DataTypes.INTEGER, allowNull: true },
            builtFromInstanceId: { type: DataTypes.INTEGER, allowNull: true },
            metadata: { type: DataTypes.JSON, allowNull: true, defaultValue: {} },
            envVars: { type: DataTypes.JSON, allowNull: true, defaultValue: {} },
            volumes: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
            createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
        },
        {
            sequelize,
            modelName: 'ContainerImage'
        }
    );

    return ContainerImage;
};
