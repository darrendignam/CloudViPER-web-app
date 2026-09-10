import express, { Request, Response } from 'express';


const router = express.Router();

/* GET home page. */
router.get('/', (req: Request, res: Response) => {
  res.redirect("/account/login");
});

router.get('/privacy-policy', (req: Request, res: Response) => {
  res.send("Privacy Policy Coming Soon");
});

router.get('/terms', (req: Request, res: Response) => {
  res.send("Terms and Conditions Coming Soon");
});

export default router;