#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const START_MARKER = "<!--START_SECTION:recent_activity-->";
const END_MARKER = "<!--END_SECTION:recent_activity-->";

const DEFAULT_USERNAME = "suxiaogang223";
const DEFAULT_BLOG_REPO = "suxiaogang223/suxiaogang223.github.io";
const DEFAULT_BLOG_SITE_BASE_URL = "https://suxiaogang223.github.io";
const DEFAULT_README_PATH = "README.md";
const MAX_ITEMS = 10;
const COMMIT_TARGET = 6;
const REPO_TARGET = 2;
const BLOG_TARGET = 2;
const COMMIT_MESSAGE_MAX_LEN = 80;
const BLOG_TITLE_MAX_LEN = 80;

function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function safeText(text) {
  return oneLine(text).replace(/[\[\]`]/g, "");
}

function normalizeRepoName(value) {
  const input = oneLine(value);
  if (!input) {
    throw new Error("Blog repository is empty.");
  }

  const urlMatch = input.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+)(?:[/?#].*)?$/i
  );
  if (urlMatch) {
    return `${urlMatch[1]}/${urlMatch[2].replace(/\.git$/i, "")}`;
  }

  const nameMatch = input.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (nameMatch) {
    return `${nameMatch[1]}/${nameMatch[2].replace(/\.git$/i, "")}`;
  }

  throw new Error(
    `Invalid repository format: "${value}". Expected "owner/repo" or a GitHub repository URL.`
  );
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown-date";
  }
  return date.toISOString().slice(0, 10);
}

function parsePostPath(postPath) {
  const match = postPath.match(
    /^_posts\/(\d{4})-(\d{2})-(\d{2})-(.+)\.(md|markdown)$/i
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, slugRaw] = match;
  const date = `${year}-${month}-${day}`;
  const timestamp = Date.parse(`${date}T00:00:00Z`) || 0;
  const slug = slugRaw.trim().replace(/[/\\]+/g, "-");
  let decodedSlug = slug;
  try {
    decodedSlug = decodeURIComponent(slug);
  } catch {
    decodedSlug = slug;
  }
  const title = truncate(
    safeText(decodedSlug.replace(/[-_]+/g, " ")),
    BLOG_TITLE_MAX_LEN
  );

  return {
    date,
    timestamp,
    slug,
    title: title || "Untitled post",
  };
}

function toSiteBaseUrl(value) {
  const trimmed = oneLine(value || DEFAULT_BLOG_SITE_BASE_URL);
  if (!trimmed) {
    return DEFAULT_BLOG_SITE_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

async function githubGet(pathname, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "profile-readme-activity-updater",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com${pathname}`, {
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API request failed (${response.status} ${response.statusText}) for ${pathname}: ${body}`
    );
  }

  return response.json();
}

async function fetchBlogPosts(blogRepoFullName, blogSiteBaseUrl, token) {
  const [owner, repo] = blogRepoFullName.split("/");
  const repoInfo = await githubGet(`/repos/${owner}/${repo}`, token);
  const defaultBranch = repoInfo?.default_branch || "main";
  const tree = await githubGet(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    token
  );

  const items = [];
  for (const entry of tree?.tree ?? []) {
    if (entry?.type !== "blob" || typeof entry?.path !== "string") {
      continue;
    }
    const parsed = parsePostPath(entry.path);
    if (!parsed) {
      continue;
    }

    items.push({
      type: "blog",
      timestamp: parsed.timestamp,
      date: parsed.date,
      title: parsed.title,
      url: `${blogSiteBaseUrl}/${parsed.slug}/`,
      sourceUrl: `https://github.com/${owner}/${repo}/blob/${defaultBranch}/${entry.path}`,
    });
  }

  return items.sort((a, b) => b.timestamp - a.timestamp);
}

function extractCommits(events) {
  const seen = new Set();
  const items = [];

  for (const event of events) {
    if (event?.type !== "PushEvent") {
      continue;
    }

    const repoName = event?.repo?.name;
    const createdAt = event?.created_at;
    const timestamp = Date.parse(createdAt) || 0;
    const commits = event?.payload?.commits ?? [];

    for (const commit of commits) {
      const sha = commit?.sha;
      if (!repoName || !sha) {
        continue;
      }

      const key = `${repoName}:${sha}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const message = truncate(
        safeText(commit?.message || "No commit message"),
        COMMIT_MESSAGE_MAX_LEN
      );

      items.push({
        type: "commit",
        timestamp,
        date: formatDate(createdAt),
        repoName,
        sha,
        shortSha: sha.slice(0, 7),
        message,
        url: `https://github.com/${repoName}/commit/${sha}`,
      });
    }
  }

  items.sort((a, b) => b.timestamp - a.timestamp);
  return items;
}

function extractRepos(repos) {
  return repos
    .filter((repo) => repo && !repo.fork)
    .map((repo) => ({
      type: "repo",
      timestamp: Date.parse(repo.created_at) || 0,
      date: formatDate(repo.created_at),
      repoName: repo.full_name,
      repoDisplayName: repo.name,
      url: repo.html_url,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

function pickActivityItems(allCommits, allRepos, allBlogs) {
  const selectedCommits = allCommits.slice(0, COMMIT_TARGET);
  const selectedRepos = allRepos.slice(0, REPO_TARGET);
  const selectedBlogs = allBlogs.slice(0, BLOG_TARGET);
  const selected = [...selectedCommits, ...selectedRepos, ...selectedBlogs];

  if (selected.length < MAX_ITEMS) {
    const extraCommits = allCommits.slice(COMMIT_TARGET);
    const extraRepos = allRepos.slice(REPO_TARGET);
    const extraBlogs = allBlogs.slice(BLOG_TARGET);
    const fallbackPool = [...extraCommits, ...extraRepos, ...extraBlogs].sort(
      (a, b) => b.timestamp - a.timestamp
    );

    for (const item of fallbackPool) {
      if (selected.length >= MAX_ITEMS) {
        break;
      }
      selected.push(item);
    }
  }

  return selected.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_ITEMS);
}

function renderSection(items) {
  if (!items.length) {
    return "No recent public activity found.";
  }

  return items
    .map((item) => {
      if (item.type === "commit") {
        return `- ✅ Commit: [${item.repoName}@${item.shortSha}](${item.url}) - ${item.message} (${item.date})`;
      }
      if (item.type === "blog") {
        return `- 📝 Blog: [${item.title}](${item.url}) (${item.date})`;
      }
      return `- 🆕 Repo: [${item.repoDisplayName}](${item.url}) (${item.date})`;
    })
    .join("\n");
}

function replaceSection(content, section) {
  const startIndex = content.indexOf(START_MARKER);
  const endIndex = content.indexOf(END_MARKER);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      `Could not find valid section markers: ${START_MARKER} ... ${END_MARKER}`
    );
  }

  const before = content.slice(0, startIndex + START_MARKER.length);
  const after = content.slice(endIndex);
  return `${before}\n${section}\n${after}`;
}

async function main() {
  const username = process.env.GITHUB_USERNAME || DEFAULT_USERNAME;
  const blogRepo = normalizeRepoName(process.env.BLOG_REPO || DEFAULT_BLOG_REPO);
  const blogSiteBaseUrl = toSiteBaseUrl(
    process.env.BLOG_SITE_BASE_URL || DEFAULT_BLOG_SITE_BASE_URL
  );
  const token = process.env.GITHUB_TOKEN;
  const readmePath = process.env.README_PATH || DEFAULT_README_PATH;

  if (!token) {
    throw new Error("Missing GITHUB_TOKEN environment variable.");
  }

  const [events, repos, blogs] = await Promise.all([
    githubGet(`/users/${username}/events/public?per_page=100`, token),
    githubGet(
      `/users/${username}/repos?sort=created&direction=desc&per_page=100`,
      token
    ),
    fetchBlogPosts(blogRepo, blogSiteBaseUrl, token),
  ]);

  const commits = extractCommits(events);
  const createdRepos = extractRepos(repos);
  const selected = pickActivityItems(commits, createdRepos, blogs);
  const sectionText = renderSection(selected);

  const resolvedReadmePath = path.resolve(readmePath);
  const original = fs.readFileSync(resolvedReadmePath, "utf8");
  const updated = replaceSection(original, sectionText);

  if (updated === original) {
    console.log("README is already up to date.");
    return;
  }

  fs.writeFileSync(resolvedReadmePath, updated, "utf8");
  console.log(
    `Updated ${readmePath} with ${selected.length} item(s). commits=${commits.length}, repos=${createdRepos.length}, blogs=${blogs.length}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
