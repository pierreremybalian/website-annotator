import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// 0005 rebuilds projects, issues and agent_tokens. D1 keeps foreign keys on, so a careless rebuild would
// cascade-delete every issue and token. Apply 0001-0004, seed, apply the rest, and check nothing was lost.

const db = () => env.MIGRATION_DB;
const before = env.TEST_MIGRATIONS.filter((m) => m.name < '0005');
const at = '2026-10-01T00:00:00.000Z';

async function seed() {
  await db().batch([
    db().prepare(
      `INSERT INTO projects (id, name, public_key, access_key, allowed_origins, trello_token_enc, trello_member_id, trello_board_id,
         trello_board_name, trello_board_url, new_list_id, done_list_ids, webhook_id, token_revoked, next_number, ignore_query,
         review_list_id, progress_list_id, created_at, updated_at)
       VALUES ('p1', 'Strauss', 'pk_1', 'ak_1', '["https://s.test"]', 'enc', 'mem', 'board-1', 'QA', 'https://trello.com/b/1',
         'list-1', '["list-3"]', 'wh-1', 0, 3, 1, 'list-r', 'list-2', ?, ?)`,
    ).bind(at, at),
    ...[1, 2].map((n) =>
      db()
        .prepare(
          `INSERT INTO issues (id, project_id, number, trello_card_id, trello_short_url, page_url, page_url_raw, title, notes, anchor, env,
             reporter_name, reporter_email, screenshot_key, context_key, status, context, claimed_by, claimed_until, resolution, created_at, updated_at)
           VALUES (?, 'p1', ?, ?, ?, 'https://s.test/', 'https://s.test/?a=1', ?, 'notes', '{}', '{}', 'Ann', 'ann@x.test', 'k1', 'k2',
             ?, '{"v":1}', ?, ?, ?, ?, ?)`,
        )
        .bind(`i${n}`, n, `card-${n}`, `https://trello.com/c/${n}`, `Issue ${n}`, n === 1 ? 'in_progress' : 'resolved',
          n === 1 ? 'bot@vps' : null, n === 1 ? 123 : null, n === 2 ? 'Fixed' : null, at, at),
    ),
    db().prepare(`INSERT INTO agent_tokens (id, project_id, token_hash, label, created_at, last_used_at) VALUES ('t1', 'p1', 'hash', 'vps', ?, ?)`).bind(at, at),
  ]);
}

const all = async (sql: string) => (await db().prepare(sql).all<Record<string, unknown>>()).results;

describe('migration 0005 (D1 as source of truth)', () => {
  it('rebuilds the tables without losing rows, and makes the Trello columns optional', async () => {
    await applyD1Migrations(db(), before);
    await seed();
    const snapshot = { projects: await all('SELECT * FROM projects'), issues: await all('SELECT * FROM issues ORDER BY id'), tokens: await all('SELECT * FROM agent_tokens') };

    await applyD1Migrations(db(), env.TEST_MIGRATIONS);

    // Every old column keeps its value; the new ones start empty.
    const projects = await all('SELECT * FROM projects');
    expect(projects).toHaveLength(1);
    expect(projects[0]).toEqual({ ...snapshot.projects[0], trello_error: null, trello_reconciled_at: null });
    const issues = await all('SELECT * FROM issues ORDER BY id');
    expect(issues).toEqual(
      snapshot.issues.map((r) => ({ ...r, status_at: null, trello_list_id: null, trello_pending: 0, comments_imported_at: null })),
    );
    expect(await all('SELECT * FROM agent_tokens')).toEqual(snapshot.tokens.map((r) => ({ ...r, created_by: null, revoked_at: null })));

    // A project and issue with no Trello board at all.
    await db().batch([
      db().prepare(`INSERT INTO projects (id, name, public_key, access_key, created_at, updated_at) VALUES ('p2', 'Native', 'pk_2', 'ak_2', ?, ?)`).bind(at, at),
      ...[1, 2].map((n) =>
        db()
          .prepare(
            `INSERT INTO issues (id, project_id, number, page_url, page_url_raw, title, notes, anchor, env, reporter_name, reporter_email,
               screenshot_key, context_key, created_at, updated_at) VALUES (?, 'p2', ?, 'u', 'u', 't', 'n', '{}', '{}', 'r', 'e', 'k', 'k', ?, ?)`,
          )
          .bind(`n${n}`, n, at, at),
      ),
      db().prepare(`INSERT INTO comments (id, issue_id, via, author_name, text, created_at, updated_at) VALUES ('c1', 'n1', 'app', 'Pierre', 'hi', ?, ?)`).bind(at, at),
    ]);
    expect(await all(`SELECT status, trello_card_id FROM issues WHERE project_id = 'p2'`)).toEqual([
      { status: 'new', trello_card_id: null },
      { status: 'new', trello_card_id: null },
    ]);

    // Cascades still hold: deleting a project removes its issues, their comments and its tokens.
    await db().prepare(`DELETE FROM projects WHERE id = 'p2'`).run();
    expect(await all(`SELECT id FROM issues WHERE project_id = 'p2'`)).toEqual([]);
    expect(await all(`SELECT id FROM comments`)).toEqual([]);
    await db().prepare(`DELETE FROM projects WHERE id = 'p1'`).run();
    expect(await all('SELECT id FROM issues')).toEqual([]);
    expect(await all('SELECT id FROM agent_tokens')).toEqual([]);

    const indexes = (await all(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`)).map((r) => r.name);
    expect(indexes).toEqual([
      'agent_tokens_project',
      'comments_issue',
      'issues_board',
      'issues_card',
      'issues_comments_todo',
      'issues_number',
      'issues_page',
      'issues_trello_pending',
      'projects_board',
    ]);
    expect(await all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('_projects', '_issues', '_agent_tokens')`)).toEqual([]);
  });
});
