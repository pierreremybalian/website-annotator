import type { Env } from './env';
import type { TrelloMember } from './trello';

interface Owner {
  memberId: string;
  orgIds: string[];
}

/**
 * Who may connect boards to this Worker.
 * - ALLOWED_TRELLO_ORG set: members of that workspace only.
 * - Otherwise the first member to log in becomes the owner, and from then on only the owner and
 *   members sharing one of the owner's workspaces may connect.
 */
export async function mayConnect(env: Env, member: TrelloMember): Promise<boolean> {
  const orgs = member.idOrganizations ?? [];
  const explicit = (env.ALLOWED_TRELLO_ORG ?? '').trim();
  if (explicit) return orgs.includes(explicit);

  const claim: Owner = { memberId: member.id, orgIds: orgs };
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('owner', ?)").bind(JSON.stringify(claim)).run();
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'owner'").first<{ value: string }>();
  const owner: Owner = row ? JSON.parse(row.value) : claim;
  return owner.memberId === member.id || orgs.some((o) => owner.orgIds.includes(o));
}
