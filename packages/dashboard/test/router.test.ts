import { describe, expect, it } from 'vitest';
import { href, parse } from '../src/router';

describe('router', () => {
  it('maps dashboard paths to pages', () => {
    expect(parse('/app/')).toEqual({ page: 'home' });
    expect(parse('/app')).toEqual({ page: 'home' });
    expect(parse('/app/o/org_balian')).toEqual({ page: 'projects', org: 'org_balian' });
    expect(parse('/app/o/org_balian/team')).toEqual({ page: 'team', org: 'org_balian' });
    expect(parse('/app/p/abc', '?issue=xyz')).toEqual({ page: 'board', project: 'abc', issue: 'xyz' });
    expect(parse('/app/p/abc')).toEqual({ page: 'board', project: 'abc', issue: null });
    expect(parse('/app/p/abc/settings')).toEqual({ page: 'settings', project: 'abc' });
    expect(parse('/app/p/abc/nope')).toEqual({ page: 'notFound' });
    expect(parse('/app/whatever')).toEqual({ page: 'notFound' });
  });

  it('builds links that parse back', () => {
    expect(parse(href.board('a b', 'i/1').split('?')[0]!, `?${href.board('a b', 'i/1').split('?')[1]}`)).toEqual({ page: 'board', project: 'a b', issue: 'i/1' });
    expect(parse(href.team('o-1'))).toEqual({ page: 'team', org: 'o-1' });
    expect(parse(href.settings('p-1'))).toEqual({ page: 'settings', project: 'p-1' });
  });
});
