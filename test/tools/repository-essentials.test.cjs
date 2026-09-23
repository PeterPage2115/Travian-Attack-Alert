'use strict';

// Task 25 repository-essentials contract: bounded public-repository metadata
// (MIT license + PeterPage2115/Travian-Attack-Alert), text conventions
// (.editorconfig / .gitattributes), ownership routing (.github/CODEOWNERS;
// routing only, never required code-owner review), and release-note categories
// (.github/release.yml with an explicit catch-all).
//
// Task 27 extension: the issue chooser (.github/ISSUE_TEMPLATE/config.yml)
// must route security reports to GitHub Private Vulnerability Reporting,
// support to a labelled public issue, keep both normal templates, and declare
// an intentional blank-issue policy — with no invented email address or SLA.
//
// Every assertion is offline and deterministic. The permitted release labels
// are pinned to the labels that exist on the public repository (read-only API
// snapshot recorded in the Task 25 evidence root); release.yml may reference no
// other label. Set TAA_REPO_ROOT to run the same contract against a mutated
// fixture copy (the adversarial evidence harness does exactly that).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.TAA_REPO_ROOT
  ? path.resolve(process.env.TAA_REPO_ROOT)
  : path.resolve(__dirname, '..', '..');

const REPOSITORY_SLUG = 'PeterPage2115/Travian-Attack-Alert';
const REPOSITORY_URL = `git+https://github.com/${REPOSITORY_SLUG}.git`;
const BUGS_URL = `https://github.com/${REPOSITORY_SLUG}/issues`;
const HOMEPAGE_URL = `https://github.com/${REPOSITORY_SLUG}#readme`;
const OWNER = '@PeterPage2115';
const CATCH_ALL = '*';
const ISSUE_TEMPLATE_CONFIG = '.github/ISSUE_TEMPLATE/config.yml';
const ISSUE_TEMPLATES = ['.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml'];
// Task 27: the only accepted security path is GitHub Private Vulnerability
// Reporting / Security Advisories on this repository; support is a normal
// labelled public issue. No email address or response-time promise exists.
const SECURITY_REPORT_URL = `https://github.com/${REPOSITORY_SLUG}/security/advisories/new`;
const SUPPORT_URL = `https://github.com/${REPOSITORY_SLUG}/issues/new?labels=question`;

// Snapshot of GET /repos/PeterPage2115/Travian-Attack-Alert/labels (2026-09-23,
// evidence: task-25/labels-api.json). A release category or exclusion may
// reference only these labels, so the config can never invent a label.
const REPOSITORY_LABELS = [
  'accessibility',
  'bug',
  'documentation',
  'duplicate',
  'enhancement',
  'good first issue',
  'help wanted',
  'invalid',
  'question',
  'wontfix',
];

// Formats that are genuinely binary on this repository surface: the OCR model
// archive (tools/ocr-models/eng.traineddata.gz) plus generated evidence
// archives/images/fonts. Marking any other format binary is a misclassification.
const KNOWN_BINARY_EXTENSIONS = [
  'gz', 'zip', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp',
  'woff', 'woff2', 'ttf', 'otf', 'pdf', 'traineddata',
];
// Representative repository text formats; none may be declared binary.
const TEXT_EXTENSIONS = ['md', 'js', 'cjs', 'mjs', 'json', 'ts', 'yml', 'yaml', 'html', 'css', 'txt'];
const POLICY_FILES = ['.editorconfig', '.gitattributes', '.github/CODEOWNERS', '.github/release.yml', ISSUE_TEMPLATE_CONFIG];

function filePath(relative) {
  return path.join(ROOT, relative);
}

function read(relative) {
  return fs.readFileSync(filePath(relative), 'utf8');
}

function readJson(relative) {
  return JSON.parse(read(relative));
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.error, undefined, `git ${args.join(' ')} could not run: ${result.error?.message}`);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function parseEditorConfig(source) {
  const preamble = new Map();
  const sections = new Map();
  let current = preamble;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = new Map();
      sections.set(header[1], current);
      continue;
    }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    assert.ok(pair, `invalid EditorConfig line: ${raw}`);
    current.set(pair[1].trim().toLowerCase(), pair[2].trim().toLowerCase());
  }
  return { preamble, sections };
}

function parseGitAttributes(source) {
  const rules = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/u);
    assert.ok(parts.length >= 2, `invalid .gitattributes rule: ${raw}`);
    rules.push({ pattern: parts[0], attributes: parts.slice(1) });
  }
  return rules;
}

function parseCodeowners(source) {
  const rules = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...owners] = line.split(/\s+/u);
    rules.push({ pattern, owners });
  }
  return rules;
}

/** Strip the optional YAML quoting around a scalar list item or title. */
function unquote(value) {
  const match = /^"([^"]*)"$|^'([^']*)'$/u.exec(value);
  return match ? (match[1] ?? match[2]) : value;
}

function parseReleaseConfig(source) {
  const topLevelKeys = [];
  const excludeLabels = [];
  const excludeAuthors = [];
  const categories = [];
  let section = null;
  let list = null;
  let category = null;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      assert.match(line, /^[a-z][a-z-]*:$/u, `unexpected release.yml top-level line: ${raw}`);
      topLevelKeys.push(line.slice(0, -1));
      section = null;
      list = null;
      category = null;
      continue;
    }
    if (indent === 2) {
      if (line === 'exclude:') { section = 'exclude'; list = null; category = null; continue; }
      if (line === 'categories:') { section = 'categories'; list = null; category = null; continue; }
      assert.fail(`unexpected release.yml key: ${raw}`);
    }
    if (section === 'exclude') {
      if (line === 'labels:') { list = excludeLabels; continue; }
      if (line === 'authors:') { list = excludeAuthors; continue; }
      const item = /^-\s+(.+)$/u.exec(line);
      assert.ok(item && list, `unexpected release.yml exclude entry: ${raw}`);
      list.push(unquote(item[1].trim()));
      continue;
    }
    assert.equal(section, 'categories', `release.yml entry outside a section: ${raw}`);
    if (indent === 4) {
      const title = /^-\s+title:\s*(.+)$/u.exec(line);
      assert.ok(title, `unexpected release.yml category: ${raw}`);
      category = { title: unquote(title[1].trim()), labels: [] };
      categories.push(category);
      list = null;
      continue;
    }
    if (indent === 6) {
      assert.equal(line, 'labels:', `unexpected release.yml category key: ${raw}`);
      assert.ok(category, `release.yml label list without a category: ${raw}`);
      list = category.labels;
      continue;
    }
    if (indent === 8) {
      const item = /^-\s+(.+)$/u.exec(line);
      assert.ok(item && category && list === category.labels, `unexpected release.yml label: ${raw}`);
      category.labels.push(unquote(item[1].trim()));
      continue;
    }
    assert.fail(`unexpected release.yml indentation: ${raw}`);
  }
  return { topLevelKeys, excludeLabels, excludeAuthors, categories };
}

/**
 * Parse the small, fixed-shape issue chooser config. Fails closed on any line
 * or key it does not understand, so a malformed or drifted config cannot pass.
 */
function parseIssueTemplateConfig(source) {
  const config = { blankIssuesEnabled: null, contactLinks: [] };
  let current = null;
  let inContactLinks = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      const pair = /^([a-z][a-z_]*):(?:\s*(.*))?$/u.exec(line);
      assert.ok(pair, `unexpected issue-template config line: ${raw}`);
      const key = pair[1];
      const value = (pair[2] ?? '').trim();
      if (key === 'blank_issues_enabled') {
        assert.match(value, /^(?:true|false)$/u, `blank_issues_enabled must be an explicit boolean, got: ${value}`);
        config.blankIssuesEnabled = value === 'true';
        inContactLinks = false;
        current = null;
        continue;
      }
      assert.equal(key, 'contact_links', `unexpected issue-template config key: ${key}`);
      assert.equal(value, '', `contact_links must be a block list: ${raw}`);
      inContactLinks = true;
      current = null;
      continue;
    }
    assert.ok(inContactLinks, `issue-template config entry outside contact_links: ${raw}`);
    const item = /^-\s+([a-z]+):\s*(.+)$/u.exec(line);
    if (item) {
      current = { [item[1]]: unquote(item[2].trim()) };
      config.contactLinks.push(current);
      continue;
    }
    const field = /^([a-z]+):\s*(.+)$/u.exec(line);
    assert.ok(field && current, `unexpected issue-template config entry: ${raw}`);
    assert.equal(Object.hasOwn(current, field[1]), false, `duplicate issue-template config key: ${field[1]}`);
    current[field[1]] = unquote(field[2].trim());
  }
  return config;
}

/** First matching category wins; exclusion labels remove the PR entirely. */
function releaseVerdict(config, labels) {
  if (labels.some((label) => config.excludeLabels.includes(label))) return 'excluded';
  for (const category of config.categories) {
    if (category.labels.includes(CATCH_ALL) || category.labels.some((label) => labels.includes(label))) return category.title;
  }
  return 'uncategorized';
}

test('package.json declares the exact MIT public repository identity', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.repository, { type: 'git', url: REPOSITORY_URL });
  assert.deepEqual(pkg.bugs, { url: BUGS_URL });
  assert.equal(pkg.homepage, HOMEPAGE_URL);
  assert.equal(pkg.name, 'travian-attack-alert', 'package identity must not change');
  assert.match(read('LICENSE'), /^MIT License\s*$/mu, 'LICENSE must remain the MIT text');
});

test('the npm package stays private and cannot be published', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.private, true);
  assert.equal(Object.hasOwn(pkg, 'publishConfig'), false);
  for (const [name, script] of Object.entries(pkg.scripts || {})) {
    assert.ok(!/npm\s+publish|npm\s+pack/u.test(script), `script ${name} must not publish or pack the package`);
  }
});

test('.editorconfig pins UTF-8, LF, final-newline and two-space defaults', () => {
  const { preamble, sections } = parseEditorConfig(read('.editorconfig'));
  assert.equal(preamble.get('root'), 'true');
  const all = sections.get('*');
  assert.ok(all, '.editorconfig must declare a [*] section');
  assert.equal(all.get('charset'), 'utf-8');
  assert.equal(all.get('end_of_line'), 'lf');
  assert.equal(all.get('insert_final_newline'), 'true');
  assert.equal(all.get('indent_style'), 'space');
  assert.equal(all.get('indent_size'), '2');
});

test('.gitattributes normalizes repository text to LF', () => {
  const rules = parseGitAttributes(read('.gitattributes'));
  const wildcard = rules.filter((rule) => rule.pattern === '*');
  assert.equal(wildcard.length, 1, 'exactly one * rule expected');
  assert.ok(wildcard[0].attributes.includes('text=auto'), '* must enable text=auto');
  assert.ok(wildcard[0].attributes.includes('eol=lf'), '* must normalize eol to lf');
});

test('.gitattributes marks only known binary formats binary', () => {
  const rules = parseGitAttributes(read('.gitattributes'));
  const binaryRules = rules.filter((rule) => rule.attributes.includes('binary') || rule.attributes.includes('-text'));
  assert.ok(binaryRules.length > 0, 'known binary formats must be declared');
  for (const rule of binaryRules) {
    const extension = /^\*\.([A-Za-z0-9.]+)$/u.exec(rule.pattern);
    assert.ok(extension, `binary rule ${rule.pattern} must be a narrow *.ext pattern`);
    assert.ok(KNOWN_BINARY_EXTENSIONS.includes(extension[1].toLowerCase()), `unexpected binary extension: ${rule.pattern}`);
  }
  const binaryPatterns = new Set(binaryRules.map((rule) => rule.pattern.toLowerCase()));
  for (const required of ['*.gz', '*.zip']) assert.ok(binaryPatterns.has(required), `${required} must be binary`);
  for (const extension of TEXT_EXTENSIONS) {
    assert.ok(!binaryPatterns.has(`*.${extension}`), `text format *.${extension} must not be binary`);
  }
});

test('git resolves the text/binary policy on real repository paths', () => {
  const binary = git(['check-attr', 'text', 'eol', 'diff', '--', 'tools/ocr-models/eng.traineddata.gz']);
  assert.match(binary, /text: unset/u, 'the OCR model archive must not be text');
  assert.match(binary, /diff: unset/u, 'the OCR model archive must not be diffed as text');
  for (const relative of ['README.md', 'package.json', 'src/runtime.js', '.github/CODEOWNERS']) {
    const attrs = git(['check-attr', 'text', 'eol', '--', relative]);
    assert.match(attrs, /text: auto/u, `${relative} must be auto-detected as text`);
    assert.match(attrs, /eol: lf/u, `${relative} must check out with LF`);
  }
});

test('policy files are UTF-8 text with LF endings and a final newline', () => {
  for (const relative of POLICY_FILES) {
    const bytes = fs.readFileSync(filePath(relative));
    assert.ok(bytes.length > 0, `${relative} must not be empty`);
    assert.equal(bytes.includes(0x0d), false, `${relative} must use LF line endings`);
    assert.equal(bytes[bytes.length - 1], 0x0a, `${relative} must end with a newline`);
    assert.equal(Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes), true, `${relative} must be valid UTF-8`);
  }
});

test('CODEOWNERS routes every path to the single repository owner', () => {
  const rules = parseCodeowners(read('.github/CODEOWNERS'));
  assert.ok(rules.length > 0, 'CODEOWNERS must not be empty');
  assert.ok(rules.some((rule) => rule.pattern === '*'), 'CODEOWNERS must carry a default * rule');
  for (const rule of rules) {
    assert.ok(rule.owners.length > 0, `rule ${rule.pattern} needs an owner`);
    for (const owner of rule.owners) {
      assert.equal(owner, OWNER, `only ${OWNER} may own paths`);
      assert.ok(!owner.includes('/'), 'team owners would require an organization that does not exist');
    }
  }
});

test('CODEOWNERS patterns resolve to existing repository paths', () => {
  const rules = parseCodeowners(read('.github/CODEOWNERS'));
  for (const rule of rules) {
    if (rule.pattern === '*') continue;
    const spec = rule.pattern.replace(/^\//u, '');
    const listed = spawnSync('git', ['ls-files', '-z', '--', spec], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(listed.status, 0, `git ls-files failed for ${rule.pattern}: ${listed.stderr}`);
    assert.ok(listed.stdout.length > 0, `CODEOWNERS pattern resolves to no path: ${rule.pattern}`);
  }
});

test('CODEOWNERS is routing only and enables no required code-owner review', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  walk(filePath('.github'));
  const offenders = files.filter((file) => /require_code_owner_reviews|require-code-owner-review/iu.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders.map((file) => path.relative(ROOT, file)), []);
});

test('release.yml declares ordered categories with an explicit catch-all last', () => {
  const config = parseReleaseConfig(read('.github/release.yml'));
  assert.deepEqual(config.topLevelKeys, ['changelog']);
  assert.ok(config.categories.length >= 2, 'at least one named category plus the catch-all');
  const last = config.categories[config.categories.length - 1];
  assert.deepEqual(last.labels, [CATCH_ALL], 'the final category must be the explicit * catch-all');
  assert.ok(last.title.length > 0, 'the catch-all needs a title');
  for (const category of config.categories.slice(0, -1)) {
    assert.ok(category.title.length > 0, 'every category needs a title');
    assert.ok(category.labels.length > 0, `category ${category.title} needs labels`);
    assert.ok(!category.labels.includes(CATCH_ALL), 'only the final category may be a catch-all');
  }
  const titles = config.categories.map((category) => category.title);
  assert.equal(new Set(titles).size, titles.length, 'category titles must be unique');
});

test('release.yml references only labels that exist in the repository', () => {
  const config = parseReleaseConfig(read('.github/release.yml'));
  const referenced = [
    ...config.excludeLabels,
    ...config.categories.flatMap((category) => category.labels),
  ].filter((label) => label !== CATCH_ALL);
  assert.ok(referenced.length > 0, 'the config must reference real labels');
  for (const label of referenced) {
    assert.ok(REPOSITORY_LABELS.includes(label), `label does not exist in the repository: ${label}`);
  }
});

test('release.yml excludes bot traffic and non-user-facing labels', () => {
  const config = parseReleaseConfig(read('.github/release.yml'));
  assert.ok(config.excludeLabels.length > 0, 'exclusions must not be empty');
  assert.ok(config.excludeAuthors.some((author) => author.endsWith('[bot]')), 'bot authors must be excluded');
  for (const label of config.excludeLabels) {
    assert.ok(REPOSITORY_LABELS.includes(label), `exclusion label does not exist: ${label}`);
  }
  for (const author of config.excludeAuthors) {
    assert.match(author, /\[bot\]$/u, `unexpected excluded author: ${author}`);
  }
});

test('release.yml can only shape generated notes, never publish a release', () => {
  const config = parseReleaseConfig(read('.github/release.yml'));
  assert.deepEqual(config.topLevelKeys, ['changelog'], 'changelog is the only supported top-level key');
  const source = read('.github/release.yml');
  for (const forbidden of ['on:', 'runs-on:', 'jobs:', 'permissions:', 'publish']) {
    assert.ok(!new RegExp(`^\\s*${forbidden}`, 'mu').test(source), `release.yml must not contain a ${forbidden} entry`);
  }
});

test('every synthetic pull-request label set is excluded or categorized', () => {
  const config = parseReleaseConfig(read('.github/release.yml'));
  const samples = [
    [],
    ['bug'],
    ['enhancement'],
    ['documentation'],
    ['accessibility', 'bug'],
    ['question'],
    ['not-a-repository-label'],
    ['wontfix'],
    ['duplicate', 'enhancement'],
  ];
  for (const labels of samples) {
    assert.notEqual(
      releaseVerdict(config, labels),
      'uncategorized',
      `labels [${labels.join(', ')}] would be omitted from release notes`,
    );
  }
  assert.equal(releaseVerdict(config, ['invalid']), 'excluded', 'exclusion labels are deliberate omissions');
});

test('issue chooser declares an intentional blank-issue policy and preserves both templates', () => {
  const config = parseIssueTemplateConfig(read(ISSUE_TEMPLATE_CONFIG));
  assert.equal(
    config.blankIssuesEnabled,
    true,
    'blank issues stay deliberately enabled for reports that fit neither template; the policy must be explicit',
  );
  for (const relative of ISSUE_TEMPLATES) {
    const source = read(relative);
    assert.match(source, /^name:\s*\S+/mu, `${relative} must keep a display name`);
    assert.match(source, /^body:$/mu, `${relative} must keep its form body`);
  }
});

test('issue chooser routes security privately and support to a labelled issue, never email', () => {
  const config = parseIssueTemplateConfig(read(ISSUE_TEMPLATE_CONFIG));
  assert.equal(config.contactLinks.length, 2, 'exactly two contact links: private security and support');
  for (const link of config.contactLinks) {
    assert.ok(link.name && link.name.length <= 40, `contact link needs a name (<=40 chars): ${JSON.stringify(link)}`);
    assert.ok(link.about && link.about.length <= 200, `contact link needs an about (<=200 chars): ${link.name}`);
    assert.ok(link.url.startsWith(`https://github.com/${REPOSITORY_SLUG}/`), `contact link must stay on this repository: ${link.url}`);
    assert.ok(!/mailto:/iu.test(link.url), `contact link must never be an email: ${link.url}`);
  }
  const security = config.contactLinks.find((link) => link.url === SECURITY_REPORT_URL);
  assert.ok(security, `security contact link must be ${SECURITY_REPORT_URL}`);
  assert.match(security.about, /private/iu, 'the security link must say the report is private');
  assert.match(
    security.about,
    /never\s+(?:post|paste|include)/iu,
    'the security link must warn against posting secrets or player data in public',
  );
  const support = config.contactLinks.find((link) => link.url === SUPPORT_URL);
  assert.ok(support, `support contact link must be ${SUPPORT_URL}`);
});

test('security policy documents the private path, the release-candidate support state, and no invented contact or SLA', () => {
  const security = read('SECURITY.md');
  assert.ok(security.includes(SECURITY_REPORT_URL), 'SECURITY.md must link GitHub Private Vulnerability Reporting');
  assert.match(security, /security advisories/iu, 'SECURITY.md must name Security Advisories');
  assert.match(security, /\|\s*Version\s*\|/u, 'SECURITY.md must carry a supported-versions table');
  assert.match(security, /stable:\s*false/u, 'the supported-versions table must match the machine state stable:false');
  assert.match(security, /release candidate/iu, 'supported versions must not claim stable support prematurely');
  assert.match(
    security,
    /never\s+(?:open|post|file)[^.]{0,80}public\s+issue/iu,
    'SECURITY.md must explicitly prohibit public-issue disclosure of a vulnerability',
  );
  assert.match(
    security,
    /no\s+(?:dedicated\s+security\s+contact\s+email|response-time)/iu,
    'SECURITY.md must state that no contact email or response-time promise exists',
  );
  for (const source of [read(ISSUE_TEMPLATE_CONFIG), security]) {
    assert.ok(!/mailto:/iu.test(source), 'no mailto link may be invented');
    assert.ok(
      !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u.test(source),
      'no email address may be invented',
    );
    assert.ok(
      !/(?:within|in)\s+\d+\s*(?:hours?|days?|business\s+days?)/iu.test(source),
      'no response-time SLA may be invented',
    );
  }
});
