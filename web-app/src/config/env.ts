import dotenv from 'dotenv';
import path from 'path';

// The single place the .env file is read.
//
// This used to be called from eight modules with three different path
// arguments, which resolved to different files: `${__dirname}/.env` from app.ts,
// `${__dirname}/../.env` from config/auth.ts, and a bare dotenv.config()
// elsewhere that resolved against the working directory. dotenv does not
// override variables that are already set, so which file won depended on module
// load order rather than on intent.
//
// It must be imported before anything that reads process.env at module scope,
// which in practice means config/auth.ts, the earliest such consumer: ES imports
// hoist, so auth.ts ran before app.ts's own dotenv call and needed its own.
dotenv.config({ path: path.join(__dirname, '../.env') });
