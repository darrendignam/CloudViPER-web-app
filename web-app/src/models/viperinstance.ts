'use strict';

import { Model, DataTypes, Sequelize } from 'sequelize';

interface ViperInstanceAttributes {
    id?: number;
    owner: number;
    uuid: string;
    dockerid: string;
    name: string;
    url: string;
    masterToken: string;
    statusKey: string;
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
        public statusKey!: string;
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
        statusKey: { type: DataTypes.STRING, allowNull: true },
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