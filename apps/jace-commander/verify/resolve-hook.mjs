/**
 * Resolution recorder for release verification: appends every module URL the
 * process resolves to $JC_VERIFY_RESOLVE_LOG, so the verifier can prove the
 * runtime loads nothing from outside its own release directory.
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';

const log = process.env.JC_VERIFY_RESOLVE_LOG;
if (log) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      fs.appendFileSync(log, `${result.url}\n`);
      return result;
    },
  });
}
