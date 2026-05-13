import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();
const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || './data');
const dbPath = path.join(dataDir, 'deskbot.db');
if (fs.existsSync(dbPath)) {
  const backup = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.renameSync(dbPath, backup);
  console.log(`Moved database to ${backup}`);
} else {
  console.log('No database found.');
}
