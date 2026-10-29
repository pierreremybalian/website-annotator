import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import SKILL_MD from '../../../skills/annotate-qa/SKILL.md?raw';
import { findGitRoot } from './config';

export const SKILL = SKILL_MD;
export const SKILL_REL_PATH = path.join('.claude', 'skills', 'annotate-qa', 'SKILL.md');

export function skillTarget(opts: { global: boolean; cwd: string; homedir: string }): string {
  const base = opts.global ? opts.homedir : (findGitRoot(opts.cwd) ?? opts.cwd);
  return path.join(base, SKILL_REL_PATH);
}

export function installSkill(target: string): 'created' | 'updated' | 'unchanged' {
  const existed = existsSync(target);
  if (existed && readFileSync(target, 'utf8') === SKILL) return 'unchanged';
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, SKILL);
  return existed ? 'updated' : 'created';
}
