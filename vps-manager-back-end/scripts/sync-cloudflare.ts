import '../src/load-env';
import { initDatabase } from '../src/db/init';
import { applicationsService } from '../src/services/applications.service';
import { appsService } from '../src/services/apps.service';
import { cloudflareService } from '../src/services/cloudflare.service';

async function main(): Promise<void> {
  await initDatabase();
  await applicationsService.reload();
  const installed = await appsService.listInstalled();
  await appsService.repairInstalledRoutes(installed);
  const slugs = applicationsService.list().map((app) => app.slug);
  const catalogPaths = appsService.getInstalledTunnelPaths(installed);
  const result = await cloudflareService.publishRoutes(slugs, catalogPaths);
  console.log('ok', result.ok);
  console.log(result.message);
  console.log('slugs', slugs.join(', ') || '(nenhum)');
  console.log('catalog', catalogPaths.join(', ') || '(nenhum)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
