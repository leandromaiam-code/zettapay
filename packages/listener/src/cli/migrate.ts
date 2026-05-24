// `zettapay-listener migrate` — copy state between StorageAdapter backends.
// Uses the BulkPortable side-channel (exportAll/importBulk) so re-running is
// idempotent (UPSERT on id) and json↔sqlite is round-trip-safe.

import { c, flagBool, flagString, parseFlags } from './util.js';
import {
  createStorageAdapter,
  isBulkPortable,
  type StorageAdapter,
  type BulkExport,
} from '../storage/index.js';
import type { StorageKind } from '../types.js';

export interface MigrateOptions {
  env?: NodeJS.ProcessEnv;
}

const STORAGE_KINDS: ReadonlyArray<StorageKind> = ['json', 'sqlite', 'supabase', 'postgres'];

function helpText(): string {
  return [
    `${c.bold('zettapay-listener migrate')} — copy state from one adapter to another`,
    '',
    '  --from <kind>           Required. json | sqlite | supabase | postgres',
    '  --to   <kind>           Required. Same set as --from',
    '  --dry-run               Report counts; do not write to --to',
    '  --from-data-dir <path>  Override source data-dir (json/sqlite)',
    '  --to-data-dir   <path>  Override destination data-dir (json/sqlite)',
    '  --from-sqlite-file <p>  Override source sqlite filename',
    '  --to-sqlite-file   <p>  Override destination sqlite filename',
    '',
    'Re-running migrate is a no-op (UPSERT on id). json ↔ sqlite is byte-stable',
    'modulo timestamp re-serialization.',
    '',
  ].join('\n');
}

export async function runMigrate(
  argv: readonly string[],
  opts: MigrateOptions = {},
): Promise<number> {
  const { flags } = parseFlags(argv);
  if (flagBool(flags, 'help')) {
    process.stdout.write(helpText());
    return 0;
  }
  const env = opts.env ?? process.env;
  const from = flagString(flags, 'from') as StorageKind | undefined;
  const to = flagString(flags, 'to') as StorageKind | undefined;
  if (!from || !STORAGE_KINDS.includes(from)) {
    process.stderr.write(
      c.red('error:') + ' --from is required (json|sqlite|supabase|postgres)\n',
    );
    return 2;
  }
  if (!to || !STORAGE_KINDS.includes(to)) {
    process.stderr.write(
      c.red('error:') + ' --to is required (json|sqlite|supabase|postgres)\n',
    );
    return 2;
  }
  if (from === to) {
    process.stderr.write(c.red('error:') + ` --from and --to are both "${from}"\n`);
    return 2;
  }

  const dryRun = flagBool(flags, 'dry-run');

  process.stdout.write(
    c.bold('migrate') +
      ` ${c.cyan(from)} → ${c.cyan(to)}` +
      (dryRun ? c.yellow(' [dry-run]') : '') +
      '\n\n',
  );

  let source: StorageAdapter | undefined;
  let dest: StorageAdapter | undefined;
  try {
    source = await createStorageAdapter({
      kind: from,
      dataDir: flagString(flags, 'from-data-dir') ?? env.ZETTAPAY_DATA_DIR,
      sqliteFilename: flagString(flags, 'from-sqlite-file') ?? env.ZETTAPAY_SQLITE_FILE,
    });
    if (!isBulkPortable(source)) {
      process.stderr.write(
        c.red('error:') +
          ` source adapter "${from}" does not implement BulkPortable (no exportAll)\n`,
      );
      return 2;
    }
    const exported: BulkExport = await source.exportAll();
    process.stdout.write(
      `  ${c.dim('source:')} ${exported.merchant ? 1 : 0} merchant, ` +
        `${exported.invoices.length} invoice(s), ` +
        `${exported.webhookEvents.length} webhook event(s)\n`,
    );

    if (dryRun) {
      process.stdout.write('\n' + c.yellow('dry-run — nothing written') + '\n');
      return 0;
    }

    dest = await createStorageAdapter({
      kind: to,
      dataDir: flagString(flags, 'to-data-dir') ?? env.ZETTAPAY_DATA_DIR,
      sqliteFilename: flagString(flags, 'to-sqlite-file') ?? env.ZETTAPAY_SQLITE_FILE,
    });
    if (!isBulkPortable(dest)) {
      process.stderr.write(
        c.red('error:') +
          ` destination adapter "${to}" does not implement BulkPortable (no importBulk)\n`,
      );
      return 2;
    }

    const result = await dest.importBulk({
      merchant: exported.merchant ?? undefined,
      invoices: exported.invoices,
      webhookEvents: exported.webhookEvents,
    });

    process.stdout.write(
      `  ${c.green('✓')} imported: ${result.merchants} merchant, ` +
        `${result.invoices} invoice(s), ` +
        `${result.webhookEvents} webhook event(s)\n`,
    );
    process.stdout.write('\n' + c.green('migrate complete') + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(c.red('error:') + ` ${(err as Error).message}\n`);
    return 1;
  } finally {
    if (source?.close) await source.close().catch(() => undefined);
    if (dest?.close) await dest.close().catch(() => undefined);
  }
}

export { helpText as migrateHelp };
