'use strict';

import { Sequelize, Dialect } from 'sequelize';
import * as process from 'process';

import configAuth from '../config/auth';
import { logSQL, appLogger } from '../config/logger';
import User from './user';
import ViperInstance from './viperinstance';
import Log from './log'; // Import the Logs model
import Screenshot from './screenshot'; // Import the Screenshot model
import Activity from './activity'; // Import the Activity model


const env = process.env.NODE_ENV || 'development';

const databasehost = configAuth.mysqlSessionAuth.host;
const database = configAuth.mysqlSessionAuth.database;
const username = configAuth.mysqlSessionAuth.user;
const password = configAuth.mysqlSessionAuth.password;
const config: { 
  host: string; 
  dialect: Dialect; 
  logging: boolean | ((...msg: any[]) => void);
  dialectOptions?: {
    charset?: string;
  };
  pool?: {
    max: number;
    min: number;
    acquire: number;
    idle: number;
  };
} = { 
  "host": databasehost, 
  "dialect": "mysql", 
  logging: logSQL,
  dialectOptions: {
    charset: 'utf8mb4',
  },
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
};

// Database connection info
console.log(`DB Connected: ${database}@${databasehost} as ${username}`);

// Log database connection attempt
appLogger.info('Database connection initialized', {
    database,
    host: databasehost,
    user: username,
    env,
    timestamp: new Date().toISOString()
});

const sequelize: Sequelize = new Sequelize(database, username, password, config);

const usermodel = User(sequelize);
const vipermodel = ViperInstance(sequelize);
const logmodel = Log(sequelize); // Initialize the Logs model
const screenshotmodel = Screenshot(sequelize); // Initialize the Screenshot model
const activitymodel = Activity(sequelize); // Initialize the Activity model

interface DB {
  sequelize: Sequelize;
  Sequelize: typeof Sequelize;
  User: typeof usermodel;
  ViperInstance: typeof vipermodel;
  Log: typeof logmodel; // Add Logs to the DB interface
  Screenshot: typeof screenshotmodel; // Add Screenshot to the DB interface
  Activity: typeof activitymodel; // Add Activity to the DB interface
}

const db: DB = {
  sequelize,
  Sequelize,
  User: usermodel,
  ViperInstance: vipermodel,
  Log: logmodel, // Add Logs to the db object
  Screenshot: screenshotmodel, // Add Screenshot to the db object
  Activity: activitymodel, // Add Activity to the db object
};

Object.keys(db).forEach((modelName: string) => {
  if ((db as any)[modelName].associate) {
    (db as any)[modelName].associate(db);
  }
});

// Only sync database if not in test environment or if explicitly requested
if (env !== 'test' || process.env.FORCE_DB_SYNC === 'true') {
  db.sequelize.sync({ 
    force: env === 'test', // Force recreate tables in test environment
    alter: env !== 'test'  // Use alter in non-test environments
  }).then(() => {
    console.log(`Database synchronized with ${env === 'test' ? '{ force: true }' : '{ alter: true }'}`);
    appLogger.info('Database synchronized successfully', {
      mode: env === 'test' ? 'force' : 'alter',
      env,
      timestamp: new Date().toISOString()
    });
  }).catch((error) => {
    console.error('Database synchronization failed:', error);
    appLogger.error('Database synchronization failed', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  });
}

export { usermodel, vipermodel, logmodel, screenshotmodel, activitymodel }; 
export default db;
