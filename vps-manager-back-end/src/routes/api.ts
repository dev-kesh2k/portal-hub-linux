import { Router } from 'express';
import { authRoutes } from './auth.routes';
import { usersRoutes } from './users.routes';
import { serversRoutes } from './servers.routes';
import { systemRoutes } from './system.routes';
import { catalogAppsRoutes } from './catalog-apps.routes';
import { websitesRoutes } from './websites.routes';
import { hubAppsRoutes } from './hub-apps.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/servers', serversRoutes);
router.use(systemRoutes);
router.use('/apps', catalogAppsRoutes);
router.use('/websites', websitesRoutes);
router.use('/aplicacoes', hubAppsRoutes);

export const apiRouter = router;
