'use strict';

import { Model, DataTypes, Sequelize } from 'sequelize';

// Server-side credentials held on the instance row. masterToken authenticates
// CloudViPER to the container's Selkies control plane and statusKey authorises
// the in-container monitor's callbacks, so neither may reach a browser, an
// admin's included. Excluded from every query whose result is serialised out.
export const INSTANCE_CREDENTIAL_ATTRIBUTES = ['masterToken', 'statusKey', 'sessionTokens'];

interface ViperInstanceAttributes {
    id?: number;
    owner: number;
    uuid: string;
    dockerid: string;
    name: string;
    url: string;
    masterToken: string;
    sessionTokens?: Record<string, any>;
    devPorts?: Record<string, number> | null;
    statusKey: string;
    // Which image this instance was built from. imageId can go null if the pool
    // entry is deleted, so the reference is kept alongside it: support needs to
    // know what an instance actually ran, not what it points at today.
    imageId?: number | null;
    imageReference?: string | null;
    // A build instance keeps sudo so an admin can customise it before it is
    // committed to an image. Normal instances are hardened; this records which
    // is which rather than leaving it to be inferred.
    isBuildInstance?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
    status: string;
    logs: any[];
    lastActivity?: Date;
    lastScreenshot?: any;
    activityHistory?: any[];
    activityScore?: number;
    isUserActive?: boolean;
  }

export default (sequelize: Sequelize) => {
    class ViperInstance extends Model<ViperInstanceAttributes> implements ViperInstanceAttributes {
        public id?: number;
        public owner!: number;
        public uuid!: string;
        public dockerid!: string;
        public name!: string;
        public url!: string;
        public masterToken!: string;
        public sessionTokens?: Record<string, any>;
        public devPorts?: Record<string, number> | null;
        public statusKey!: string;
        public imageId?: number | null;
        public imageReference?: string | null;
        public isBuildInstance?: boolean;
        public createdAt?: Date;
        public updatedAt?: Date;
        public status!: string;
        public logs!: any[];
        public lastActivity?: Date;
        public lastScreenshot?: any;
        public activityHistory?: any[];
        public activityScore?: number;
        public isUserActive?: boolean;
    
        static associate(models: any) {
          // define association here
          ViperInstance.belongsTo(models.User, {
            foreignKey: 'owner',
            as: 'ownerUser'
          });
          
          // Add associations to new tables
          ViperInstance.hasMany(models.Screenshot, {
            foreignKey: 'instanceId',
            as: 'screenshots'
          });
          
          ViperInstance.hasMany(models.Activity, {
            foreignKey: 'instanceId',
            as: 'activities'
          });

          ViperInstance.belongsTo(models.ContainerImage, {
            foreignKey: 'imageId',
            as: 'image'
          });
        }
    }

    ViperInstance.init({
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        owner: { type: DataTypes.INTEGER, allowNull: true },
        uuid: { type: DataTypes.STRING, allowNull: true },
        dockerid: { type: DataTypes.STRING, allowNull: true },
        name: { type: DataTypes.STRING, allowNull: true },
        url: { type: DataTypes.STRING, allowNull: true },
        masterToken: { type: DataTypes.STRING, allowNull: true },
        // Session tokens currently registered with the container's control
        // plane, keyed by token. A control plane POST replaces the whole set, so
        // the set has to be reconstructed on every grant; without this an owner
        // is disconnected whenever anyone else opens their desktop.
        sessionTokens: { type: DataTypes.JSON, allowNull: true, defaultValue: {} },
        // Host ports published in development, where the app runs outside the
        // Docker network and cannot resolve the container by name. Null in
        // production, where service names resolve and nothing is published.
        devPorts: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        statusKey: { type: DataTypes.STRING, allowNull: true },
        imageId: { type: DataTypes.INTEGER, allowNull: true },
        imageReference: { type: DataTypes.STRING, allowNull: true },
        isBuildInstance: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'initilising' },
        logs: { type: DataTypes.JSON, allowNull: true, defaultValue: [] }, // Initialize as an empty array
        lastActivity: { type: DataTypes.DATE, allowNull: true },
        lastScreenshot: { type: DataTypes.JSON, allowNull: true },
        activityHistory: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
        activityScore: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
        isUserActive: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    }, {
        sequelize,
        modelName: 'ViperInstance',
    });

    return ViperInstance;
};