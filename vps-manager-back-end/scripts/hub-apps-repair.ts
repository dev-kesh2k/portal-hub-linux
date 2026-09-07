import '../src/load-env';
import { initDatabase } from '../src/db/init';
import { applicationsService } from '../src/services/applications.service';

async function main(): Promise<void> {
  const mode = process.argv[2] || 'merge';
  await initDatabase();
  await applicationsService.reload();
  if (mode === 'merge') {
    await applicationsService.mergeSplitApps();
  } else if (mode === 'repair') {
    await applicationsService.repairRoutes();
  } else if (mode === 'all') {
    await applicationsService.mergeSplitApps();
    await applicationsService.repairRoutes();
  }
  console.log(`hub_apps_${mode}_ok`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
