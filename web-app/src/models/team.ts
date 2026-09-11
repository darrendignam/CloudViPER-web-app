'use strict';

import { Model, DataTypes, Sequelize } from 'sequelize';

/**
 * A team is a row, not a string.
 *
 * Membership used to be a free-text column on User where the literal `'none'`
 * meant "no team". Every check then had to remember to exclude it, and one that
 * forgot let any two teamless users reach each other's instances. A user with
 * no team now has `teamId` NULL, which cannot be compared equal to another
 * NULL, so the whole class of bug is gone rather than guarded against.
 */
interface TeamAttributes {
    id?: number;
    name: string;
    description?: string | null;
    defaultImageId?: number | null;
    createdAt?: Date;
    updatedAt?: Date;
}

export default (sequelize: Sequelize) => {
    class Team extends Model<TeamAttributes> implements TeamAttributes {
        public id?: number;
        public name!: string;
        public description?: string | null;
        public defaultImageId?: number | null;
        public readonly createdAt!: Date;
        public readonly updatedAt!: Date;

        static associate(models: any) {
            Team.hasMany(models.User, {
                foreignKey: 'teamId',
                as: 'members'
            });

            Team.belongsTo(models.ContainerImage, {
                foreignKey: 'defaultImageId',
                as: 'defaultImage'
            });
        }
    }

    Team.init(
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            name: { type: DataTypes.STRING, allowNull: false, unique: true },
            description: { type: DataTypes.TEXT, allowNull: true },
            // Null means the team has expressed no preference and instances fall
            // through to the global default.
            defaultImageId: { type: DataTypes.INTEGER, allowNull: true },
            createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
        },
        {
            sequelize,
            modelName: 'Team'
        }
    );

    return Team;
};
