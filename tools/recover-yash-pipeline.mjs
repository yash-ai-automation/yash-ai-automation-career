#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const stashSha = 'e2540a729f67712b83c99938f77c751c973acc3c';
const stashContent = execSync(`git show ${stashSha}:data/yash-pipeline.md`).toString();
const runsLog = readFileSync('data/yash-resume-runs.log', 'utf8').trim().split('\n').map(JSON.parse);

const runsByUrl = new Map();
for (const r of runsLog) {
  if (r.status !== 'ok') continue;
  const decoded = decodeURIComponent(r.url);
  runsByUrl.set(r.url, r);
  runsByUrl.set(decoded, r);
}

const tableRow = /^\|\s*\d+\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|\s*([✅❌])\s*\|\s*([✅❌])\s*\|\s*([0-9—\/]+)\s*\|\s*([✅❌])\s*\|\s*(\w+)\s*\|/;
const lines = stashContent.split('\n');
const listEntries = [];
const skipped = [];

for (const ln of lines) {
  const m = ln.match(tableRow);
  if (!m) continue;
  const [, date, company, url, role, jdMark, resMark, score, clMark, status] = m;
  const run = runsByUrl.get(url) || runsByUrl.get(decodeURIComponent(url));
  // Trust runs log over table: if URL has status=ok in runs log, include it even if table says "Skipped"
  if (!run && (status === 'Skipped' || jdMark === '❌' || resMark === '❌')) {
    skipped.push({ url, company, role, date, reason: status });
    continue;
  }
  // Reconcile contradictions: runs-log score wins
  const reconciledScore = run?.score ? `${run.score}/100` : score;
  const reconciledClMark = run?.cover_letter_pdf ? '✅' : clMark;
  let coverLetterPath = run?.cover_letter_pdf;
  if (!coverLetterPath && clMark === '✅') {
    // Reconstruct path: cover-letters/yash/<Slug>_..._Yash_Anghan_Cover_Letter_<date>.pdf
    // For pre-yash-subdir entries (May 08-12), the path was cover-letters/<Slug>_..._Yash_Anghan_Cover_Letter_<date>.pdf
    const slug = company.replace(/[^A-Za-z0-9]/g, '');
    const roleSlug = role.replace(/[^A-Za-z0-9]/g, '');
    coverLetterPath = `cover-letters/${slug}_${roleSlug}_Yash_Anghan_Cover_Letter_${date}.pdf`;
  }
  const scoreClean = reconciledScore.split('/')[0].replace(/[^\d]/g, '');
  let line = `- [x] ${url} | ${company} | ${role} | JD ✅ | Resume ✅ | Score ${scoreClean}/100`;
  if (reconciledClMark === '✅' && coverLetterPath) line += ` | CL ✅ | ${coverLetterPath}`;
  else if (reconciledClMark === '❌') line += ` | CL ❌`;
  listEntries.push(line);
}

// Append today's 5 runs from runs log (anything on 2026-05-25 not already in listEntries)
const todayRuns = runsLog.filter((r) => r.status === 'ok' && r.timestamp.startsWith('2026-05-25'));
const todayLines = todayRuns.map((r) => {
  const slug = r.slug || '';
  const [companyPart, ...roleParts] = slug.split('_');
  const company = companyPart;
  const role = roleParts.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  const clPath = r.cover_letter_pdf;
  let line = `- [x] ${r.url} | ${company} | ${role} | JD ✅ | Resume ✅ | Score ${r.score}/100`;
  if (clPath) line += ` | CL ✅ | ${clPath}`;
  return line;
});

const final = [
  '# Job Pipeline',
  '',
  '## Pendientes',
  '',
  '## Procesadas',
  ...listEntries,
  ...todayLines,
  '',
].join('\n');

writeFileSync('data/yash-pipeline.md', final);
console.log(`Wrote data/yash-pipeline.md: ${listEntries.length + todayLines.length} Procesadas, 0 Pendientes`);
console.log(`Skipped table rows: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.company} / ${s.role} (${s.reason})`);
