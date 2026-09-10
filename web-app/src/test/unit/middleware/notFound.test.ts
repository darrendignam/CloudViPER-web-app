import request from 'supertest';
import express from 'express';

describe('404 handling', () => {
    // The handler previously sent the 404 body with no status, so every missing
    // route answered 200 and read as a success to monitoring and any client
    // checking status codes.
    function buildApp() {
        const app = express();
        app.get('/known', (_req, res) => { res.json({ ok: true }); });
        app.use(function (req, res) {
            res.status(404).json({ error: { code: 404, status: 'not found' } });
        });
        return app;
    }

    it('should answer an unknown route with status 404, not 200', async () => {
        const response = await request(buildApp()).get('/no-such-route');

        expect(response.status).toBe(404);
    });

    it('should still describe the error in the body', async () => {
        const response = await request(buildApp()).get('/no-such-route');

        expect(response.body).toEqual({ error: { code: 404, status: 'not found' } });
    });

    it('should leave a known route untouched', async () => {
        const response = await request(buildApp()).get('/known');

        expect(response.status).toBe(200);
    });
});
