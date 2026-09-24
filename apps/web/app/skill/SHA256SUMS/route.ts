import { SKILL_SUMS, SKILL_VERSION } from '../../../lib/server/skillSums';

/**
 * The hashes of the skill Bound distributes, from this deployment: a second channel to check a
 * downloaded copy against (`sha256sum -c`), so a copy altered on its way is found before it signs
 * anything (final audit, item 10).
 */
export function GET() {
  return new Response(SKILL_SUMS, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-bound-skill-version': SKILL_VERSION,
    },
  });
}
