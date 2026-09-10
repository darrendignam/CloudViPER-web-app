'use strict';

import { Sequelize, DataTypes, Model } from 'sequelize';
import crypto from 'crypto';
import util from 'util';
import { UserRole, isValidRole } from '../types/UserRole';

/*
ROLES:

user - nothing
testing - can run one viper
member - can run one viper
subscriber - pays for use
admin - viper and user management

Note: Role values are stored as strings in the database for backward compatibility,
but should use the UserRole enum in TypeScript code.
*/

const options = {
    saltlen: 32,
    iterations: 25000,
    keylen: 512,
    digest: 'sha256',
    usernameField: 'email',
    hashField: 'hash',
    saltField: 'salt',
    missingPasswordError: 'Password argument not set!',
    incorrectPasswordError: 'Incorrect password',
    incorrectUsernameError: 'Incorrect username',
    noSaltValueStoredError: 'Authentication not possible. No salt value stored in db!',
    userExistsError: 'User already exists with %s',
    missingUsernameError: 'Field %s is not set',
};

interface UserAttributes {
    id?: number;
    username: string;
    email: string;
    title?: string;
    firstName?: string;
    lastName?: string;
    role: UserRole; // Use enum type for TypeScript
    team?: string; // Team name, default is 'none'
    invitedById?: number; // ID of the user who invited this user
    oauthID?: string;
    oauthProvider?: string;
    salt?: string;
    hash?: string;
    resetPasswordToken?: string;
    resetPasswordExpires?: Date;
    oauthProfile?: object;
    createdAt?: Date;
    updatedAt?: Date;
}

export default (sequelize: Sequelize) => {
    class User extends Model<UserAttributes> implements UserAttributes {
        public id!: number;
        public username!: string;
        public email!: string;
        public title?: string;
        public firstName?: string;
        public lastName?: string;
        public role!: UserRole;
        public team?: string;
        public invitedById?: number;
        public oauthID?: string;
        public oauthProvider?: string;
        public salt?: string;
        public hash?: string;
        public resetPasswordToken?: string;
        public resetPasswordExpires?: Date;
        public oauthProfile?: object;
        public readonly createdAt!: Date;
        public readonly updatedAt!: Date;

        public static async register(userDetails: Partial<UserAttributes>, password: string): Promise<User> {
            if (!userDetails.email) {
                throw new Error(util.format(options.missingUsernameError, options.usernameField));
            }
            const user = this.build(userDetails as UserAttributes);

            if (!user.email) {
                throw new Error(util.format(options.missingUsernameError, options.usernameField));
            }

            const existingUser = await this.findOne({ where: { email: user.email } });
            if (existingUser) {
                throw new Error(util.format(options.userExistsError, user.email));
            }

            await user.setPassword(password);
            await user.save();
            return user;
        }    

        public setPassword(password: string): Promise<void> {
            return new Promise((resolve, reject) => {
                if (!password) {
                    return reject(new Error(options.missingPasswordError));
                }

                crypto.randomBytes(options.saltlen, (err, buf) => {
                    if (err) {
                        return reject(err);
                    }

                    const salt = buf.toString('hex');

                    crypto.pbkdf2(password, salt, options.iterations, options.keylen, options.digest, (err, hashRaw) => {
                        if (err) {
                            return reject(err);
                        }

                        const new_hash = Buffer.from(hashRaw).toString('hex');
                        this.hash = new_hash;
                        // console.log("New Hash: ", new_hash);
                        this.salt = salt;

                        resolve();
                    });
                });
            });
        }

        public authenticate(password: string): Promise<User | boolean> {
            return new Promise((resolve, reject) => {
                if (!this.salt) {
                    return reject(new Error(options.noSaltValueStoredError));
                }

                crypto.pbkdf2(password, this.salt, options.iterations, options.keylen, options.digest, (err, hashRaw) => {
                    if (err) {
                        return reject(err);
                    }

                    const hash = Buffer.from(hashRaw).toString('hex');

                    if (hash === this.hash) {
                        resolve(this);
                    } else {
                        resolve(false);
                    }
                });
            });
 

        }

        static async authenticateUser(email: string, password: string): Promise<User | boolean> {
            try {
                const user = await User.unscoped().findOne({ where: { email } });
                if (!user) {
                    return false;
                }
                return user.authenticate(password);
            } catch (error) {
                console.error("Authentication Error:", error);
                return false;
            }
        }
        
        // Team-related helper methods
        public isTeamAdmin(): boolean {
            return this.role === UserRole.TEAM_ADMIN;
        }

        public isTeamLeader(): boolean {
            return this.role === UserRole.TEAM_LEADER;
        }

        public isInTeam(): boolean {
            return !!this.team && this.team !== 'none';
        }

        public async getTeamMembers(): Promise<User[]> {
            if (!this.isInTeam()) {
                return [];
            }
            
            return User.findAll({
                where: {
                    team: this.team
                }
            });
        }

        public async getInvitationChain(): Promise<User[]> {
            const chain: User[] = [];
            // eslint-disable-next-line @typescript-eslint/no-this-alias -- the loop reassigns as it walks the chain
            let currentUser: User | null = this;
            
            while (currentUser && currentUser.invitedById) {
                const inviter = await User.findByPk(currentUser.invitedById) as User | null;
                if (inviter) {
                    chain.push(inviter);
                    currentUser = inviter;
                } else {
                    break;
                }
            }
            
            return chain;
        }

        // Team management methods
        public static async setTeamAdmin(userId: number, teamName: string): Promise<User | null> {
            const user = await User.findByPk(userId);
            
            if (!user) {
                return null;
            }
            
            // Check if team already has an admin
            const existingAdmin = await User.findOne({
                where: {
                    team: teamName,
                    role: UserRole.TEAM_ADMIN
                }
            });
            
            if (existingAdmin) {
                throw new Error(`Team ${teamName} already has an admin`);
            }
            
            user.team = teamName;
            user.role = UserRole.TEAM_ADMIN;
            await user.save();
            
            return user;
        }

        public async inviteUser(email: string, role: UserRole = UserRole.MEMBER): Promise<User | null> {
            // Check if user has permission to invite
            if (!(this.role === UserRole.ADMIN || 
                  this.role === UserRole.TEAM_ADMIN || 
                 (this.role === UserRole.TEAM_LEADER && role === UserRole.MEMBER))) {
                throw new Error("You don't have permission to invite users");
            }
            
            // For team leaders and team admins, can only invite to their own team
            if ((this.role === UserRole.TEAM_LEADER || this.role === UserRole.TEAM_ADMIN) 
                && (!this.isInTeam() || role === UserRole.ADMIN)) {
                throw new Error("You can only invite users to your team");
            }
            
            // Create or update the user
            let user = await User.findOne({ where: { email } });
            
            if (!user) {
                // Create a new user
                const randomPassword = Math.random().toString(36).slice(-8);
                user = await User.register({
                    email,
                    username: email.split('@')[0],
                    role,
                    invitedById: this.id,
                    team: this.role === UserRole.ADMIN ? 'none' : this.team
                }, randomPassword);
            } else {
                // Update existing user
                if (this.role === UserRole.ADMIN) {
                    user.role = role;
                } else {
                    user.team = this.team;
                    user.role = role;
                }
                
                user.invitedById = this.id;
                await user.save();
            }
            
            return user;
        }

        static associate(models: any) {
            // define association here
            User.hasMany(models.ViperInstance, {
                foreignKey: 'owner',
                as: 'viperInstances'
            });
            
            // Self-referencing association for invitation tracking
            User.belongsTo(User, { 
                foreignKey: 'invitedById',
                as: 'invitedBy'
            });
            User.hasMany(User, { 
                foreignKey: 'invitedById',
                as: 'invitedUsers' 
            });
        }
    }

    User.init(
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            username: { type: DataTypes.STRING, allowNull: false },
            email: { type: DataTypes.STRING, allowNull: false, validate: { isEmail: true } },
            title: { type: DataTypes.STRING, allowNull: true },
            firstName: { type: DataTypes.STRING, allowNull: true },
            lastName: { type: DataTypes.STRING, allowNull: true },
            role: { 
                type: DataTypes.STRING, 
                allowNull: false,
                validate: {
                    isValidRole(value: string) {
                        if (!isValidRole(value)) {
                            throw new Error(`Invalid role: ${value}. Must be one of: ${Object.values(UserRole).join(', ')}`);
                        }
                    }
                },
                defaultValue: UserRole.USER
            },
            team: { 
                type: DataTypes.STRING, 
                allowNull: true,
                defaultValue: 'none' 
            },
            invitedById: { 
                type: DataTypes.INTEGER, 
                allowNull: true,
                references: {
                    model: 'Users',
                    key: 'id'
                }
            },
            oauthID: { type: DataTypes.STRING },
            oauthProvider: { type: DataTypes.STRING },
            salt: { type: DataTypes.STRING },
            hash: { type: DataTypes.TEXT },
            resetPasswordToken: { type: DataTypes.STRING },
            resetPasswordExpires: { type: DataTypes.DATE },
            oauthProfile: { type: DataTypes.JSON },
            createdAt: { type: DataTypes.DATE },
            updatedAt: { type: DataTypes.DATE },
        },
        {
            sequelize,
            modelName: 'User',
            defaultScope: {
                // exclude password hash by default
                attributes: { exclude: ['salt', 'hash'] },
            },
        }
    );

    return User;
};